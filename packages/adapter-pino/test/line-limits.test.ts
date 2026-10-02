/**
 * The pre-processing ceilings on `hooks.streamWrite`
 * (redact-secret-adapters#174): an oversized or pathological line is refused
 * before anything proportional to it is allocated, as a fixed valid JSON line
 * that keeps the original's newline, never as the original. Every value is
 * synthetic.
 */

import type { ScanAndRedact } from "@redact-secret/adapter";
import { createOutcomeCounter, LIMIT_MARKER } from "@redact-secret/adapter";
import pino from "pino";
import { afterEach, expect, test, vi } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import {
  createRedactingHooksWith,
  createRedactingStreamWriteWith,
  DEFAULT_LINE_LIMITS,
  PINO_ERROR_LINE,
  PINO_LIMIT_LINE,
  type PinoLogOutcome,
} from "../src/index.js";

afterEach(() => vi.restoreAllMocks());

function spyScanner() {
  const seen: string[] = [];
  const scan: ScanAndRedact = (text) => {
    seen.push(text);
    return fakeScanAndRedact(text);
  };
  return { scan, seen };
}

const line = (value: string, key = "k") => `${JSON.stringify({ level: 30, [key]: value })}\n`;

test("the documented defaults are frozen and public", () => {
  expect(DEFAULT_LINE_LIMITS).toEqual({ maxLineLength: 4_194_304, maxValueSpans: 20_000, maxDecodeLength: 2_097_152 });
  expect(Object.isFrozen(DEFAULT_LINE_LIMITS)).toBe(true);
  expect(PINO_LIMIT_LINE).toBe('{"msg":"[REDACTED:LIMIT_EXCEEDED]"}');
});

test("a line longer than maxLineLength is refused before it is lexed, decoded or scanned", () => {
  const { scan, seen } = spyScanner();
  const parse = vi.spyOn(JSON, "parse");
  const write = createRedactingStreamWriteWith(scan, { lineLimits: { maxLineLength: 100 } });
  const huge = line("x".repeat(500));
  expect(write(huge)).toBe(`${PINO_LIMIT_LINE}\n`);
  expect(seen).toEqual([]);
  expect(parse).not.toHaveBeenCalled();
});

test("the line-length boundary is exact: equal is accepted, one more is refused", () => {
  const { scan } = spyScanner();
  const exact = line("hello");
  const at = createRedactingStreamWriteWith(scan, { lineLimits: { maxLineLength: exact.length } });
  expect(at(exact)).toBe(exact);
  const below = createRedactingStreamWriteWith(scan, { lineLimits: { maxLineLength: exact.length - 1 } });
  expect(below(exact)).toBe(`${PINO_LIMIT_LINE}\n`);
});

test("many tiny literals are refused as soon as the span ceiling is met, before any is decoded", () => {
  const { scan, seen } = spyScanner();
  const parse = vi.spyOn(JSON, "parse");
  const write = createRedactingStreamWriteWith(scan, { lineLimits: { maxValueSpans: 50 } });
  const many = `${JSON.stringify({ level: 30, a: Array.from({ length: 51 }, () => "x") })}\n`;
  expect(write(many)).toBe(`${PINO_LIMIT_LINE}\n`);
  expect(parse).not.toHaveBeenCalled();
  expect(seen).toEqual([]);
  // Exactly the ceiling is accepted.
  const exact = `${JSON.stringify({ level: 30, a: Array.from({ length: 50 }, () => "x") })}\n`;
  expect(write(exact)).toBe(exact);
});

test("object keys are not counted as value spans", () => {
  const { scan } = spyScanner();
  const write = createRedactingStreamWriteWith(scan, { lineLimits: { maxValueSpans: 1 } });
  const keys = `${JSON.stringify({ a: 1, b: 2, c: 3, d: "x" })}\n`;
  expect(write(keys)).toBe(keys);
});

