/**
 * One outcome per log record, against a real pino logger
 * (redact-secret/redact-secret-adapters#45): the counts are per record and
 * summed across both hooks rather than double counted, a record the adapter
 * had to replace says so, and an observer can neither leak input nor change
 * what is written.
 */

import pino from "pino";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { createRedactingHooksWith, type PinoLogOutcome, type RedactingHooksOptions } from "../src/index.js";

function observedLogger(
  options: Omit<RedactingHooksOptions, "onOutcome"> = {},
  loggerOptions: pino.LoggerOptions = {},
) {
  const outcomes: PinoLogOutcome[] = [];
  const chunks: string[] = [];
  const logger = pino(
    {
      base: null,
      timestamp: false,
      hooks: createRedactingHooksWith(fakeScanAndRedact, {
        ...options,
        onOutcome: (outcome) => outcomes.push(outcome),
      }),
      ...loggerOptions,
    },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  return { logger, outcomes, raw: () => chunks.join("") };
}

test("a record with no secret reports one outcome naming both stages", () => {
  const { logger, outcomes } = observedLogger();
  logger.info("user %s logged in", "alice");

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({
    host: "pino",
    unit: "log-record",
    level: 30,
    stages: ["log-method", "stream-write"],
    lineReplaced: false,
  });
  // `logMethod` scanned the joined message; `streamWrite` scanned the one
  // string value in the line. Two leaves, no finding.
  expect(outcomes[0]?.values).toEqual({
    scanned: 2,
    findings: 0,
    redacted: 0,
    blocked: 0,
    limited: 0,
    failed: 0,
  });
});

test("one secret in the message is one record, not two, even though both hooks see it", () => {
  const { logger, outcomes, raw } = observedLogger();
  logger.info("token is %s", "SECRET_TOKEN_1");

  expect(raw()).not.toContain("SECRET_TOKEN_1");
  expect(outcomes).toHaveLength(1);
  // `logMethod` redacts the message; `streamWrite` then re-scans the already
  // masked line and finds nothing. One record, one redaction, two scans.
  expect(outcomes[0]?.values.redacted).toBe(1);
  expect(outcomes[0]?.values.findings).toBe(1);
  expect(outcomes[0]?.values.scanned).toBe(2);
});

test("a secret only streamWrite can see is still reported on that record", () => {
  const { logger, outcomes, raw } = observedLogger();
  logger.child({ session: "SECRET_TOKEN_2" }).info("plain");

  expect(raw()).not.toContain("SECRET_TOKEN_2");
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.stages).toEqual(["log-method", "stream-write"]);
  expect(outcomes[0]?.values.redacted).toBe(1);
});

test("every record gets exactly one outcome, in order, with its own level", () => {
  const { logger, outcomes } = observedLogger();
  logger.info("one");
  logger.warn("two");
  logger.error("three");

  expect(outcomes.map((outcome) => outcome.level)).toEqual([30, 40, 50]);
  expect(outcomes).toHaveLength(3);
});

test("a blocked value is counted as blocked on the record that carried it", () => {
  const { logger, outcomes, raw } = observedLogger();
  logger.info("BLOCK_ME");

  expect(raw()).toContain("[REDACTED:BLOCKED]");
  expect(outcomes[0]?.values.blocked).toBe(1);
  expect(outcomes[0]?.values.redacted).toBe(0);
});

test("a limit counts as limited and never as scanned", () => {
  const { logger, outcomes } = observedLogger({ limits: { maxStringLength: 4 } });
  logger.info({ note: "a long value" }, "hi");

  expect(outcomes[0]?.values.limited).toBeGreaterThan(0);
});

test("a scanner error counts as failed and the line still carries the marker", () => {
  const { logger, outcomes, raw } = observedLogger();
  logger.info("BOOM");

  expect(raw()).toContain("[REDACTED:ERROR]");
  expect(outcomes[0]?.values.failed).toBeGreaterThan(0);
});

test("a line the streamWrite hook could not lex is reported as lineReplaced", () => {
  // A host streamWrite that returns an unterminable line: ours cannot lex it,
  // so it writes the fixed error line instead of passing it through.
  const { logger, outcomes, raw } = observedLogger({
    hooks: { streamWrite: () => '{"msg":"unterminated' },
  });
  logger.info("hello");

  expect(raw()).toBe('{"msg":"[REDACTED:ERROR]"}');
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.lineReplaced).toBe(true);
  expect(outcomes[0]?.values.failed).toBe(1);
});

