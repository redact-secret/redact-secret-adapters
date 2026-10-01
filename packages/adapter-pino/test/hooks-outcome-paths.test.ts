/**
 * The outcome-reporting paths a real pino logger rarely takes (#145): a line
 * with no `logMethod` pass in flight, a record that never reaches
 * `streamWrite`, the re-entrancy guard, and the factory's argument checks.
 * Synthetic values only.
 */

import { createOutcomeCounter } from "@redact-secret/adapter";
import pino from "pino";
import { expect, test } from "vitest";
import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";

import {
  createRedactingHooksWith,
  PINO_ERROR_LINE,
  type PinoLogOutcome,
  type RedactingHooksOptions,
} from "../src/index.js";

function observedHooks(options: Omit<RedactingHooksOptions, "onOutcome"> = {}) {
  const outcomes: PinoLogOutcome[] = [];
  const hooks = createRedactingHooksWith(fakeScanAndRedact, { ...options, onOutcome: (o) => outcomes.push(o) });
  return { hooks, outcomes };
}

test("a bare streamWrite reports one level-less orphan outcome with its values counted", () => {
  const { hooks, outcomes } = observedHooks();
  const out = hooks.streamWrite('{"msg":"SECRET_TOKEN_7"}\n');

  expect(out).not.toContain("SECRET_TOKEN_7");
  expect(outcomes).toHaveLength(1);
  const outcome = outcomes[0] as PinoLogOutcome;
  expect(outcome).not.toHaveProperty("level");
  expect(outcome).toMatchObject({ host: "pino", unit: "log-record", stages: ["stream-write"], lineReplaced: false });
  expect(outcome.values).toEqual({ scanned: 1, findings: 1, redacted: 1, blocked: 0, limited: 0, failed: 0 });
  expect(Object.isFrozen(outcome.stages)).toBe(true);
});

test("an orphan line the walk replaces reports lineReplaced and returns PINO_ERROR_LINE", () => {
  const { hooks, outcomes } = observedHooks({ limits: { maxDepth: 0 } });
  const out = hooks.streamWrite('{"a":{"b":"x"}}');

  expect(out).toBe(PINO_ERROR_LINE);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.lineReplaced).toBe(true);
  expect(outcomes[0]?.values.failed).toBe(1);
});

test("a newline-terminated orphan line that is replaced reports lineReplaced", () => {
  const { hooks, outcomes } = observedHooks({ limits: { maxDepth: 0 } });
  const out = hooks.streamWrite('{"a":{"b":"x"}}\n');

  expect(out).toBe(`${PINO_ERROR_LINE}\n`);
  expect(outcomes[0]?.lineReplaced).toBe(true);
});

test("a caller counter rises by the orphan line's counts", () => {
  const counter = createOutcomeCounter();
  const { hooks } = observedHooks({ counter });
  hooks.streamWrite('{"msg":"SECRET_TOKEN_7"}');
  hooks.streamWrite('{"msg":"SECRET_TOKEN_7"}');

  expect(counter).toMatchObject({ scanned: 2, findings: 2, redacted: 2, failed: 0 });
});

test("an observer that calls streamWrite for an orphan line gets one report, no recursion", () => {
  const outcomes: PinoLogOutcome[] = [];
  const hooks: ReturnType<typeof createRedactingHooksWith> = createRedactingHooksWith(fakeScanAndRedact, {
    onOutcome: (outcome) => {
      outcomes.push(outcome);
      hooks.streamWrite('{"msg":"nested"}');
    },
  });
  hooks.streamWrite('{"msg":"first"}');

  expect(outcomes).toHaveLength(1);
});

test("the orphan re-entrancy guard is released after each report", () => {
  const { hooks, outcomes } = observedHooks();
  hooks.streamWrite('{"msg":"one"}');
  hooks.streamWrite('{"msg":"two"}');

  expect(outcomes).toHaveLength(2);
});

test("a newline-terminated line replaced during a record reports lineReplaced", () => {
  const { hooks, outcomes } = observedHooks({ hooks: { streamWrite: () => '{"msg":"unterminated\n' } });
  const logger = pino({ base: null, timestamp: false, hooks }, { write: () => true });
  logger.info("hello");

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.lineReplaced).toBe(true);
  expect(outcomes[0]?.level).toBe(30);
});

test("a record that never reaches streamWrite is reported once, not replaced, with counts on the caller counter", () => {
  const counter = createOutcomeCounter();
  const { hooks, outcomes } = observedHooks({ counter });
  hooks.logMethod.call({} as pino.Logger, ["SECRET_TOKEN_7"], () => undefined, 30);

  expect(outcomes).toHaveLength(1);
  const outcome = outcomes[0] as PinoLogOutcome;
  expect(outcome.lineReplaced).toBe(false);
  expect(outcome.level).toBe(30);
  expect(outcome.stages).toEqual(["log-method"]);
  expect(outcome.values.redacted).toBe(1);
  expect(counter.redacted).toBe(1);
  expect(counter.scanned).toBe(outcome.values.scanned);
});

test("factory argument errors carry their messages", () => {
  const build = (o: unknown) => () => createRedactingHooksWith(fakeScanAndRedact, o as RedactingHooksOptions);
  expect(build({ hooks: null })).toThrow(new TypeError("createRedactingHooksWith: hooks must be an object"));
  expect(build({ hooks: { logMethod: 1 } })).toThrow(
    new TypeError("createRedactingHooksWith: hooks.logMethod must be a function"),
  );
  expect(build({ hooks: { streamWrite: 1 } })).toThrow(
    new TypeError("createRedactingHooksWith: hooks.streamWrite must be a function"),
  );
  expect(build({ onOutcome: 1 })).toThrow(new TypeError("createRedactingHooksWith: onOutcome must be a function"));
});