test("cumulative decoding work is bounded: long escape sequences in a few literals", () => {
  const { scan, seen } = spyScanner();
  const parse = vi.spyOn(JSON, "parse");
  const escapes = "\\u00e9\\n\\t\\\\".repeat(200);
  const raw = `{"level":30,"a":"${escapes}","b":"${escapes}"}\n`;
  // Each literal is its quotes plus the escapes, and counts with the 3-unit key it sits under.
  const work = (escapes.length + 2 + 3) * 2;
  const write = createRedactingStreamWriteWith(scan, { lineLimits: { maxDecodeLength: work - 1 } });
  expect(write(raw)).toBe(`${PINO_LIMIT_LINE}\n`);
  expect(parse).not.toHaveBeenCalled();
  expect(seen).toEqual([]);
  const ok = createRedactingStreamWriteWith(scan, { lineLimits: { maxDecodeLength: work } });
  expect(JSON.parse(ok(raw))).toMatchObject({ level: 30 });
});

test("the key literal a value sits under counts toward the decoding work", () => {
  const { scan } = spyScanner();
  const key = "k".repeat(100);
  const raw = line("v", key);
  const decode = `"${key}"`.length + `"v"`.length;
  expect(createRedactingStreamWriteWith(scan, { lineLimits: { maxDecodeLength: decode } })(raw)).toBe(raw);
  expect(createRedactingStreamWriteWith(scan, { lineLimits: { maxDecodeLength: decode - 1 } })(raw)).toBe(
    `${PINO_LIMIT_LINE}\n`,
  );
});

test("malformed and unterminated strings are the error line, not the limit line, and never the original", () => {
  const { scan } = spyScanner();
  const write = createRedactingStreamWriteWith(scan);
  for (const bad of ['{"level":30,"msg":"unterminated', '{"a":"b\\"', '{"a":"\\uZZZZ"}', '{"a":"\\x"}']) {
    expect(write(bad)).toBe(PINO_ERROR_LINE);
    expect(write(`${bad}\n`)).toBe(`${PINO_ERROR_LINE}\n`);
  }
});

test("an oversized unterminated line is a limit refusal: the ceiling is checked first", () => {
  const write = createRedactingStreamWriteWith(fakeScanAndRedact, { lineLimits: { maxLineLength: 10 } });
  expect(write('{"msg":"never closed')).toBe(PINO_LIMIT_LINE);
});

test("Unicode and nested JSON within the ceilings are masked as before; the ceiling counts code units", () => {
  const { scan } = spyScanner();
  const nested = `${JSON.stringify({ level: 30, a: { b: [{ c: "SECRET_TOKEN_1 한국어 😀" }] } })}\n`;
  const write = createRedactingStreamWriteWith(scan);
  expect(JSON.parse(write(nested))).toEqual({ level: 30, a: { b: [{ c: "<SECRET_1> 한국어 😀" }] } });
  // 😀 is two UTF-16 code units: the ceiling is in code units, not code points or bytes.
  const emoji = line("😀");
  const exact = createRedactingStreamWriteWith(scan, { lineLimits: { maxLineLength: emoji.length } });
  expect(exact(emoji)).toBe(emoji);
  expect(emoji.length).toBeLessThan(Buffer.byteLength(emoji));
});

test("the newline is preserved, or absent, exactly as the original's", () => {
  const write = createRedactingStreamWriteWith(fakeScanAndRedact, { lineLimits: { maxLineLength: 5 } });
  expect(write("x".repeat(20))).toBe(PINO_LIMIT_LINE);
  expect(write(`${"x".repeat(20)}\n`)).toBe(`${PINO_LIMIT_LINE}\n`);
});

test("a counter reports a ceiling refusal as one limited value and a lex failure as one failed value", () => {
  const counter = createOutcomeCounter();
  const write = createRedactingStreamWriteWith(fakeScanAndRedact, { counter, lineLimits: { maxLineLength: 30 } });
  write(`${"x".repeat(40)}\n`);
  expect(counter).toMatchObject({ limited: 1, failed: 0 });
  write('{"a":"unterminated');
  expect(counter).toMatchObject({ limited: 1, failed: 1 });
});

