/**
 * The aggregate operation budget on the AI-context boundary
 * (redact-secret-adapters#173): one `sanitizeText`, `sanitizeValue` or
 * `buildContext` call is one operation, every part of a context shares it, and
 * an exhausted budget is a fixed `blocked` / `limit_exceeded` outcome with no
 * value and no findings, never a partly approved context.
 */

import { describe, expect, test } from "vitest";

import { type AiContextBoundaryOptions, createAiContextBoundaryWith, MAX_MEMO_ENTRIES } from "../src/index.js";
import { createFakeCore, LIMITS } from "./fake-core.js";

const OVER = { outcome: "blocked", reason: "limit_exceeded" } as const;

function setup(
  operationLimits: AiContextBoundaryOptions["operationLimits"],
  overrides: Partial<AiContextBoundaryOptions> = {},
) {
  const fake = createFakeCore();
  const events: unknown[] = [];
  const boundary = createAiContextBoundaryWith(fake.core, {
    ...LIMITS,
    traversalLimits: { maxDepth: 8, maxNodes: 100_000 },
    operationLimits,
    onFinding: (finding, context) => events.push({ finding, context }),
    ...overrides,
  });
  return { boundary, calls: fake.calls, events };
}

describe("many parts, many leaves", () => {
  test("a context with many parts stops at the operation's scan bound, though each part is within every other limit", () => {
    const { boundary, calls } = setup({ maxScans: 5 });
    const parts = Array.from({ length: 50 }, (_, index) => ({ role: "user", text: `message ${index}` }));
    expect(boundary.buildContext(parts)).toEqual(OVER);
    expect(calls.scans).toHaveLength(5);
    // The same parts, one at a time, are each fine: the bound is the sum.
    for (const part of parts.slice(0, 5)) expect(boundary.buildContext([part]).outcome).toBe("ok");
  });

  test("an over-limit context returns no value, no findings and no partially approved message", () => {
    const { boundary, events } = setup({ maxLeaves: 2 });
    const outcome = boundary.buildContext([
      { role: "user", text: "SECRET_TOKEN_1" },
      { role: "tool", value: { a: "x", b: "y" } },
    ]);
    expect(outcome).toEqual(OVER);
    expect(Object.keys(outcome)).toEqual(["outcome", "reason"]);
    // Callbacks fired only for what was inspected, and carry no input beyond the finding's safe fields.
    expect(JSON.stringify(events)).not.toContain("SECRET_TOKEN");
  });

  test("many small fields in one value stop at the leaf bound", () => {
    const { boundary } = setup({ maxLeaves: 10 });
    const value = Object.fromEntries(Array.from({ length: 30 }, (_, index) => [`k${index}`, "v"]));
    expect(boundary.sanitizeValue(value)).toEqual(OVER);
    expect(boundary.sanitizeValue(Object.fromEntries(Object.entries(value).slice(0, 10))).outcome).toBe("ok");
  });

  test("a shared reference reached by many paths stops at the node bound", () => {
    const shared = ["a", "b"];
    const value = Array.from({ length: 100 }, () => shared);
    expect(setup({ maxNodes: 50 }).boundary.sanitizeValue(value)).toEqual(OVER);
    expect(setup({ maxNodes: 400 }).boundary.sanitizeValue(value).outcome).toBe("ok");
  });

  test("object keys are counted, and a key scan counts as a scan and its bytes", () => {
    const { boundary, calls } = setup({ maxKeys: 3 });
    expect(boundary.sanitizeValue({ a: 1, b: 2, c: 3, d: 4 })).toEqual(OVER);
    expect(boundary.sanitizeValue({ a: 1, b: 2, c: 3 }).outcome).toBe("ok");
    // 3 keys scanned on their own in the second call, none in the first past the bound.
    expect(calls.scans.filter((text) => ["a", "b", "c"].includes(text)).length).toBeGreaterThanOrEqual(3);
  });
});

