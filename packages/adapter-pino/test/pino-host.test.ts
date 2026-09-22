/**
 * The real-host test: an actual pino consumer — not a spy `method` standing
 * in for pino — wired through `createRedactingLogMethodWith` to a captured
 * destination, asserting on the exact bytes pino writes. CI runs this at
 * both ends of the declared `pino` peer range.
 *
 * `scanAndRedact` is the same deterministic fake the other tests use
 * (`fixtures/fake-scanner.ts`) — this test is about the pino integration
 * boundary (call-shape handling, message formatting, serializer ordering),
 * not the core's detection accuracy. `base: null` and `timestamp: false`
 * keep every line deterministic (no pid/hostname/time fields) so full lines
 * can be asserted exactly, not just substrings.
 */

import type { MaskOptions } from "@redact-secret/adapter";
import pino from "pino";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { createRedactingLogMethodWith, createRedactingStreamWriteWith } from "../src/index.js";

function capturingLogger(options: MaskOptions = {}) {
  const chunks: string[] = [];
  const destination = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const logMethod = createRedactingLogMethodWith(fakeScanAndRedact, options);
  const logger = pino({ base: null, timestamp: false, hooks: { logMethod } }, destination);
  return {
    logger,
    lines: () =>
      chunks
        .join("")
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
    raw: () => chunks.join(""),
  };
}

test("ordinary formatting with no secret reaches the destination unchanged", () => {
  const { logger, lines } = capturingLogger();
  logger.info("user %s logged in from %s", "alice", "10.0.0.1");
  expect(lines()).toEqual([{ level: 30, msg: "user alice logged in from 10.0.0.1" }]);
});

test("issue #361: a contextual assignment split across msg and an interpolation value is redacted before pino ever formats it", () => {
  const { logger, lines, raw } = capturingLogger();
  logger.info("api_key=%s", "SECRET_TOKEN_1");
  expect(lines()).toEqual([{ level: 30, msg: "api_key=<SECRET_1>" }]);
  expect(raw()).not.toContain("SECRET_TOKEN_1");
});

test("issue #361: a provider token split across two interpolation values is redacted", () => {
  const { logger, lines, raw } = capturingLogger();
  logger.info("token is %s%s", "SECRET_TOKEN_", "1");
  expect(lines()).toEqual([{ level: 30, msg: "token is <SECRET_1>" }]);
  expect(raw()).not.toContain("SECRET_TOKEN_1");
});

test("a secret confined to a merging-object field is redacted alongside an ordinary message", () => {
  const { logger, lines, raw } = capturingLogger();
  logger.info({ authHeader: "Bearer SECRET_TOKEN_1" }, "request received");
  expect(lines()).toEqual([{ level: 30, authHeader: "Bearer <SECRET_1>", msg: "request received" }]);
  expect(raw()).not.toContain("SECRET_TOKEN_1");
});

test("a merging object and a split interpolated message are both redacted in the same line", () => {
  const { logger, lines, raw } = capturingLogger();
  logger.info({ authHeader: "Bearer SECRET_TOKEN_1" }, "token is SECRET_TOKEN_%s", "2");
  expect(lines()).toEqual([{ level: 30, authHeader: "Bearer <SECRET_1>", msg: "token is <SECRET_1>" }]);
  expect(raw()).not.toContain("SECRET_TOKEN_1");
  expect(raw()).not.toContain("SECRET_TOKEN_2");
});

test("a bare Error's message and stack are redacted before pino's default err serializer runs", () => {
  const { logger, lines, raw } = capturingLogger();
  logger.error(new Error("failed with SECRET_TOKEN_1"));
  const [line] = lines();
  expect(line.level).toBe(50);
  expect(line.msg).toBe("failed with <SECRET_1>");
  expect(line.err.message).toBe("failed with <SECRET_1>");
  expect(typeof line.err.stack).toBe("string");
  expect(raw()).not.toContain("SECRET_TOKEN_1");
});

test("logger.error(err, msg) keeps the caller's message; pino's own err.message fallback never replaces it", () => {
  const { logger, lines, raw } = capturingLogger();
  logger.error(new TypeError("failed at 50%s with SECRET_TOKEN_1"), "custom message");
  const [line] = lines();
  expect(line.msg).toBe("custom message");
  expect(line.err.type).toBe("TypeError");
  expect(line.err.message).toBe("failed at 50%s with <SECRET_1>");
  expect(raw()).not.toContain("SECRET_TOKEN_1");
});

