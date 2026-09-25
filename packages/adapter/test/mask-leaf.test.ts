import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import {
  BLOCK_MARKER,
  CYCLE_MARKER,
  DEFAULT_LIMITS,
  ERROR_MARKER,
  LIMIT_MARKER,
  maskLeafWith,
  type ScanAndRedact,
} from "../src/index.js";

test("the four markers and DEFAULT_LIMITS are the documented public API", () => {
  expect(BLOCK_MARKER).toBe("[REDACTED:BLOCKED]");
  expect(ERROR_MARKER).toBe("[REDACTED:ERROR]");
  expect(LIMIT_MARKER).toBe("[REDACTED:LIMIT_EXCEEDED]");
  expect(CYCLE_MARKER).toBe("[REDACTED:CYCLE]");
  expect(DEFAULT_LIMITS).toEqual({
    maxDepth: 8,
    maxArrayLength: 1000,
    maxObjectKeys: 200,
    maxStringLength: 200_000,
    maxTotalLeaves: 5000,
  });
  expect(Object.isFrozen(DEFAULT_LIMITS)).toBe(true);
});

test("redact, block, warn, and clean leaves", () => {
  expect(maskLeafWith(fakeScanAndRedact, "token SECRET_TOKEN_1 here")).toBe("token <SECRET_1> here");
  expect(maskLeafWith(fakeScanAndRedact, "prefix BLOCK_ME suffix")).toBe(BLOCK_MARKER);
  expect(maskLeafWith(fakeScanAndRedact, "WARN_ME stays")).toBe("WARN_ME stays");
  expect(maskLeafWith(fakeScanAndRedact, "nothing here")).toBe("nothing here");
});

test("a throwing core yields the error marker, never the message or the input", () => {
  const leaky: ScanAndRedact = (text) => {
    throw new Error(`cannot scan: ${text}`);
  };
  expect(maskLeafWith(leaky, "SECRET_TOKEN_1")).toBe(ERROR_MARKER);
});

test("a malformed scanner result fails closed instead of throwing or passing text through", () => {
  const results = [undefined, null, {}, { text: "SECRET_TOKEN_1" }, { text: 42, findings: [] }, { findings: [] }];
  for (const result of results) {
    const malformed = (() => result) as unknown as ScanAndRedact;
    expect(maskLeafWith(malformed, "SECRET_TOKEN_1"), JSON.stringify(result)).toBe(ERROR_MARKER);
  }
  const nullFinding = (() => ({ text: "ok", findings: [null] })) as unknown as ScanAndRedact;
  expect(maskLeafWith(nullFinding, "ok")).toBe("ok");
});

test("a leaf past maxStringLength is never sent to the core", () => {
  let called = false;
  const spy: ScanAndRedact = (text) => {
    called = true;
    return { text, findings: [] };
  };
  expect(maskLeafWith(spy, "a".repeat(11), { maxStringLength: 10 })).toBe(LIMIT_MARKER);
  expect(called).toBe(false);
});

test("rejects a non-string leaf", () => {
  expect(() => maskLeafWith(fakeScanAndRedact, 42 as unknown as string)).toThrow(TypeError);
});
