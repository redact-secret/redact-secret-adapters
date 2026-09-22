import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import {
  BLOCK_MARKER,
  CYCLE_MARKER,
  DEFAULT_LIMITS,
  ERROR_MARKER,
  LIMIT_MARKER,
  maskLeafWith,
  maskSecretsWith,
  type ScanAndRedact,
} from "../src/index.js";
import { loadCases } from "./load-cases.js";

type Masked = Record<string, unknown>;

test.each(loadCases("mask-secrets-cases.json"))("shared fixture: $name", ({ input, expected }) => {
  expect(maskSecretsWith(fakeScanAndRedact, input)).toEqual(expected);
});

test("large strings are scanned in full when within the size limit", () => {
  const input = { blob: `${"x".repeat(3000)} SECRET_TOKEN_9 ${"y".repeat(3000)}` };
  const expected = { blob: `${"x".repeat(3000)} <SECRET_1> ${"y".repeat(3000)}` };
  expect(maskSecretsWith(fakeScanAndRedact, input)).toEqual(expected);
});

test("a block finding replaces the whole leaf, never a partial value", () => {
  const result = maskSecretsWith(fakeScanAndRedact, { key: "prefix BLOCK_ME suffix" }) as Masked;
  expect(result.key).toBe(BLOCK_MARKER);
  expect(JSON.stringify(result)).not.toContain("prefix");
  expect(JSON.stringify(result)).not.toContain("suffix");
});

test("a core failure fails closed and never surfaces the error or the input", () => {
  const result = maskSecretsWith(fakeScanAndRedact, { key: "trigger BOOM here" }) as Masked;
  expect(result.key).toBe(ERROR_MARKER);
  expect(JSON.stringify(result)).not.toContain("BOOM");
  expect(JSON.stringify(result)).not.toContain("simulated core failure");
});

test("a scanAndRedact that throws NOT_INITIALIZED-shaped errors fails closed", () => {
  const uninitialized: ScanAndRedact = () => {
    throw Object.assign(new Error("redact-secret is not initialized; await initialize() before this call."), {
      code: "NOT_INITIALIZED",
    });
  };
  const result = maskSecretsWith(uninitialized, { key: "any input" }) as Masked;
  expect(result.key).toBe(ERROR_MARKER);
});

test("numbers, booleans, null, and non-plain objects are left unchanged", () => {
  const when = new Date("2026-01-01T00:00:00.000Z");
  const input = { count: 1, active: false, missing: null, when };
  const result = maskSecretsWith(fakeScanAndRedact, input) as Masked;
  expect(result.count).toBe(1);
  expect(result.active).toBe(false);
  expect(result.missing).toBe(null);
  expect(result.when).toBe(when);
});

test("depth beyond the limit is marked rather than walked", () => {
  const input = { a: { b: { c: "SECRET_TOKEN_1" } } };
  const result = maskSecretsWith(fakeScanAndRedact, input, { limits: { maxDepth: 1 } }) as Masked;
  expect(result.a).toBe(LIMIT_MARKER);
});

test("array and object entries beyond the size limit are dropped, never passed through", () => {
  const arrayResult = maskSecretsWith(fakeScanAndRedact, ["a", "b", "c"], { limits: { maxArrayLength: 2 } });
  expect(arrayResult).toEqual(["a", "b"]);

  const objectResult = maskSecretsWith(
    fakeScanAndRedact,
    { a: "1", b: "2", c: "3" },
    { limits: { maxObjectKeys: 2 } },
  ) as Masked;
  expect(Object.keys(objectResult)).toEqual(["a", "b"]);
});

test("the total-leaf budget bounds work across the whole call, not per branch", () => {
  const input = { a: "SECRET_TOKEN_1", b: "SECRET_TOKEN_2", c: "SECRET_TOKEN_3" };
  const result = maskSecretsWith(fakeScanAndRedact, input, { limits: { maxTotalLeaves: 2 } }) as Masked;
  expect(result.a).toBe("<SECRET_1>");
  expect(result.b).toBe("<SECRET_1>");
  expect(result.c).toBe(LIMIT_MARKER);
});

test("a cycle is marked rather than recursed into forever", () => {
  const input: Masked = { name: "root" };
  input.self = input;
  const result = maskSecretsWith(fakeScanAndRedact, input) as Masked;
  expect(result.name).toBe("root");
  expect(result.self).toBe(CYCLE_MARKER);
});

test("an explicit undefined, NaN, or negative limit falls back to the default instead of disabling it", () => {
  const deep = { a: { b: { c: { d: { e: { f: { g: { h: { i: "SECRET_TOKEN_1" } } } } } } } } };
  for (const maxDepth of [undefined, Number.NaN, -1]) {
    const result = JSON.stringify(maskSecretsWith(fakeScanAndRedact, deep, { limits: { maxDepth } }));
    expect(result, String(maxDepth)).toContain(LIMIT_MARKER);
    expect(result, String(maxDepth)).not.toContain("SECRET_TOKEN_1");
  }
  const long = { blob: `SECRET_TOKEN_1 ${"a".repeat(DEFAULT_LIMITS.maxStringLength)}` };
  for (const maxStringLength of [undefined, Number.NaN, -5]) {
    expect(maskSecretsWith(fakeScanAndRedact, long, { limits: { maxStringLength } })).toEqual({ blob: LIMIT_MARKER });
  }
  expect(maskLeafWith(fakeScanAndRedact, "a".repeat(11), { maxStringLength: Number.NaN })).toBe("a".repeat(11));
  expect(maskLeafWith(fakeScanAndRedact, long.blob, { maxStringLength: Number.NaN })).toBe(LIMIT_MARKER);
});

test("a string too long for the size limit is marked, not scanned", () => {
  const input = { blob: "a".repeat(50) };
  const result = maskSecretsWith(fakeScanAndRedact, input, { limits: { maxStringLength: 10 } }) as Masked;
  expect(result.blob).toBe(LIMIT_MARKER);
});

test("rejects a non-function scanAndRedact", () => {
  expect(() => maskSecretsWith(null as unknown as ScanAndRedact, {})).toThrow(TypeError);
});

test("preserves prototype-named JSON keys as redacted own data", () => {
  const input = JSON.parse(
    '{"__proto__":{"value":"SECRET_TOKEN_1"},"constructor":"SECRET_TOKEN_2","toString":"SECRET_TOKEN_3"}',
  );
  const result = maskSecretsWith(fakeScanAndRedact, input) as Masked;
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.hasOwn(result, "__proto__")).toBe(true);
  expect(JSON.parse(JSON.stringify(result))).toEqual(
    JSON.parse('{"__proto__":{"value":"<SECRET_1>"},"constructor":"<SECRET_1>","toString":"<SECRET_1>"}'),
  );
  expect(Object.getOwnPropertyDescriptor(input, "__proto__")?.value.value).toBe("SECRET_TOKEN_1");
});