test("unusable overrides fall back to the defaults, and a non-object is rejected", () => {
  const write = createRedactingStreamWriteWith(fakeScanAndRedact, {
    lineLimits: { maxLineLength: Number.NaN, maxValueSpans: -1, maxDecodeLength: "9" as never },
  });
  const raw = line("hello");
  expect(write(raw)).toBe(raw);
  expect(() => createRedactingStreamWriteWith(fakeScanAndRedact, { lineLimits: 5 as never })).toThrow(TypeError);
  expect(() => createRedactingStreamWriteWith(fakeScanAndRedact, { lineLimits: null as never })).toThrow(TypeError);
});

test("both hooks stay: a real pino logger refuses an oversized line on the destination bytes and reports it accurately", () => {
  const outcomes: PinoLogOutcome[] = [];
  const chunks: string[] = [];
  const logger = pino(
    {
      base: null,
      timestamp: false,
      hooks: createRedactingHooksWith(fakeScanAndRedact, {
        lineLimits: { maxLineLength: 80 },
        onOutcome: (outcome) => outcomes.push(outcome),
      }),
    },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  logger.info("short");
  logger.info({ blob: "SECRET_TOKEN_1".repeat(20) }, "long");
  expect(chunks[0]).toBe('{"level":30,"msg":"short"}\n');
  expect(chunks[1]).toBe(`${PINO_LIMIT_LINE}\n`);
  expect(chunks.join("")).not.toContain("SECRET_TOKEN");
  expect(outcomes.map((outcome) => outcome.lineReplaced)).toEqual([false, true]);
  expect(outcomes[1]?.stages).toEqual(["log-method", "stream-write"]);
  expect(outcomes[1]?.values.limited).toBe(1);
  expect(outcomes[1]?.values.failed).toBe(0);
});

test("a host streamWrite that adds fields has them counted toward the ceiling, since redaction runs last", () => {
  const hooks = createRedactingHooksWith(fakeScanAndRedact, {
    lineLimits: { maxLineLength: 60 },
    hooks: { streamWrite: (raw: string) => `${raw.trimEnd().slice(0, -1)},"extra":"${"y".repeat(100)}"}\n` },
  });
  expect(hooks.streamWrite('{"level":30,"msg":"hi"}\n')).toBe(`${PINO_LIMIT_LINE}\n`);
});

test("a refused line never calls a user serialization hook: only the finished string is read", () => {
  const touched = vi.fn();
  const trap = new String('{"level":30,"msg":"x"}\n') as unknown as string;
  Object.defineProperty(trap, "toJSON", { get: touched });
  const write = createRedactingStreamWriteWith(fakeScanAndRedact, { lineLimits: { maxLineLength: 5 } });
  // A non-string line cannot be measured safely; it is the error line, never forwarded.
  expect(write(trap)).toContain("REDACTED");
  expect(touched).not.toHaveBeenCalled();
  expect(LIMIT_MARKER).toBe("[REDACTED:LIMIT_EXCEEDED]");
});

test("the live factories take lineLimits and mask a real secret within them", async () => {
  const { createRedactingHooks, createRedactingStreamWrite } = await import("../src/index.js");
  const token = `ghp_${"x".repeat(36)}`;
  const write = await createRedactingStreamWrite({ lineLimits: { maxLineLength: 200 } });
  expect(JSON.parse(write(`${JSON.stringify({ level: 30, msg: `t ${token}` })}\n`)).msg).toBe("t <SECRET_1>");
  expect(write(`${JSON.stringify({ level: 30, msg: token.repeat(10) })}\n`)).toBe(`${PINO_LIMIT_LINE}\n`);
  const hooks = await createRedactingHooks({ lineLimits: { maxLineLength: 20 } });
  expect(hooks.streamWrite(`${JSON.stringify({ level: 30, msg: token })}\n`)).toBe(`${PINO_LIMIT_LINE}\n`);
});
