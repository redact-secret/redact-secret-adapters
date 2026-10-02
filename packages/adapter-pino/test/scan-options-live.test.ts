/**
 * The verified scan options through a real pino logger and the real core
 * (redact-secret-adapters#175): both hooks scan with the same snapshot of the
 * ruleset, formatter, ceilings and policy, on the bytes pino writes. CI runs
 * this at both ends of the declared core and pino ranges.
 */

import { CoreOptionsError } from "@redact-secret/adapter";
import pino from "pino";
import { expect, test } from "vitest";

import { BROKEN_RULESET, SYNTHETIC_RULESET, SYNTHETIC_TOKEN } from "../../../fixtures/scan-options.js";
import { createRedactingHooks, createRedactingLogMethod, createRedactingStreamWrite } from "../src/index.js";

const redact = { evaluate: () => "redact" as const };

async function logger(options: Parameters<typeof createRedactingHooks>[0], loggerOptions: pino.LoggerOptions = {}) {
  const chunks: string[] = [];
  const instance = pino(
    { base: null, timestamp: false, hooks: await createRedactingHooks(options), ...loggerOptions },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  return { instance, raw: () => chunks.join(""), lines: () => chunks.map((chunk) => JSON.parse(chunk)) };
}

test("a ruleset, a formatter and a policy apply on call arguments, child bindings and mixin output", async () => {
  const { instance, lines, raw } = await logger(
    {
      ruleset: SYNTHETIC_RULESET,
      policy: redact,
      placeholderFormatter: (finding, context) => `[${finding.type}#${context.placeholderIndex}]`,
    },
    { mixin: () => ({ mixed: SYNTHETIC_TOKEN }) },
  );
  instance.child({ bound: SYNTHETIC_TOKEN }).info({ field: SYNTHETIC_TOKEN }, `message ${SYNTHETIC_TOKEN}`);
  expect(raw()).not.toContain(SYNTHETIC_TOKEN);
  const [line] = lines();
  expect(line.field).toMatch(/^\[[a-z_-]+#1\]$/);
  expect(line.bound).toMatch(/^\[[a-z_-]+#1\]$/);
  expect(line.mixed).toMatch(/^\[[a-z_-]+#1\]$/);
  expect(line.msg).toMatch(/^message \[[a-z_-]+#1\]$/);
});

test("policy precedence: by default the core only warns on a ruleset finding; block replaces the whole value", async () => {
  const byDefault = await logger({ ruleset: SYNTHETIC_RULESET });
  byDefault.instance.info({ field: SYNTHETIC_TOKEN });
  expect(byDefault.lines()[0].field).toBe(SYNTHETIC_TOKEN);
  const blocking = await logger({ ruleset: SYNTHETIC_RULESET, policy: { evaluate: () => "block" } });
  blocking.instance.info({ field: SYNTHETIC_TOKEN });
  expect(blocking.lines()[0].field).toBe("[REDACTED:BLOCKED]");
});

test("scanLimits are the core's per-scan ceilings: a value past them is the error marker on the final line too", async () => {
  const { instance, lines, raw } = await logger({ scanLimits: { maxInputBytes: 64, maxFindings: 2 } });
  instance.info({ big: "z".repeat(200) }, "ok");
  expect(raw()).not.toContain("zzzz");
  expect(lines()[0].big).toBe("[REDACTED:ERROR]");
});

test("the single-hook live factories take the options too", async () => {
  const chunks: string[] = [];
  const options = { ruleset: SYNTHETIC_RULESET, policy: redact };
  const logMethod = await createRedactingLogMethod(options);
  const streamWrite = await createRedactingStreamWrite(options);
  const sink = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  pino({ base: null, timestamp: false, hooks: { logMethod } }, sink).info({ a: SYNTHETIC_TOKEN });
  pino({ base: null, timestamp: false, hooks: { streamWrite } }, sink).info({ a: SYNTHETIC_TOKEN });
  expect(chunks.join("")).not.toContain(SYNTHETIC_TOKEN);
  expect(chunks).toHaveLength(2);
});

test("a ruleset the core rejects fails construction with a fixed error, from every live factory", async () => {
  for (const factory of [createRedactingHooks, createRedactingLogMethod, createRedactingStreamWrite]) {
    const error = await factory({ ruleset: BROKEN_RULESET }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CoreOptionsError);
    expect(JSON.stringify({ message: (error as Error).message, ...(error as object) })).not.toContain(
      "SYNTHETIC-BROKEN-RULESET-MARKER",
    );
  }
});

test("a malformed option is a TypeError before the core loads", async () => {
  await expect(createRedactingHooks({ placeholderFormatter: "nope" as never })).rejects.toBeInstanceOf(TypeError);
});
