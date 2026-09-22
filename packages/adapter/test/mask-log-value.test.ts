import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { CYCLE_MARKER, LIMIT_MARKER, maskLogValueWith, type ScanAndRedact } from "../src/index.js";
import { loadCases } from "./load-cases.js";

type Masked = Record<string, unknown>;

test.each(loadCases("logging-redaction-cases.json"))("shared fixture: $name", ({ input, expected }) => {
  expect(maskLogValueWith(fakeScanAndRedact, input)).toEqual(expected);
});

test("an Error is replaced by a redacted { type, message, stack } object", () => {
  const result = maskLogValueWith(fakeScanAndRedact, new TypeError("failed with SECRET_TOKEN_1")) as Masked;
  expect(result.type).toBe("TypeError");
  expect(result.message).toBe("failed with <SECRET_1>");
  expect(typeof result.stack).toBe("string");
  expect(JSON.stringify(result)).not.toContain("SECRET_TOKEN_1");
});

test("an Error's cause is walked and redacted", () => {
  const error = new Error("outer", { cause: new Error("inner SECRET_TOKEN_1") });
  const result = maskLogValueWith(fakeScanAndRedact, error) as { cause: Masked };
  expect(result.cause.message).toBe("inner <SECRET_1>");
});

test("an Error at maxDepth is marked, never walked or passed through", () => {
  const result = maskLogValueWith(fakeScanAndRedact, { a: new Error("SECRET_TOKEN_1") }, { limits: { maxDepth: 1 } });
  expect(result).toEqual({ a: LIMIT_MARKER });
});

test("a cause cycle is marked rather than recursed into forever", () => {
  const outer = new Error("outer SECRET_TOKEN_1");
  const inner = new Error("inner SECRET_TOKEN_2", { cause: outer });
  Object.defineProperty(outer, "cause", { value: inner, enumerable: false, configurable: true });
  const result = maskLogValueWith(fakeScanAndRedact, outer) as { cause: Masked };
  expect(result.cause.message).toBe("inner <SECRET_1>");
  expect(result.cause.cause).toBe(CYCLE_MARKER);
  expect(JSON.stringify(result)).not.toMatch(/SECRET_TOKEN_\d/);
});

test("an array cycle is marked rather than recursed into forever", () => {
  const list: unknown[] = ["SECRET_TOKEN_1"];
  list.push(list);
  expect(maskLogValueWith(fakeScanAndRedact, list)).toEqual(["<SECRET_1>", CYCLE_MARKER]);
});

test("an Error's own type/message/stack properties never override the masked fixed fields", () => {
  const error = Object.assign(new Error("real"), { type: "SECRET_TOKEN_1", code: "E_SECRET_TOKEN_2" });
  const result = maskLogValueWith(fakeScanAndRedact, error) as Masked;
  expect(result.type).toBe("Error");
  expect(result.code).toBe("E_<SECRET_1>");
  expect(JSON.stringify(result)).not.toMatch(/SECRET_TOKEN_\d/);
});

test("rejects a non-function scanAndRedact", () => {
  expect(() => maskLogValueWith(null as unknown as ScanAndRedact, {})).toThrow(TypeError);
});

test("preserves prototype-named JSON keys as redacted own data", () => {
  const input = JSON.parse(
    '{"__proto__":{"value":"SECRET_TOKEN_1"},"constructor":"SECRET_TOKEN_2","toString":"SECRET_TOKEN_3"}',
  );
  const result = maskLogValueWith(fakeScanAndRedact, input) as Masked;
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.hasOwn(result, "__proto__")).toBe(true);
  expect(JSON.parse(JSON.stringify(result))).toEqual(
    JSON.parse('{"__proto__":{"value":"<SECRET_1>"},"constructor":"<SECRET_1>","toString":"<SECRET_1>"}'),
  );
  expect(Object.getOwnPropertyDescriptor(input, "__proto__")?.value.value).toBe("SECRET_TOKEN_1");
});

test("preserves an Error's own __proto__ data without changing the output prototype", () => {
  const error = new Error("ordinary message");
  Object.defineProperty(error, "__proto__", { value: { detail: "SECRET_TOKEN_1" }, enumerable: true });
  const result = maskLogValueWith(fakeScanAndRedact, error) as Masked;
  expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
  expect(Object.hasOwn(result, "__proto__")).toBe(true);
  expect(Object.getOwnPropertyDescriptor(result, "__proto__")?.value).toEqual({ detail: "<SECRET_1>" });
});
