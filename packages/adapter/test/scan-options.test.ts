/**
 * The verified scan options (redact-secret-adapters#175) against fake
 * scanners and a fake core: validation, snapshot, what reaches the scanner,
 * the version gate and the fixed, input-free errors. The real-core replay is
 * `scan-options-live.test.ts`.
 */

import type { ScanAndRedactOptions } from "@redact-secret/core";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { keyAwareScanner } from "../../../fixtures/key-aware-scanner.js";
import {
  CoreOptionsError,
  coreVersionAtLeast,
  maskLeafOutcomeWith,
  maskSecretsWith,
  resolveScanConfig,
  SCAN_OPTION_CORE_FLOORS,
  type ScanAndRedact,
  verifyScanOptions,
  withResolvedScanConfig,
} from "../src/index.js";

function recording() {
  const calls: { text: string; options: ScanAndRedactOptions | undefined }[] = [];
  const scan: ScanAndRedact = (text, options) => {
    calls.push({ text, options });
    return fakeScanAndRedact(text);
  };
  return { scan, calls };
}

const LIMITS = { maxInputBytes: 64, maxFindings: 3 };
const FORMATTER = () => "[x]";

test("with none of the three options the scanner gets exactly { policy }, as it always has", () => {
  const { scan, calls } = recording();
  maskLeafOutcomeWith(scan, "plain");
  expect(calls[0]?.options).toEqual({ policy: undefined });
  expect(Object.keys(calls[0]?.options ?? {})).toEqual(["policy"]);
  const policy = { evaluate: () => "redact" as const };
  maskLeafOutcomeWith(scan, "plain", { policy });
  expect(calls[1]?.options?.policy).toBe(policy);
  expect(resolveScanConfig().requested).toEqual([]);
});

test("every requested option reaches every scan of every leaf, key-context views included", () => {
  const { scan, calls } = recording();
  const ruleset = "ruleset-revision: 1\n";
  maskSecretsWith(
    scan,
    { api_key: "value", list: ["a"] },
    { scanLimits: LIMITS, ruleset, placeholderFormatter: FORMATTER },
  );
  expect(calls.map((call) => call.text)).toEqual(["value", '{"api_key":"value"}', "a"]);
  for (const call of calls) {
    expect(call.options).toEqual({ policy: undefined, limits: LIMITS, ruleset, placeholderFormatter: FORMATTER });
  }
});

test("the option names are scanLimits / ruleset / placeholderFormatter, and requested lists them in a fixed order", () => {
  const config = resolveScanConfig({ placeholderFormatter: FORMATTER, ruleset: "r", scanLimits: LIMITS });
  expect(config.requested).toEqual(["scanLimits", "ruleset", "placeholderFormatter"]);
  expect(Object.isFrozen(config)).toBe(true);
  expect(Object.isFrozen(config.options)).toBe(true);
  expect(Object.keys(SCAN_OPTION_CORE_FLOORS).sort()).toEqual(["placeholderFormatter", "ruleset", "scanLimits"]);
});

test("the snapshot is taken at resolution: mutating the caller's limits object or ruleset bytes changes nothing", () => {
  const limits = { maxInputBytes: 64, maxFindings: 3, extra: "dropped" };
  const bytes = new TextEncoder().encode("ruleset-revision: 1\n");
  const config = resolveScanConfig({ scanLimits: limits, ruleset: bytes });
  limits.maxInputBytes = 1;
  bytes.fill(0);
  expect(config.options.limits).toEqual({ maxInputBytes: 64, maxFindings: 3 });
  expect(new TextDecoder().decode(config.options.ruleset as Uint8Array)).toBe("ruleset-revision: 1\n");
  expect(config.options.ruleset).not.toBe(bytes);
});

test("a malformed option is a TypeError with a fixed message, never the value", () => {
  const secret = "SECRET_TOKEN_9";
  const bad = [
    { scanLimits: null },
    { scanLimits: 5 },
    { scanLimits: { maxInputBytes: 1 } },
    { scanLimits: { maxInputBytes: -1, maxFindings: 1 } },
    { scanLimits: { maxInputBytes: Number.NaN, maxFindings: 1 } },
    { scanLimits: { maxInputBytes: secret, maxFindings: 1 } },
    { ruleset: 5 },
    { ruleset: { secret } },
    { placeholderFormatter: secret },
  ];
  for (const options of bad) {
    let error: unknown;
    try {
      resolveScanConfig(options as never);
    } catch (caught) {
      error = caught;
    }
    expect(error, JSON.stringify(options)).toBeInstanceOf(TypeError);
    expect(String((error as Error).message)).not.toContain(secret);
  }
});

test("a malformed option throws at construction of the masker, before any scan", () => {
  const { scan, calls } = recording();
  expect(() => maskSecretsWith(scan, { a: "x" }, { ruleset: 5 as never })).toThrow(TypeError);
  expect(() => maskLeafOutcomeWith(scan, "x", { scanLimits: {} as never })).toThrow(TypeError);
  expect(calls).toEqual([]);
});

