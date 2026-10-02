/**
 * One aggregate budget per log record, shared by both pino hooks
 * (redact-secret-adapters#173), against a real pino logger. A fake scanner
 * counts the core calls so the bound is observable and deterministic.
 */

import { LIMIT_MARKER, type ScanAndRedact } from "@redact-secret/adapter";
import pino from "pino";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { createRedactingHooksWith, type PinoLogOutcome, type RedactingHooksOptions } from "../src/index.js";

function setup(options: RedactingHooksOptions = {}, loggerOptions: pino.LoggerOptions = {}) {
  const seen: string[] = [];
  const scan: ScanAndRedact = (text) => {
    seen.push(text);
    return fakeScanAndRedact(text);
  };
  const outcomes: PinoLogOutcome[] = [];
  const chunks: string[] = [];
  const logger = pino(
    {
      base: null,
      timestamp: false,
      hooks: createRedactingHooksWith(scan, { ...options, onOutcome: (outcome) => outcomes.push(outcome) }),
      ...loggerOptions,
    },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  return { logger, seen, outcomes, raw: () => chunks.join(""), lines: () => chunks.map((chunk) => JSON.parse(chunk)) };
}

test("the two hooks spend one budget per record: a scan bound covers logMethod and streamWrite together", () => {
  // `logMethod` scans the message (1 scan); `streamWrite` scans the line's
  // `msg` value, alone and in its key context (2 scans).
  const roomy = setup({ operationLimits: { maxScans: 3 } });
  roomy.logger.info("hello");
  expect(roomy.seen).toEqual(["hello", "hello", '{"msg":"hello"}']);
  expect(roomy.lines()).toEqual([{ level: 30, msg: "hello" }]);

  const tight = setup({ operationLimits: { maxScans: 1 } });
  tight.logger.info("hello");
  // The first pass spent the budget, so the second pass inspects nothing and
  // the line carries a marker, never a value it did not scan.
  expect(tight.seen).toEqual(["hello"]);
  expect(tight.lines()).toEqual([{ level: 30, msg: LIMIT_MARKER }]);
  expect(tight.outcomes[0]?.values.limited).toBe(1);
});

test("a record spends its own budget: the next record starts from zero", () => {
  const { logger, lines } = setup({ operationLimits: { maxScans: 3 } });
  logger.info("one");
  logger.info("two");
  logger.info("three");
  expect(lines().map((line) => line.msg)).toEqual(["one", "two", "three"]);
});

test("many small fields in one record stop at the record's leaf bound and nothing unscanned reaches the line", () => {
  const fields = Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`f${index}`, `SECRET_TOKEN_${index}`]));
  const { logger, raw, seen } = setup({ operationLimits: { maxLeaves: 10 } });
  logger.info(fields, "m");
  expect(raw()).not.toContain("SECRET_TOKEN");
  expect(seen.length).toBeLessThanOrEqual(10);
  expect(raw()).toContain(LIMIT_MARKER);
  // The second pass found the budget spent: the whole line is the fixed limit line.
  expect(JSON.parse(raw())).toEqual({ msg: LIMIT_MARKER });
});

test("child bindings and mixin output share the record's budget on the final line", () => {
  const { logger, raw, lines } = setup(
    { operationLimits: { maxLeaves: 3 } },
    { mixin: () => ({ m1: "SECRET_TOKEN_1", m2: "SECRET_TOKEN_2" }) },
  );
  logger.child({ b1: "SECRET_TOKEN_3" }).info("msg");
  expect(raw()).not.toContain("SECRET_TOKEN");
  expect(lines()).toHaveLength(1);
  expect(raw()).toContain(LIMIT_MARKER);
});

test("a record logged from a getter during masking has its own budget and its own outcome", () => {
  const { logger, outcomes, lines } = setup({ operationLimits: { maxScans: 4 } });
  const inner = logger.child({});
  logger.info({
    get nested() {
      inner.info("inner");
      return "n";
    },
  });
  expect(outcomes).toHaveLength(2);
  expect(lines().map((line) => line.msg)).toEqual(["inner", undefined]);
});

test("the paired factory owns the unit: a caller-owned operation is rejected, not ignored", () => {
  expect(() => createRedactingHooksWith(fakeScanAndRedact, { operation: {} as never })).toThrow(TypeError);
});

test("callbacks expose no input when a record is over budget", () => {
  const { logger, outcomes } = setup({ operationLimits: { maxScans: 0 } });
  logger.info({ secret: "SECRET_TOKEN_1" }, "SECRET_TOKEN_2");
  expect(JSON.stringify(outcomes)).not.toContain("SECRET_TOKEN");
  expect(Object.keys(outcomes[0] ?? {}).sort()).toEqual(["host", "level", "lineReplaced", "stages", "unit", "values"]);
});
