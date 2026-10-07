import type { ScanAndRedact } from "@redact-secret/adapter";
import { createOutcomeCounter, ERROR_MARKER, LIMIT_MARKER } from "@redact-secret/adapter";
import pino from "pino";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import {
  createRedactingHooksWith,
  createRedactingStreamWriteWith,
  PINO_ERROR_LINE,
  type PinoLogOutcome,
} from "../src/index.js";

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

test("an object key is never scanned on its own or rewritten; it is only context for its value", () => {
  const seen: string[] = [];
  const spy: ScanAndRedact = (text) => {
    seen.push(text);
    return { text, findings: [] };
  };
  const out = createRedactingStreamWriteWith(spy)('{"SECRET_TOKEN_1" : "value"}');
  expect(out).toBe('{"SECRET_TOKEN_1" : "value"}');
  expect(seen).toEqual(["value", '{"SECRET_TOKEN_1":"value"}']);
});

test("a key the core would redact in a value's key context cannot be rewritten: the value is blocked, the key kept", () => {
  const out = createRedactingStreamWriteWith(fakeScanAndRedact)('{"SECRET_TOKEN_1" : "value"}');
  expect(out).toBe('{"SECRET_TOKEN_1" : "[REDACTED:BLOCKED]"}');
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

test("maxDepth 0 refuses the whole walk: the line becomes PINO_ERROR_LINE, never a partial rewrite", () => {
  const counter = createOutcomeCounter();
  const limited = createRedactingStreamWriteWith(fakeScanAndRedact, { limits: { maxDepth: 0 }, counter });
  expect(limited('{"level":30,"msg":"SECRET_TOKEN_1"}\n')).toBe(`${PINO_ERROR_LINE}\n`);
  expect(counter.failed).toBe(1);
  const uncounted = createRedactingStreamWriteWith(fakeScanAndRedact, { limits: { maxDepth: 0 } });
  expect(uncounted('{"msg":"x"}')).toBe(PINO_ERROR_LINE);
});

test("values past maxArrayLength become the limit marker and are counted as limited", () => {
  const line = '{"a":"x","b":"SECRET_TOKEN_1"}';
  const expected = `{"a":"x","b":${JSON.stringify(LIMIT_MARKER)}}`;
  const counter = createOutcomeCounter();
  const limited = createRedactingStreamWriteWith(fakeScanAndRedact, { limits: { maxArrayLength: 1 }, counter });
  expect(limited(line)).toBe(expected);
  expect(counter.limited).toBe(1);
  // Without a counter the value is still refused, and the line is not failed.
  expect(createRedactingStreamWriteWith(fakeScanAndRedact, { limits: { maxArrayLength: 1 } })(line)).toBe(expected);
});

test("an unchanged value keeps its original escapes byte for byte", () => {
  const line = '{"url":"a\\/b","e":"caf\\u00e9"}';
  expect(streamWrite(line)).toBe(line);
});

// redact-secret-adapters#198: text outside any string literal was never read,
// so a line that is not valid JSON was forwarded with it unmasked and
// unflagged. Every token is synthetic; no assertion prints one.
const NON_JSON_LINES: Record<string, string> = {
  "an unterminated object followed by a token": '{"level":30,"msg":"ok", SECRET_TOKEN_1 \n',
  "a token outside any string": '{"level":30,"msg":"ok" SECRET_TOKEN_1}\n',
  "trailing garbage after a complete object": '{"level":30,"msg":"ok"} SECRET_TOKEN_1\n',
  "a plain-text line": "plain SECRET_TOKEN_1\n",
  "an unterminated object whose strings are fine": '{"level":30,"msg":"SECRET_TOKEN_1"\n',
};

test.each(Object.entries(NON_JSON_LINES))("%s is replaced by the fixed error line, never forwarded", (_name, input) => {
  const counter = createOutcomeCounter();
  const out = createRedactingStreamWriteWith(fakeScanAndRedact, { counter })(input);
  expect(out).toBe(`${PINO_ERROR_LINE}\n`);
  expect(JSON.parse(out)).toEqual({ msg: ERROR_MARKER });
  expect(out).not.toContain("SECRET_TOKEN");
  expect(counter.failed).toBe(1);
  expect(counter.limited).toBe(0);
});

test("a non-JSON line without a trailing newline gets the fixed line without one", () => {
  expect(streamWrite('{"msg":"ok" SECRET_TOKEN_1')).toBe(PINO_ERROR_LINE);
});

test("through real pino, a host hook that emits non-JSON is refused and reported as a replaced line", () => {
  const chunks: string[] = [];
  const outcomes: PinoLogOutcome[] = [];
  const hooks = createRedactingHooksWith(fakeScanAndRedact, {
    hooks: { streamWrite: () => '{"level":30,"msg":"ok", SECRET_TOKEN_1 \n' },
    onOutcome: (o) => outcomes.push(o),
  });
  const logger = pino(
    { base: null, timestamp: false, hooks },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  logger.info("hello");
  expect(chunks).toEqual([`${PINO_ERROR_LINE}\n`]);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ lineReplaced: true });
  expect(outcomes[0]?.values.failed).toBeGreaterThanOrEqual(1);
  expect(JSON.stringify(outcomes)).not.toContain("SECRET_TOKEN");
});

test("valid JSON that is not an object, and whitespace around a valid line, is still handled", () => {
  expect(streamWrite('  {"msg":"SECRET_TOKEN_1"}  \n')).toBe('  {"msg":"<SECRET_1>"}  \n');
  expect(streamWrite('"SECRET_TOKEN_1"\n')).toBe('"<SECRET_1>"\n');
});