test("logger.error(err, fmt, ...values) formats the caller's message, not err.message", () => {
  const { logger, lines } = capturingLogger();
  logger.error(new Error("at 50%s"), "retry %s of %s", "1", "3");
  const [line] = lines();
  expect(line.msg).toBe("retry 1 of 3");
  expect(line.err.message).toBe("at 50%s");
});

test("issue #361: a block finding on the joined message replaces the whole message pino writes", () => {
  const { logger, lines, raw } = capturingLogger();
  logger.info("prefix %s suffix", "BLOCK_ME");
  expect(lines()).toEqual([{ level: 30, msg: "[REDACTED:BLOCKED]" }]);
  expect(raw()).not.toContain("BLOCK_ME");
});

test("issue #361: a scanner failure on the joined message fails closed in the destination bytes", () => {
  const { logger, lines, raw } = capturingLogger();
  logger.info("trigger %s here", "BOOM");
  expect(lines()).toEqual([{ level: 30, msg: "[REDACTED:ERROR]" }]);
  expect(raw()).not.toContain("BOOM");
});

function capture() {
  const chunks: string[] = [];
  const destination = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  return { destination, raw: () => chunks.join(""), lines: () => chunks.map((chunk) => JSON.parse(chunk)) };
}

test("logMethod alone never sees child bindings or mixin() output — the gap streamWrite closes", () => {
  const { destination, raw } = capture();
  const logMethod = createRedactingLogMethodWith(fakeScanAndRedact);
  const logger = pino(
    { base: null, timestamp: false, hooks: { logMethod }, mixin: () => ({ mixed: "SECRET_TOKEN_2" }) },
    destination,
  );
  logger.child({ session: "SECRET_TOKEN_1" }).info("hello");
  // If pino ever routes these through hooks.logMethod, this canary fails and
  // the streamWrite requirement in the README can be revisited.
  expect(raw()).toContain("SECRET_TOKEN_1");
  expect(raw()).toContain("SECRET_TOKEN_2");
});

test("streamWrite masks child bindings, setBindings, and mixin() output in the bytes pino writes", () => {
  const { destination, raw, lines } = capture();
  const logger = pino(
    {
      base: null,
      timestamp: false,
      hooks: {
        logMethod: createRedactingLogMethodWith(fakeScanAndRedact),
        streamWrite: createRedactingStreamWriteWith(fakeScanAndRedact),
      },
      mixin: () => ({ mixed: "mixin SECRET_TOKEN_2" }),
    },
    destination,
  );
  const child = logger.child({ session: "session SECRET_TOKEN_1" });
  child.info("hello %s", "SECRET_TOKEN_3");
  child.setBindings({ later: "later SECRET_TOKEN_4" });
  child.child({ grand: "BLOCK_ME" }).warn("again");

  expect(lines()).toEqual([
    { level: 30, session: "session <SECRET_1>", mixed: "mixin <SECRET_1>", msg: "hello <SECRET_1>" },
    {
      level: 40,
      session: "session <SECRET_1>",
      later: "later <SECRET_1>",
      grand: "[REDACTED:BLOCKED]",
      mixed: "mixin <SECRET_1>",
      msg: "again",
    },
  ]);
  expect(raw()).not.toMatch(/SECRET_TOKEN_\d|BLOCK_ME/);
});

test("pino's own path-based redact still applies on top, to a field the value-based hook left untouched", () => {
  const chunks: string[] = [];
  const destination = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const logMethod = createRedactingLogMethodWith(fakeScanAndRedact);
  const logger = pino(
    { base: null, timestamp: false, hooks: { logMethod }, redact: ["req.headers.authorization"] },
    destination,
  );
  logger.info({ req: { headers: { authorization: "Bearer plain-not-a-detected-secret" } } }, "request received");
  const [line] = chunks
    .join("")
    .trimEnd()
    .split("\n")
    .map((entry) => JSON.parse(entry));
  expect(line).toEqual({
    level: 30,
    req: { headers: { authorization: "[Redacted]" } },
    msg: "request received",
  });
});
