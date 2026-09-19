import type { ScanAndRedact } from "@redact-secret/adapter";
import { BLOCK_MARKER, ERROR_MARKER } from "@redact-secret/adapter";
import type { LogFn, Logger } from "pino";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { createRedactingLogMethodWith, type RedactingLogMethod } from "../src/index.js";

interface Call {
  receiver: unknown;
  args: unknown[];
}

function spyMethod() {
  const calls: Call[] = [];
  function method(this: unknown, ...args: unknown[]) {
    calls.push({ receiver: this, args });
  }
  return { method: method as LogFn, calls };
}

/** Invokes the hook the way pino's `genLog` does: `hook.call(logger, args, method, level)`. */
function callHook(hook: RedactingLogMethod, receiver: object, args: unknown[], method: LogFn, level: number): void {
  hook.call(receiver as Logger, args as Parameters<LogFn>, method, level);
}

test("a secret in a plain string message is redacted", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  const logger = { name: "logger" };
  callHook(hook, logger, ["token is SECRET_TOKEN_1 here"], method, 30);
  expect(calls).toEqual([{ receiver: logger, args: ["token is <SECRET_1> here"] }]);
});

test("a secret in a merging-object string field is redacted alongside the message", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, [{ authHeader: "Bearer SECRET_TOKEN_1" }, "request received"], method, 30);
  expect(calls[0]?.args).toEqual([{ authHeader: "Bearer <SECRET_1>" }, "request received"]);
});

test("a secret in a printf-style interpolation value is redacted — msg and values joined into one scanned leaf, matching what pino itself would format", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["user %s presented %s", "alice", "SECRET_TOKEN_1"], method, 30);
  expect(calls[0]?.args).toEqual(["user alice presented <SECRET_1>"]);
});

test("issue #361: a secret split across the format string and an interpolation value is redacted — neither leaf alone matches", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["token is SECRET_TOKEN_%s", "1"], method, 30);
  expect(calls[0]?.args).toEqual(["token is <SECRET_1>"]);
});

test("issue #361: a secret split across two interpolation values is redacted", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["token is %s%s", "SECRET_TOKEN_", "1"], method, 30);
  expect(calls[0]?.args).toEqual(["token is <SECRET_1>"]);
});

test("issue #361: a contextual assignment split from its value across msg and an interpolation value is redacted", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["api_key=%s", "SECRET_TOKEN_1"], method, 30);
  expect(calls[0]?.args).toEqual(["api_key=<SECRET_1>"]);
});

test("issue #361: a joined message that trips a block finding replaces the whole message, not a partial value", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["prefix %s suffix", "BLOCK_ME"], method, 30);
  expect(calls[0]?.args).toEqual([BLOCK_MARKER]);
});

test("issue #361: a scanner failure on the joined message fails closed", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["trigger %s here", "BOOM"], method, 30);
  expect(calls[0]?.args).toEqual([ERROR_MARKER]);
});

test("issue #361: a merging object plus a split interpolated message are both redacted", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, [{ authHeader: "Bearer SECRET_TOKEN_1" }, "token is SECRET_TOKEN_%s", "2"], method, 30);
  expect(calls[0]?.args).toEqual([{ authHeader: "Bearer <SECRET_1>" }, "token is <SECRET_1>"]);
});

test("issue #361: an unused trailing interpolation value is dropped from the joined message, matching pino's own quick-format-unescaped, and its secret is still redacted", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["no placeholders here", "SECRET_TOKEN_1"], method, 30);
  expect(calls[0]?.args).toEqual(["no placeholders here"]);
});

test("issue #361: ordinary formatting with no secret is unaffected", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["user %s logged in from %s", "alice", "10.0.0.1"], method, 30);
  expect(calls[0]?.args).toEqual(["user alice logged in from 10.0.0.1"]);
});

test("a bare leading Error is normalized to { err }, message, ...rest — and both are redacted", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  const err = new Error("failed with SECRET_TOKEN_1");
  callHook(hook, {}, [err], method, 50);
  const [mergingObject, msg] = (calls[0]?.args ?? []) as [{ err: Record<string, unknown> }, string];
  expect(msg).toBe("failed with <SECRET_1>");
  expect(mergingObject.err.message).toBe("failed with <SECRET_1>");
  expect(typeof mergingObject.err.stack).toBe("string");
  expect(JSON.stringify(calls[0]?.args)).not.toContain("SECRET_TOKEN_1");
});

test("an Error nested inside a merging object is redacted before pino's own serializer sees it", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  const err = new Error("db write failed: SECRET_TOKEN_1");
  callHook(hook, {}, [{ err }, "query failed"], method, 50);
  const [mergingObject] = (calls[0]?.args ?? []) as [{ err: Record<string, unknown> }];
  expect(mergingObject.err.message).toBe("db write failed: <SECRET_1>");
  expect(JSON.stringify(calls[0]?.args)).not.toContain("SECRET_TOKEN_1");
});

test("a block finding replaces the whole message, not a partial value", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["prefix BLOCK_ME suffix"], method, 30);
  expect(calls[0]?.args[0]).toBe(BLOCK_MARKER);
});

test("a core scan failure fails closed and never surfaces the raw text or the error", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["trigger BOOM here"], method, 30);
  expect(calls[0]?.args[0]).toBe(ERROR_MARKER);
});

test("method is invoked exactly once via apply, with the logger as receiver", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  const logger = { name: "receiver-check" };
  callHook(hook, logger, ["plain message, no secret"], method, 30);
  expect(calls.length).toBe(1);
  expect(calls[0]?.receiver).toBe(logger);
});

test("numbers and booleans are formatted into the joined message, matching pino's own quick-format-unescaped, and pass through unredacted", () => {
  const { method, calls } = spyMethod();
  const hook = createRedactingLogMethodWith(fakeScanAndRedact);
  callHook(hook, {}, ["count is %d, active is %s", 3, true], method, 30);
  expect(calls[0]?.args).toEqual(["count is 3, active is true"]);
});

test("rejects a non-function scanAndRedact", () => {
  expect(() => createRedactingLogMethodWith(null as unknown as ScanAndRedact)).toThrow(TypeError);
});