test("policy precedence: the caller's policy is passed unchanged and replaces the core's; scanConfig wins over loose options", () => {
  const { scan, calls } = recording();
  const policy = { evaluate: () => "block" as const };
  const other = { evaluate: () => "warn" as const };
  const config = resolveScanConfig({ policy, ruleset: "r" });
  maskLeafOutcomeWith(scan, "x", { policy: other, ruleset: "ignored", scanConfig: config });
  expect(calls[0]?.options?.policy).toBe(policy);
  expect(calls[0]?.options?.ruleset).toBe("r");
});

test("withResolvedScanConfig validates once, reuses a given config and keeps inherited keys readable", () => {
  const base = { ruleset: "r", counterProbe: 1 };
  const layered = withResolvedScanConfig(base);
  expect(layered.scanConfig.requested).toEqual(["ruleset"]);
  expect(layered.counterProbe).toBe(1);
  expect(withResolvedScanConfig(layered)).toBe(layered);
  expect(() => withResolvedScanConfig({ ruleset: 5 as never })).toThrow(TypeError);
});

test("an option set does not change the adapter's own limits or counters", () => {
  const out = maskSecretsWith(keyAwareScanner(), { password: "synthetic-example-value-0001" }, { scanLimits: LIMITS });
  expect(out).toEqual({ password: "<SECRET_1>" });
});

test("versions: the declared floor and later pass, earlier and unreadable ones do not", () => {
  const floor = "0.1.0-beta.6";
  expect(
    ["0.1.0-beta.6", "0.1.0-beta.12", "0.1.0", "0.2.0-alpha.1", "1.0.0", "0.1.0-beta.10+build.5"].map((version) =>
      coreVersionAtLeast(version, floor),
    ),
  ).toEqual([true, true, true, true, true, true]);
  expect(
    ["0.1.0-beta.5", "0.1.0-alpha.9", "0.0.9", "0.1.0-beta", undefined, 7, "", "garbage"].map((v) =>
      coreVersionAtLeast(v, floor),
    ),
  ).toEqual([false, false, false, false, false, false, false, false]);
  expect(coreVersionAtLeast("0.1.0-rc.1", "0.1.0-beta.99")).toBe(true);
  expect(coreVersionAtLeast("0.1.0-beta.2", "0.1.0-beta.10")).toBe(false);
});

test("verifyScanOptions: a no-op without options, even on a core that reports no version", () => {
  const core = {
    scanAndRedact: (): never => {
      throw new Error("must not be called");
    },
  };
  expect(() => verifyScanOptions(core, resolveScanConfig({ policy: { evaluate: () => "redact" } }))).not.toThrow();
});

test("verifyScanOptions: an old or version-less core is CORE_OPTION_UNSUPPORTED, naming only the options", () => {
  const config = resolveScanConfig({ ruleset: "SECRET_TOKEN_1", placeholderFormatter: FORMATTER });
  for (const VERSION of ["0.1.0-beta.5", undefined, "garbage"]) {
    let error: unknown;
    try {
      verifyScanOptions({ VERSION, scanAndRedact: fakeScanAndRedact }, config);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CoreOptionsError);
    const typed = error as CoreOptionsError;
    expect(typed.code).toBe("CORE_OPTION_UNSUPPORTED");
    expect(typed.options).toEqual(["ruleset", "placeholderFormatter"]);
    expect(JSON.stringify({ ...typed, message: typed.message })).not.toContain("SECRET_TOKEN_1");
  }
});

test("verifyScanOptions: a core that rejects the options is CORE_OPTION_REJECTED with only an allowlisted code", () => {
  const config = resolveScanConfig({ ruleset: "SECRET_TOKEN_1" });
  const rejecting =
    (code: string): ScanAndRedact =>
    () => {
      throw Object.assign(new Error("leaks SECRET_TOKEN_1"), { code });
    };
  const known = (() => {
    try {
      verifyScanOptions({ VERSION: "0.1.0-beta.12", scanAndRedact: rejecting("INVALID_RULESET") }, config);
    } catch (caught) {
      return caught as CoreOptionsError;
    }
    throw new Error("expected a throw");
  })();
  expect(known.code).toBe("CORE_OPTION_REJECTED");
  expect(known.coreCode).toBe("INVALID_RULESET");
  expect(known.message).not.toContain("SECRET_TOKEN_1");
  const unknown = (() => {
    try {
      verifyScanOptions({ VERSION: "0.1.0-beta.12", scanAndRedact: rejecting("SECRET_TOKEN_1") }, config);
    } catch (caught) {
      return caught as CoreOptionsError;
    }
    throw new Error("expected a throw");
  })();
  expect(unknown.coreCode).toBeUndefined();
  expect(JSON.stringify({ ...unknown, message: unknown.message })).not.toContain("SECRET_TOKEN_1");
});

test("verifyScanOptions probes with the empty text and the snapshot it will scan with", () => {
  const { scan, calls } = recording();
  const config = resolveScanConfig({ scanLimits: LIMITS });
  verifyScanOptions({ VERSION: "0.1.0-beta.6", scanAndRedact: scan }, config);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.options).toBe(config.options);
  expect(calls[0]?.text).toBe("");
});
