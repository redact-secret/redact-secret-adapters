/**
 * The policy action truth table for the marker-based walker
 * (redact-secret/redact-secret-adapters#214, `docs/action-semantics.md`):
 * what `createMaskSecrets` emits for each of allow / warn / redact / block, for
 * a core failure, for every limit, and for object keys, on the real installed
 * core with the legacy callback `policy` (the only policy surface the published
 * core has). Every expected value is spelled out. Values are synthetic and the
 * credential is built at runtime.
 */

import { initialize, scanAndRedact } from "@redact-secret/core";
import { beforeAll, describe, expect, test } from "vitest";

import {
  INVALID_POLICY,
  policyFor,
  SYNTHETIC_CONTEXTUAL_VALUE,
  SYNTHETIC_TOKEN,
  THROWING_POLICY,
} from "../../../fixtures/action-semantics.js";
import { createMaskSecrets, createOutcomeCounter, type MaskOptions, type ValueCounts } from "../src/index.js";

const LEAF = `x ${SYNTHETIC_TOKEN} y`;
const INPUT = { note: LEAF, clean: "plain", n: 2 };

beforeAll(async () => {
  await initialize();
});

async function mask(options: MaskOptions, input: unknown = INPUT): Promise<{ out: unknown; counts: ValueCounts }> {
  const counter = createOutcomeCounter();
  const out = (await createMaskSecrets({ ...options, counter }))(input);
  return { out, counts: { ...counter } };
}

describe("core reference: the same actions on the whole-input scan", () => {
  test.each([
    ["allow", LEAF],
    ["warn", LEAF],
    ["redact", "x <SECRET_1> y"],
    // The core substitutes a block finding in place like a redact one; the whole-leaf marker below is the adapter's.
    ["block", "x <SECRET_1> y"],
  ] as const)("%s", (action, text) => {
    const result = scanAndRedact(LEAF, { policy: policyFor(action) });
    expect(result.text).toBe(text);
    expect(result.findings.map((finding) => finding.action)).toEqual([action]);
  });
});

describe("logging walker (createMaskSecrets): one finding, one policy action", () => {
  test.each([
    // allow and warn leave the value in the output; the finding is only counted.
    ["allow", LEAF, { scanned: 2, findings: 1, redacted: 0, blocked: 0, limited: 0, failed: 0 }],
    ["warn", LEAF, { scanned: 2, findings: 1, redacted: 0, blocked: 0, limited: 0, failed: 0 }],
    ["redact", "x <SECRET_1> y", { scanned: 2, findings: 1, redacted: 1, blocked: 0, limited: 0, failed: 0 }],
    // block replaces the WHOLE leaf, not the matched span.
    ["block", "[REDACTED:BLOCKED]", { scanned: 2, findings: 1, redacted: 0, blocked: 1, limited: 0, failed: 0 }],
  ] as const)("%s", async (action, note, counts) => {
    const { out, counts: actual } = await mask({ policy: policyFor(action) });
    expect(out).toEqual({ note, clean: "plain", n: 2 });
    expect(actual).toEqual(counts);
  });

  test("allow and warn are observation only: the output is exactly the input", async () => {
    for (const action of ["allow", "warn"] as const) {
      const { out } = await mask({ policy: policyFor(action) });
      expect(JSON.stringify(out)).toContain(SYNTHETIC_TOKEN);
    }
  });
});

describe("failure never falls back to plaintext", () => {
  test.each([
    ["a throwing policy", THROWING_POLICY],
    ["a policy that returns a non-action", INVALID_POLICY],
  ] as const)("%s is the fixed error marker on the scanned leaf", async (_name, policy) => {
    const { out, counts } = await mask({ policy });
    // Only the leaf with a finding reaches the policy; a clean leaf is untouched.
    expect(out).toEqual({ note: "[REDACTED:ERROR]", clean: "plain", n: 2 });
    expect(counts).toEqual({ scanned: 2, findings: 0, redacted: 0, blocked: 0, limited: 0, failed: 1 });
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_TOKEN);
  });

  test("a throwing getter is the error marker, never the value or the error message", async () => {
    const input = {
      get secret(): string {
        throw new Error(`getter failed on ${SYNTHETIC_TOKEN}`);
      },
      clean: "plain",
    };
    const { out, counts } = await mask({}, input);
    expect(out).toEqual({ secret: "[REDACTED:ERROR]", clean: "plain" });
    expect(counts.failed).toBe(1);
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_TOKEN);
  });
});

