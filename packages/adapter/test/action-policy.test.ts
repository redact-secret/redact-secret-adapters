/**
 * The declarative `actionPolicy` (redact-secret-adapters#217) against fake
 * scanners and fake cores: the three input forms, the snapshot, the callback
 * conflict, what reaches every scan, the version gate and the fixed,
 * input-free errors. The adapter never parses or evaluates a policy, so
 * nothing here asserts a decision: the real-core replay, where the decisions
 * are the core's, is `action-policy-live.test.ts`.
 */

import type { ScanAndRedactOptions } from "@redact-secret/core";
import { expect, test } from "vitest";

import { MALFORMED_MARKER, MALFORMED_POLICY } from "../../../fixtures/action-policy.js";
import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import {
  CoreOptionsError,
  createMaskSecrets,
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

const DOCUMENT = {
  actionPolicyRevision: 1,
  base: "default",
  rules: [{ id: "r", match: { type: ["t"] }, action: "warn" }],
};
const JSON_TEXT = JSON.stringify(DOCUMENT);
const actionPolicyOf = (config: ReturnType<typeof resolveScanConfig>) => config.options.actionPolicy;

test("the verified core floor of actionPolicy is the first published release that has it", () => {
  expect(SCAN_OPTION_CORE_FLOORS.actionPolicy).toBe("0.1.0-beta.14");
  expect(SCAN_OPTION_CORE_FLOORS.scanLimits).toBe("0.1.0-beta.6");
});

test("an object is serialized once, exactly as the core would; text and bytes pass as the same document", () => {
  expect(actionPolicyOf(resolveScanConfig({ actionPolicy: DOCUMENT }))).toBe(JSON_TEXT);
  expect(actionPolicyOf(resolveScanConfig({ actionPolicy: JSON_TEXT }))).toBe(JSON_TEXT);
  const bytes = actionPolicyOf(resolveScanConfig({ actionPolicy: new TextEncoder().encode(JSON_TEXT) }));
  expect(bytes).toBeInstanceOf(Uint8Array);
  expect(new TextDecoder().decode(bytes as Uint8Array)).toBe(JSON_TEXT);
});

test("it is requested by name, listed first, and the adapter does not read the document", () => {
  const config = resolveScanConfig({ actionPolicy: "not even json", scanLimits: { maxInputBytes: 8, maxFindings: 1 } });
  expect(config.requested).toEqual(["actionPolicy", "scanLimits"]);
  expect(actionPolicyOf(config)).toBe("not even json");
  expect(resolveScanConfig({}).requested).toEqual([]);
  expect(resolveScanConfig({ actionPolicy: undefined })).toBe(resolveScanConfig());
});

test("a snapshot: mutating the caller's object, or clobbering its bytes, afterwards changes nothing", () => {
  const object = {
    actionPolicyRevision: 1,
    base: "default",
    rules: [{ id: "r", match: { type: ["t"] }, action: "warn" }],
  };
  const fromObject = resolveScanConfig({ actionPolicy: object });
  (object.rules[0] as { action: string }).action = "block";
  object.rules.push({ id: "x", match: { type: ["u"] }, action: "block" });
  expect(actionPolicyOf(fromObject)).toBe(JSON_TEXT);

  const bytes = new TextEncoder().encode(JSON_TEXT);
  const fromBytes = resolveScanConfig({ actionPolicy: bytes });
  bytes.fill(0);
  expect(new TextDecoder().decode(actionPolicyOf(fromBytes) as Uint8Array)).toBe(JSON_TEXT);
  expect(actionPolicyOf(fromBytes)).not.toBe(bytes);
});

test("a value that cannot be a document is a TypeError with a fixed message, never the value", () => {
  const cyclic: Record<string, unknown> = { marker: "SYNTHETIC-VALUE-MARKER" };
  cyclic.self = cyclic;
  for (const bad of [42, true, null, cyclic, { big: 1n }, { toJSON: () => undefined }, Symbol("x")]) {
    let error: unknown;
    try {
      resolveScanConfig({ actionPolicy: bad as never });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(TypeError);
    expect(String((error as Error).message)).not.toContain("SYNTHETIC-VALUE-MARKER");
    expect((error as Error).message).toMatch(/^actionPolicy must be/);
  }
});

test("a callback policy beside an actionPolicy is rejected before any scan or core load", async () => {
  const policy = { evaluate: () => "redact" as const };
  expect(() => resolveScanConfig({ policy, actionPolicy: DOCUMENT })).toThrow(
    new TypeError("policy and actionPolicy are mutually exclusive: pass one"),
  );
  const { scan, calls } = recording();
  expect(() => maskSecretsWith(scan, "x", { policy, actionPolicy: JSON_TEXT })).toThrow(TypeError);
  expect(() => maskLeafOutcomeWith(scan, "x", { policy, actionPolicy: JSON_TEXT })).toThrow(TypeError);
  expect(() => withResolvedScanConfig({ policy, actionPolicy: JSON_TEXT })).toThrow(TypeError);
  await expect(createMaskSecrets({ policy, actionPolicy: JSON_TEXT })).rejects.toBeInstanceOf(TypeError);
  expect(calls).toEqual([]);
});

test("the one snapshot reaches every scan of every leaf, key-context views included, and no policy callback does", () => {
  const { scan, calls } = recording();
  const object = { ...DOCUMENT, rules: [...DOCUMENT.rules] };
  maskSecretsWith(scan, { api_key: "value", list: ["a"] }, { actionPolicy: object });
  object.rules.length = 0;
  expect(calls.map((call) => call.text)).toEqual(["value", '{"api_key":"value"}', "a"]);
  for (const call of calls) {
    expect(call.options).toEqual({ policy: undefined, actionPolicy: JSON_TEXT });
  }
  expect(new Set(calls.map((call) => (call.options as { actionPolicy?: unknown }).actionPolicy)).size).toBe(1);
});

test("a requested actionPolicy needs a core at the floor; an older or version-less core is refused by name", () => {
  const config = resolveScanConfig({ actionPolicy: DOCUMENT });
  for (const VERSION of ["0.1.0-beta.13", "0.1.0-beta.6", undefined, "garbage"]) {
    let error: unknown;
    try {
      verifyScanOptions({ VERSION, scanAndRedact: fakeScanAndRedact }, config);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(CoreOptionsError);
    const typed = error as CoreOptionsError;
    expect(typed.code).toBe("CORE_OPTION_UNSUPPORTED");
    expect(typed.options).toEqual(["actionPolicy"]);
    expect(typed.message).not.toContain("synthetic");
    expect(typed.message).not.toContain('"rules"');
  }
  expect(() => verifyScanOptions({ VERSION: "0.1.0-beta.14", scanAndRedact: fakeScanAndRedact }, config)).not.toThrow();
  expect(() => verifyScanOptions({ VERSION: "0.1.0", scanAndRedact: fakeScanAndRedact }, config)).not.toThrow();
});

test("an older core still serves every legacy option: only the actionPolicy is refused, and by name", () => {
  const legacy = resolveScanConfig({
    scanLimits: { maxInputBytes: 64, maxFindings: 2 },
    ruleset: "ruleset-revision: 1\n",
    placeholderFormatter: () => "[x]",
  });
  const old = { VERSION: "0.1.0-beta.6", scanAndRedact: fakeScanAndRedact };
  expect(() => verifyScanOptions(old, legacy)).not.toThrow();
  const mixed = resolveScanConfig({ scanLimits: { maxInputBytes: 64, maxFindings: 2 }, actionPolicy: DOCUMENT });
  let error: unknown;
  try {
    verifyScanOptions(old, mixed);
  } catch (caught) {
    error = caught;
  }
  expect((error as CoreOptionsError).options).toEqual(["actionPolicy"]);
});

test("a core that refuses the document is CORE_OPTION_REJECTED with INVALID_ACTION_POLICY and nothing of the document or the core's text", () => {
  const config = resolveScanConfig({ actionPolicy: MALFORMED_POLICY });
  const refusing: ScanAndRedact = () => {
    throw Object.assign(new Error(`rejected ${MALFORMED_MARKER}`), {
      code: "INVALID_ACTION_POLICY",
      cause: MALFORMED_POLICY,
    });
  };
  let error: unknown;
  try {
    verifyScanOptions({ VERSION: "0.1.0-beta.14", scanAndRedact: refusing }, config);
  } catch (caught) {
    error = caught;
  }
  const typed = error as CoreOptionsError;
  expect(typed).toBeInstanceOf(CoreOptionsError);
  expect(typed.code).toBe("CORE_OPTION_REJECTED");
  expect(typed.coreCode).toBe("INVALID_ACTION_POLICY");
  expect(typed.options).toEqual(["actionPolicy"]);
  expect(JSON.stringify({ ...typed, message: typed.message, cause: typed.cause })).not.toContain(MALFORMED_MARKER);
});

test("verifyScanOptions probes with the empty text and the very snapshot it will scan with", () => {
  const { scan, calls } = recording();
  const config = resolveScanConfig({ actionPolicy: DOCUMENT });
  verifyScanOptions({ VERSION: "0.1.0-beta.14", scanAndRedact: scan }, config);
  expect(calls).toHaveLength(1);
  expect(calls[0]?.text).toBe("");
  expect(calls[0]?.options).toBe(config.options);
});
