/**
 * Exercises the live wrappers against the real installed core and a real
 * pino logger: `initialize()` order, hook shape, and that a secret the real
 * core detects is actually masked, so a hook that passed its input through
 * would fail. Tokens are synthetic and built at runtime.
 */

import pino from "pino";
import { expect, test } from "vitest";

import { createRedactingLogMethod, createRedactingStreamWrite } from "../src/index.js";

const SYNTHETIC_GITHUB_TOKEN = `ghp_${"x".repeat(36)}`;
// Detected only with the "api_key=" context in front of it.
const SYNTHETIC_CONTEXTUAL_VALUE = `SYNTHETIC_TEST_VALUE_${"0".repeat(10)}`;

async function liveLogger(options: pino.LoggerOptions = {}) {
  const chunks: string[] = [];
  const destination = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const hooks = { logMethod: await createRedactingLogMethod(), streamWrite: await createRedactingStreamWrite() };
  const logger = pino({ base: null, timestamp: false, hooks, ...options }, destination);
  return { logger, raw: () => chunks.join(""), lines: () => chunks.map((chunk) => JSON.parse(chunk)) };
}

test("createRedactingLogMethod initializes the real core and returns a working pino hook", async () => {
  const { logger, lines } = await liveLogger();
  logger.info({ user: "alice" }, "user %s logged in", "alice");
  expect(lines()).toEqual([{ level: 30, user: "alice", msg: "user alice logged in" }]);
});

test("the real core masks a synthetic token in the message, a field, an error, a binding, and mixin output", async () => {
  const { logger, raw, lines } = await liveLogger({ mixin: () => ({ mixed: SYNTHETIC_GITHUB_TOKEN }) });
  const child = logger.child({ session: SYNTHETIC_GITHUB_TOKEN });
  child.info({ auth: `Bearer ${SYNTHETIC_GITHUB_TOKEN}` }, "token is %s", SYNTHETIC_GITHUB_TOKEN);
  child.error(new Error(`failed with ${SYNTHETIC_GITHUB_TOKEN}`));

  expect(raw()).not.toContain(SYNTHETIC_GITHUB_TOKEN);
  const [info, error] = lines();
  expect(info).toMatchObject({ session: "<SECRET_1>", mixed: "<SECRET_1>", auth: "Bearer <SECRET_1>" });
  expect(info.msg).toBe("token is <SECRET_1>");
  expect(error.msg).toBe("failed with <SECRET_1>");
});

test("a msgPrefix gives the real core the context to detect the value after it", async () => {
  const { logger, raw, lines } = await liveLogger();
  logger.child({}, { msgPrefix: "api_key=" }).info(SYNTHETIC_CONTEXTUAL_VALUE);
  expect(raw()).not.toContain(SYNTHETIC_CONTEXTUAL_VALUE);
  expect(lines()).toEqual([{ level: 30, msg: "api_key=<SECRET_1>" }]);
});