test("an observer that throws changes neither the line nor the next record", () => {
  const chunks: string[] = [];
  const logger = pino(
    {
      base: null,
      timestamp: false,
      hooks: createRedactingHooksWith(fakeScanAndRedact, {
        onOutcome: () => {
          throw new Error("observer failed");
        },
      }),
    },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  expect(() => logger.info("token is %s", "SECRET_TOKEN_1")).not.toThrow();
  expect(() => logger.info("second")).not.toThrow();
  expect(chunks.join("")).not.toContain("SECRET_TOKEN_1");
  expect(chunks.join("")).toContain("<SECRET_1>");
});

test("an observer that logs through the same logger does not recurse", () => {
  const chunks: string[] = [];
  let observed = 0;
  const logger: pino.Logger = pino(
    {
      base: null,
      timestamp: false,
      hooks: createRedactingHooksWith(fakeScanAndRedact, {
        onOutcome: () => {
          observed += 1;
          // Re-enters the whole hook path. The guard makes the nested record
          // produce no outcome of its own rather than recursing forever.
          logger.warn("observer says hello");
        },
      }),
    },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  logger.info("first");

  // One outcome for the original record; the nested one is not reported.
  expect(observed).toBe(1);
  expect(chunks.join("")).toContain("observer says hello");
});

test("an outcome carries no value, key, marker or message text", () => {
  const { logger, outcomes } = observedLogger();
  logger.info({ apiKey: "SECRET_TOKEN_1" }, "BLOCK_ME");

  const serialized = JSON.stringify(outcomes);
  for (const text of ["SECRET_TOKEN_1", "BLOCK_ME", "apiKey", "<SECRET_1>", "REDACTED"]) {
    expect(serialized).not.toContain(text);
  }
  expect(Object.keys(outcomes[0] ?? {}).sort()).toEqual(["host", "level", "lineReplaced", "stages", "unit", "values"]);
});

test("concurrent loggers sharing nothing report their own records only", () => {
  const first = observedLogger();
  const second = observedLogger();
  first.logger.info("SECRET_TOKEN_1");
  second.logger.info("plain");
  first.logger.info("plain");

  expect(first.outcomes).toHaveLength(2);
  expect(second.outcomes).toHaveLength(1);
  expect(first.outcomes[0]?.values.redacted).toBe(1);
  expect(second.outcomes[0]?.values.redacted).toBe(0);
});

test("a record a host logMethod drops before redaction is not reported at all", () => {
  // The host's hook runs first, so a record it never passes on is one this
  // adapter never saw. Reporting an all-zero outcome for it would claim
  // knowledge the adapter does not have.
  const { logger, outcomes, raw } = observedLogger({
    hooks: {
      logMethod() {
        // `method` is never called: no redaction, no line.
      },
    },
  });
  logger.info("SECRET_TOKEN_1");

  expect(raw()).toBe("");
  expect(outcomes).toEqual([]);
});

test("a destination that fails after masking still reports one outcome, and does not claim a delivery", () => {
  const outcomes: PinoLogOutcome[] = [];
  const logger = pino(
    {
      base: null,
      timestamp: false,
      hooks: createRedactingHooksWith(fakeScanAndRedact, { onOutcome: (outcome) => outcomes.push(outcome) }),
    },
    {
      write() {
        // A destination that fails after the record was masked.
        throw new Error("destination unavailable");
      },
    },
  );
  expect(() => logger.info("SECRET_TOKEN_1")).toThrow();

  // `streamWrite` runs before `stream.write`, so both stages did their work;
  // `lineReplaced` is false because this adapter's own masking succeeded. That
  // the destination then threw is not something the outcome reports — an
  // adapter that claimed "delivered" here would be wrong.
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.stages).toEqual(["log-method", "stream-write"]);
  expect(outcomes[0]?.values.redacted).toBe(1);
  expect(outcomes[0]?.lineReplaced).toBe(false);
});

test("without onOutcome the hooks are the plain pair and nothing is observed", () => {
  const hooks = createRedactingHooksWith(fakeScanAndRedact);
  expect(Object.keys(hooks).sort()).toEqual(["logMethod", "streamWrite"]);
});

test("a non-function onOutcome is an explicit TypeError", () => {
  expect(() => createRedactingHooksWith(fakeScanAndRedact, { onOutcome: "nope" as unknown as undefined })).toThrow(
    TypeError,
  );
});