describe("boundary values and Unicode byte accounting", () => {
  test("maxScans: exactly the limit passes, one more fails", () => {
    const parts = (count: number) => Array.from({ length: count }, (_, index) => ({ role: "u", text: `t${index}` }));
    expect(setup({ maxScans: 4 }).boundary.buildContext(parts(4)).outcome).toBe("ok");
    expect(setup({ maxScans: 4 }).boundary.buildContext(parts(5))).toEqual(OVER);
  });

  test("maxBytes counts UTF-8 bytes, not code units", () => {
    const text = "한".repeat(10);
    // Korean is 3 bytes per code unit, emoji 4: 30 bytes fit exactly, 29 do not.
    expect(
      setup({ maxBytes: 30 }, { wholeInputLimits: { maxInputBytes: 1_000_000, maxFindings: 4 } }).boundary.sanitizeText(
        text,
      ).outcome,
    ).toBe("ok");
    expect(
      setup({ maxBytes: 29 }, { wholeInputLimits: { maxInputBytes: 1_000_000, maxFindings: 4 } }).boundary.sanitizeText(
        text,
      ),
    ).toEqual(OVER);
    expect(setup({ maxBytes: 4 }).boundary.sanitizeText("😀").outcome).toBe("ok");
    expect(setup({ maxBytes: 3 }).boundary.sanitizeText("😀")).toEqual(OVER);
  });

  test("by default the byte bound is never below four times the whole-input ceiling", () => {
    const text = "x".repeat(200);
    const { boundary } = setup(undefined, { wholeInputLimits: { maxInputBytes: 256, maxFindings: 4 } });
    // 200 bytes alone, then 200 + 8 in a key-context view, then the key: well inside 4 x 256.
    expect(boundary.sanitizeValue({ k: text }).outcome).toBe("ok");
    // An explicit lower value is honored as given.
    expect(setup({ maxBytes: 100 }).boundary.sanitizeValue({ k: text })).toEqual(OVER);
  });

  test("findings are charged per occurrence, memoized or not", () => {
    const { boundary } = setup({ maxFindings: 3 }, { wholeInputLimits: { maxInputBytes: 256, maxFindings: 4 } });
    const part = { role: "u", text: "SECRET_TOKEN_1" };
    expect(boundary.buildContext([part, part, part]).outcome).toBe("ok");
    expect(boundary.buildContext([part, part, part, part])).toEqual(OVER);
  });
});

describe("memoization and isolation", () => {
  test("a memoized repeat is not a core call, so it costs no scan or bytes, but still a leaf and a node", () => {
    const { boundary, calls } = setup({ maxScans: 1, maxLeaves: 4 });
    const part = { role: "u", text: "same" };
    expect(boundary.buildContext([part, part, part, part]).outcome).toBe("ok");
    expect(calls.scans).toEqual(["same"]);
    expect(boundary.buildContext([part, part, part, part, part])).toEqual(OVER);
  });

  test("the memo is bounded: past its entry cap a text is scanned again", () => {
    const { boundary, calls } = setup({}, {});
    const distinct = Array.from({ length: MAX_MEMO_ENTRIES + 10 }, (_, index) => ({ role: "u", text: `d${index}` }));
    const parts = [...distinct, ...distinct.slice(-5)];
    expect(boundary.buildContext(parts).outcome).toBe("ok");
    // The last five were never remembered, so each is scanned a second time.
    expect(calls.scans.length).toBe(parts.length);
  });

  test("two operations never share a budget, and an operation cannot be re-entered into another's", () => {
    const { boundary } = setup({ maxScans: 2 });
    for (let call = 0; call < 5; call += 1) {
      expect(
        boundary.buildContext([
          { role: "u", text: "a" },
          { role: "u", text: "b" },
        ]).outcome,
      ).toBe("ok");
    }
    let inner: unknown;
    const value = {
      get nested() {
        inner = boundary.sanitizeText("x");
        return "y";
      },
    };
    expect(boundary.sanitizeValue(value).outcome).toBe("blocked");
    expect(inner).toMatchObject({ outcome: "ok" });
  });

  test("an open stream is bounded by its findings only, and fails closed as limit_exceeded", () => {
    const { boundary } = setup({ maxFindings: 0 });
    const stream = boundary.openStream();
    stream.append("SECRET_TOKEN_1");
    expect(stream.finalize()).toEqual(OVER);
    const clean = setup({ maxFindings: 0 }).boundary.openStream();
    clean.append("nothing here");
    expect(clean.finalize()).toMatchObject({ outcome: "ok", value: "nothing here" });
  });
});

describe("configuration", () => {
  test("operationLimits must be an object; omitted keys use the shared defaults", () => {
    const fake = createFakeCore();
    expect(() => createAiContextBoundaryWith(fake.core, { ...LIMITS, operationLimits: 5 as never })).toThrow(TypeError);
    expect(() => createAiContextBoundaryWith(fake.core, { ...LIMITS, operationLimits: null as never })).toThrow(
      TypeError,
    );
    const boundary = createAiContextBoundaryWith(fake.core, { ...LIMITS, operationLimits: { maxScans: 1 } });
    expect(boundary.sanitizeText("hello").outcome).toBe("ok");
  });

  test("a bound of zero allows nothing and an unusable value falls back to the default", () => {
    expect(setup({ maxLeaves: 0 }).boundary.sanitizeText("x")).toEqual(OVER);
    expect(setup({ maxLeaves: Number.NaN }).boundary.sanitizeText("x").outcome).toBe("ok");
  });

  test("the budget is checked between scans: it does not call the core once spent", () => {
    const { boundary, calls } = setup({ maxScans: 0 });
    expect(boundary.sanitizeText("x")).toEqual(OVER);
    expect(calls.scans).toEqual([]);
  });
});
