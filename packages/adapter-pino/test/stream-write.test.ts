import type { ScanAndRedact } from "@redact-secret/adapter";
import { ERROR_MARKER, LIMIT_MARKER } from "@redact-secret/adapter";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { createRedactingStreamWriteWith } from "../src/index.js";

const streamWrite = createRedactingStreamWriteWith(fakeScanAndRedact);

test("every string value in the line is masked; keys, numbers, and layout are kept byte for byte", () => {
  const line = '{"level":30,"session":"SECRET_TOKEN_1","nested":{"list":["ok","BLOCK_ME"],"n":1.50},"msg":"hi"}\n';
  expect(streamWrite(line)).toBe(
    '{"level":30,"session":"<SECRET_1>","nested":{"list":["ok","[REDACTED:BLOCKED]"],"n":1.50},"msg":"hi"}\n',
  );
});

test("escaped quotes and unicode escapes are decoded before scanning and re-encoded after", () => {
  const line = `${JSON.stringify({ msg: 'say "SECRET_TOKEN_1"', raw: "tab\there é" })}\n`;
  const out = streamWrite(line);
  expect(JSON.parse(out)).toEqual({ msg: 'say "<SECRET_1>"', raw: "tab\there é" });
});

test("an object key is never scanned or rewritten", () => {
  const seen: string[] = [];
  const spy: ScanAndRedact = (text) => {
    seen.push(text);
    return { text, findings: [] };
  };
  createRedactingStreamWriteWith(spy)('{"SECRET_TOKEN_1" : "value"}');
  expect(seen).toEqual(["value"]);
});

test("a scanner failure fails closed for that value only", () => {
  expect(JSON.parse(streamWrite('{"a":"trigger BOOM","b":"fine"}'))).toEqual({ a: ERROR_MARKER, b: "fine" });
});

test("values past the leaf budget become the limit marker, never plaintext", () => {
  const limited = createRedactingStreamWriteWith(fakeScanAndRedact, { limits: { maxTotalLeaves: 1 } });
  expect(JSON.parse(limited('{"a":"x","b":"SECRET_TOKEN_1"}'))).toEqual({ a: "x", b: LIMIT_MARKER });
});

test("an unparseable line is replaced, never written as is", () => {
  expect(streamWrite('{"msg":"SECRET_TOKEN_1\n')).toBe(`{"msg":"${ERROR_MARKER}"}\n`);
});

test("rejects a non-function scanAndRedact", () => {
  expect(() => createRedactingStreamWriteWith(null as unknown as ScanAndRedact)).toThrow(TypeError);
});