describe("limits: past a bound a value is a marker or dropped, never passed through", () => {
  test("maxStringLength: the leaf is not scanned and is the limit marker", async () => {
    const { out, counts } = await mask({ limits: { maxStringLength: 10 } }, { note: LEAF });
    expect(out).toEqual({ note: "[REDACTED:LIMIT_EXCEEDED]" });
    expect(counts).toEqual({ scanned: 0, findings: 0, redacted: 0, blocked: 0, limited: 1, failed: 0 });
  });

  test("maxDepth: the value past the depth is the limit marker", async () => {
    const { out } = await mask({ limits: { maxDepth: 1 } }, { a: { b: { c: SYNTHETIC_TOKEN } }, d: "ok" });
    expect(out).toEqual({ a: "[REDACTED:LIMIT_EXCEEDED]", d: "ok" });
  });

  test("maxArrayLength and maxObjectKeys: elements and keys past the width are dropped", async () => {
    expect((await mask({ limits: { maxArrayLength: 1 } }, ["a", SYNTHETIC_TOKEN, "c"])).out).toEqual(["a"]);
    expect((await mask({ limits: { maxObjectKeys: 1 } }, { first: "a", second: SYNTHETIC_TOKEN })).out).toEqual({
      first: "a",
    });
  });

  test("maxTotalLeaves: leaves past the walk's leaf budget are the limit marker", async () => {
    const leaves = { a: LEAF, b: LEAF, c: LEAF };
    expect((await mask({ limits: { maxTotalLeaves: 1 } }, leaves)).out).toEqual({
      a: "x <SECRET_1> y",
      b: "[REDACTED:LIMIT_EXCEEDED]",
      c: "[REDACTED:LIMIT_EXCEEDED]",
    });
  });

  test("the per-operation budget is sticky: later array elements are the limit marker, later object keys are dropped", async () => {
    const options = { operationLimits: { maxScans: 1 } };
    expect((await mask(options, [LEAF, `${LEAF} 2`, `${LEAF} 3`])).out).toEqual([
      "x <SECRET_1> y",
      "[REDACTED:LIMIT_EXCEEDED]",
      "[REDACTED:LIMIT_EXCEEDED]",
    ]);
    // Once the budget is spent the remaining KEYS of an object are dropped (with one limited count), not marked.
    const { out, counts } = await mask(options, { a: LEAF, b: `${LEAF} 2`, c: `${LEAF} 3` });
    expect(out).toEqual({ a: "x <SECRET_1> y", b: "[REDACTED:LIMIT_EXCEEDED]" });
    expect(counts.limited).toBe(2);
    expect(JSON.stringify(out)).not.toContain(SYNTHETIC_TOKEN);
  });

  test("a cycle is the cycle marker and the rest is still masked", async () => {
    const cyclic: Record<string, unknown> = { token: LEAF };
    cyclic.self = cyclic;
    expect((await mask({}, cyclic)).out).toEqual({ token: "x <SECRET_1> y", self: "[REDACTED:CYCLE]" });
  });
});

describe("object keys", () => {
  test("a key is never scanned or rewritten: a credential in a key reaches the output (caller responsibility)", async () => {
    const { out } = await mask({}, { [SYNTHETIC_TOKEN]: "value" });
    expect(Object.keys(out as object)).toEqual([SYNTHETIC_TOKEN]);
  });

  test("a key is context for its leaf: the credential-shaped leaf is masked, the key is kept", async () => {
    const input = { api_key: SYNTHETIC_CONTEXTUAL_VALUE, other: "x" };
    expect((await mask({}, input)).out).toEqual({ api_key: "<SECRET_1>", other: "x" });
    expect((await mask({ policy: policyFor("block") }, input)).out).toEqual({
      api_key: "[REDACTED:BLOCKED]",
      other: "x",
    });
    // warn and allow: the contextual value stays in the output.
    expect((await mask({ policy: policyFor("warn") }, input)).out).toEqual(input);
  });

  test("a credential in a key blocks that leaf (the key itself stays visible)", async () => {
    const { out } = await mask({}, { [SYNTHETIC_TOKEN]: "value" });
    expect(out).toEqual({ [SYNTHETIC_TOKEN]: "[REDACTED:BLOCKED]" });
  });
});

describe("observation mode: warn everywhere plus the counter", () => {
  test("every finding is counted, nothing is altered", async () => {
    const input = { a: LEAF, b: `again ${SYNTHETIC_TOKEN}` };
    const { out, counts } = await mask({ policy: policyFor("warn") }, input);
    expect(out).toEqual(input);
    expect(counts).toEqual({ scanned: 2, findings: 2, redacted: 0, blocked: 0, limited: 0, failed: 0 });
  });
});
