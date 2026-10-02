/**
 * The verified scan options through the real core, from a clean consumer's
 * point of view (redact-secret-adapters#175): a synthetic declarative ruleset,
 * a custom placeholder formatter, low byte and finding ceilings, policy
 * precedence, and callbacks that fail. CI runs this at both ends of the
 * declared core range, so the options are shown to behave the same from the
 * floor up and to be rejected explicitly, never ignored, where they cannot.
 */

import { expect, test } from "vitest";

import { BROKEN_RULESET, SYNTHETIC_RULESET, SYNTHETIC_TOKEN } from "../../../fixtures/scan-options.js";
import { CoreOptionsError, createMaskSecrets, type Policy } from "../src/index.js";

const AROUND = `value ${SYNTHETIC_TOKEN} end`;
const GITHUB = `ghp_${"x".repeat(36)}`;

const policyOf = (action: "redact" | "block" | "warn" | "allow"): Policy => ({ evaluate: () => action });

test("without a ruleset the in-house token format is not detected at all", async () => {
  const maskSecrets = await createMaskSecrets({ policy: policyOf("redact") });
  expect(maskSecrets([AROUND])).toEqual([AROUND]);
});

test("policy precedence: the core's default policy only warns on a ruleset finding; the caller's policy replaces it", async () => {
  const byDefault = await createMaskSecrets({ ruleset: SYNTHETIC_RULESET });
  expect(byDefault([AROUND])).toEqual([AROUND]);
  const outcomes = {
    redact: "value <SECRET_1> end",
    block: "[REDACTED:BLOCKED]",
    warn: AROUND,
    allow: AROUND,
  } as const;
  for (const [action, expected] of Object.entries(outcomes)) {
    const maskSecrets = await createMaskSecrets({ ruleset: SYNTHETIC_RULESET, policy: policyOf(action as never) });
    expect(maskSecrets([AROUND]), action).toEqual([expected]);
  }
});

test("a ruleset may be bytes, and is a snapshot: clobbering the buffer afterwards changes nothing", async () => {
  const bytes = new TextEncoder().encode(SYNTHETIC_RULESET);
  const maskSecrets = await createMaskSecrets({ ruleset: bytes, policy: policyOf("redact") });
  bytes.fill(0);
  expect(maskSecrets([AROUND])).toEqual(["value <SECRET_1> end"]);
});

test("a custom placeholder formatter reaches the core, for a ruleset finding and a built-in one", async () => {
  const maskSecrets = await createMaskSecrets({
    ruleset: SYNTHETIC_RULESET,
    policy: policyOf("redact"),
    placeholderFormatter: (finding, context) => `[${finding.type}#${context.placeholderIndex}]`,
  });
  const [custom, builtin] = maskSecrets([AROUND, `token ${GITHUB}`]) as string[];
  expect(custom).toMatch(/^value \[[a-z_-]+#1\] end$/);
  expect(custom).not.toContain(SYNTHETIC_TOKEN);
  expect(builtin).toMatch(/^token \[[a-z_-]+#1\]$/);
  expect(builtin).not.toContain(GITHUB);
});

test("low byte and finding ceilings are the core's: a leaf past them is the error marker, never the input", async () => {
  const maskSecrets = await createMaskSecrets({ scanLimits: { maxInputBytes: 40, maxFindings: 1 } });
  expect(maskSecrets(["short"])).toEqual(["short"]);
  const over = maskSecrets([`${"x".repeat(41)} ${GITHUB}`]) as string[];
  expect(over).toEqual(["[REDACTED:ERROR]"]);
  const twoFindings = await createMaskSecrets({
    scanLimits: { maxInputBytes: 4096, maxFindings: 1 },
    ruleset: SYNTHETIC_RULESET,
    policy: policyOf("redact"),
  });
  expect(twoFindings([`${SYNTHETIC_TOKEN} ${SYNTHETIC_TOKEN.replace("0001", "0002")}`])).toEqual(["[REDACTED:ERROR]"]);
});

test("a key-context view counts against the byte ceiling, so a keyed leaf has the ceiling minus its key and punctuation", async () => {
  const maskSecrets = await createMaskSecrets({ scanLimits: { maxInputBytes: 16, maxFindings: 4 } });
  expect(maskSecrets({ a: "0123456789" })).toEqual({ a: "[REDACTED:ERROR]" });
  expect(maskSecrets(["0123456789"])).toEqual(["0123456789"]);
});

test("the scan limits are a snapshot: mutating the caller's object afterwards changes nothing", async () => {
  const scanLimits = { maxInputBytes: 40, maxFindings: 4 };
  const maskSecrets = await createMaskSecrets({ scanLimits });
  scanLimits.maxInputBytes = 1_000_000;
  expect(maskSecrets([`${"y".repeat(60)}`])).toEqual(["[REDACTED:ERROR]"]);
});

test("a throwing policy or formatter fails the leaf closed, without the message or the input", async () => {
  const leak = `SYNTHETIC-CALLBACK-LEAK ${SYNTHETIC_TOKEN}`;
  const policy: Policy = {
    evaluate: () => {
      throw new Error(leak);
    },
  };
  const throwingPolicy = await createMaskSecrets({ ruleset: SYNTHETIC_RULESET, policy });
  expect(throwingPolicy([AROUND])).toEqual(["[REDACTED:ERROR]"]);
  const throwingFormatter = await createMaskSecrets({
    ruleset: SYNTHETIC_RULESET,
    policy: policyOf("redact"),
    placeholderFormatter: () => {
      throw new Error(leak);
    },
  });
  const out = JSON.stringify(throwingFormatter([AROUND, { k: AROUND }]));
  expect(out).toBe('["[REDACTED:ERROR]",{"k":"[REDACTED:ERROR]"}]');
});

test("a ruleset the core rejects is a fixed CoreOptionsError at construction, with no ruleset text in it", async () => {
  const error = await createMaskSecrets({ ruleset: BROKEN_RULESET }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CoreOptionsError);
  const typed = error as CoreOptionsError;
  expect(typed.code).toBe("CORE_OPTION_REJECTED");
  expect(typed.coreCode).toBe("INVALID_RULESET");
  expect(typed.options).toEqual(["ruleset"]);
  expect(JSON.stringify({ ...typed, message: typed.message })).not.toContain("SYNTHETIC-BROKEN-RULESET-MARKER");
});

test("limits the core rejects are rejected at construction too, and malformed options are a TypeError before the core loads", async () => {
  const limits = await createMaskSecrets({ scanLimits: { maxInputBytes: 0, maxFindings: 0 } }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(limits).toBeInstanceOf(CoreOptionsError);
  expect((limits as CoreOptionsError).coreCode).toBe("INVALID_LIMITS");
  await expect(createMaskSecrets({ ruleset: 5 as never })).rejects.toBeInstanceOf(TypeError);
});

test("omitting every new option still works exactly as before", async () => {
  const maskSecrets = await createMaskSecrets({ policy: policyOf("redact") });
  expect(maskSecrets({ list: [`token ${GITHUB}`] })).toEqual({ list: ["token <SECRET_1>"] });
});
