/**
 * `createRedactingHooksWith` against a real pino logger: the paired factory
 * installs the complete boundary in one step, composes the host's own
 * `logMethod`/`streamWrite` rather than replacing them, and keeps ordinary
 * pino functionality — serializers, formatters, levels, child loggers,
 * `mixin()`, `msgPrefix`, pino's own path `redact` — intact.
 *
 * `base: null` and `timestamp: false` keep every line deterministic so whole
 * lines can be asserted, not just substrings.
 */

import pino from "pino";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { createRedactingHooksWith, type RedactingHooksOptions } from "../src/index.js";

function capturingLogger(options: RedactingHooksOptions = {}, loggerOptions: pino.LoggerOptions = {}) {
  const chunks: string[] = [];
  const destination = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const logger = pino(
    { base: null, timestamp: false, hooks: createRedactingHooksWith(fakeScanAndRedact, options), ...loggerOptions },
    destination,
  );
  return {
    logger,
    raw: () => chunks.join(""),
    lines: () =>
      chunks
        .join("")
        .trimEnd()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

test("one setup step covers the message, a merging object, child bindings, mixin output and a serializer", () => {
  const { logger, raw, lines } = capturingLogger(
    {},
    {
      mixin: () => ({ mixed: "SECRET_TOKEN_4" }),
      serializers: { req: (value: { auth: string }) => ({ auth: value.auth }) },
    },
  );
  const child = logger.child({ session: "SECRET_TOKEN_2" });
  child.info({ req: { auth: "Bearer SECRET_TOKEN_3" } }, "token is %s", "SECRET_TOKEN_1");

  expect(raw()).not.toMatch(/SECRET_TOKEN_\d/);
  expect(lines()).toEqual([
    {
      level: 30,
      session: "<SECRET_1>",
      mixed: "<SECRET_1>",
      req: { auth: "Bearer <SECRET_1>" },
      msg: "token is <SECRET_1>",
    },
  ]);
});

test("the returned object is exactly a pino hooks object: both hooks, and nothing pino does not know", () => {
  const hooks = createRedactingHooksWith(fakeScanAndRedact);
  expect(Object.keys(hooks).sort()).toEqual(["logMethod", "streamWrite"]);
  expect(typeof hooks.logMethod).toBe("function");
  expect(typeof hooks.streamWrite).toBe("function");
});

test("a host logMethod still runs, and values it adds are redacted after it", () => {
  const seen: unknown[][] = [];
  const { logger, raw, lines } = capturingLogger({
    hooks: {
      logMethod(args, method) {
        seen.push([...args]);
        // The host hook adds a field of its own; it must be scanned too.
        method.apply(this, [{ added: "SECRET_TOKEN_9" }, ...args] as Parameters<pino.LogFn>);
      },
    },
  });
  logger.info("plain message");

  // The host's hook sees pino's arguments untouched, before redaction.
  expect(seen).toEqual([["plain message"]]);
  expect(raw()).not.toContain("SECRET_TOKEN_9");
  expect(lines()).toEqual([{ level: 30, added: "<SECRET_1>", msg: "plain message" }]);
});

test("a host logMethod that drops the record still drops it", () => {
  const { logger, raw } = capturingLogger({
    hooks: {
      logMethod() {
        // Never calls `method`: the record is dropped, as without this package.
      },
    },
  });
  logger.info("token is %s", "SECRET_TOKEN_1");
  expect(raw()).toBe("");
});

test("a host logMethod that rewrites the message has its rewrite scanned", () => {
  const { logger, raw, lines } = capturingLogger({
    hooks: {
      logMethod(_args, method) {
        method.apply(this, ["api_key=SECRET_TOKEN_1"] as Parameters<pino.LogFn>);
      },
    },
  });
  logger.info("something else entirely");
  expect(raw()).not.toContain("SECRET_TOKEN_1");
  expect(lines()).toEqual([{ level: 30, msg: "api_key=<SECRET_1>" }]);
});

test("a host streamWrite runs first and fields it adds to the line are redacted", () => {
  const seen: string[] = [];
  const { logger, raw, lines } = capturingLogger({
    hooks: {
      streamWrite(line) {
        seen.push(line);
        return `${JSON.stringify({ ...JSON.parse(line), tag: "SECRET_TOKEN_8" })}\n`;
      },
    },
  });
  logger.info("plain message");

  // The host's hook saw pino's own line (the logMethod pass changed nothing here).
  expect(seen).toEqual(['{"level":30,"msg":"plain message"}\n']);
  expect(raw()).not.toContain("SECRET_TOKEN_8");
  expect(lines()).toEqual([{ level: 30, msg: "plain message", tag: "<SECRET_1>" }]);
});

test("a throwing host streamWrite cannot put the unmasked line on the wire", () => {
  const { logger, raw, lines } = capturingLogger({
    hooks: {
      streamWrite() {
        throw new Error("host hook failed");
      },
    },
  });
  logger.info({ session: "SECRET_TOKEN_1" }, "hello");
  expect(raw()).not.toContain("SECRET_TOKEN_1");
  expect(lines()).toEqual([{ level: 30, session: "<SECRET_1>", msg: "hello" }]);
});

test("a host streamWrite returning a non-string falls back to redacting pino's own line", () => {
  const { logger, raw, lines } = capturingLogger({
    hooks: {
      streamWrite: (() => undefined) as unknown as (line: string) => string,
    },
  });
  logger.info({ session: "SECRET_TOKEN_1" }, "hello");
  expect(raw()).not.toContain("SECRET_TOKEN_1");
  expect(lines()).toEqual([{ level: 30, session: "<SECRET_1>", msg: "hello" }]);
});

test("an unknown hook key is forwarded unchanged rather than dropped", () => {
  const future = () => "unused";
  const hooks = createRedactingHooksWith(fakeScanAndRedact, {
    hooks: { futureHook: future } as unknown as RedactingHooksOptions["hooks"],
  });
  expect(hooks.futureHook).toBe(future);
});

test("a non-function host hook is an explicit TypeError, not a silent replacement", () => {
  expect(() =>
    createRedactingHooksWith(fakeScanAndRedact, {
      hooks: { logMethod: "nope" as unknown as undefined },
    }),
  ).toThrow(TypeError);
  expect(() =>
    createRedactingHooksWith(fakeScanAndRedact, {
      hooks: { streamWrite: 1 as unknown as undefined },
    }),
  ).toThrow(TypeError);
  expect(() => createRedactingHooksWith(fakeScanAndRedact, { hooks: 1 as unknown as undefined })).toThrow(TypeError);
});

test("policy and limits reach both hooks", () => {
  // maxTotalLeaves 1 is spent by the message in logMethod, and again by the
  // first string of the line in streamWrite: everything after each is the
  // limit marker, never the raw value.
  const { logger, lines, raw } = capturingLogger({ limits: { maxTotalLeaves: 1 } });
  logger.info({ a: "SECRET_TOKEN_1", b: "SECRET_TOKEN_2" }, "hello");
  expect(raw()).not.toMatch(/SECRET_TOKEN_\d/);
  expect(lines().flatMap((line) => Object.values(line))).toContain("[REDACTED:LIMIT_EXCEEDED]");
});

test("pino's own path redact, levels and msgPrefix keep working", () => {
  const { logger, lines } = capturingLogger(
    {},
    { redact: ["req.headers.authorization"], level: "warn", msgPrefix: "[api] " },
  );
  logger.info("dropped by the level");
  logger.warn({ req: { headers: { authorization: "Bearer abc" } } }, "kept");
  expect(lines()).toEqual([{ level: 40, req: { headers: { authorization: "[Redacted]" } }, msg: "[api] kept" }]);
});

test("a non-secret payload is byte-for-byte what pino would have written without the hooks", () => {
  const plain: string[] = [];
  const hooked: string[] = [];
  const write = (into: string[]) => ({
    write(chunk: string) {
      into.push(chunk);
      return true;
    },
  });
  const options: pino.LoggerOptions = { base: null, timestamp: false };
  pino(options, write(plain)).info({ user: "alice", count: 3, ok: true }, "user %s logged in", "alice");
  pino({ ...options, hooks: createRedactingHooksWith(fakeScanAndRedact) }, write(hooked)).info(
    { user: "alice", count: 3, ok: true },
    "user %s logged in",
    "alice",
  );
  expect(hooked.join("")).toBe(plain.join(""));
});
