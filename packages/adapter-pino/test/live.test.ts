/**
 * Exercises the live wrapper against the real installed core and a real
 * pino logger. It deliberately logs no secret-shaped value — detection is
 * the core's job and is tested there — and asserts only that the wiring
 * (`initialize()` order, hook shape) carries clean text through unchanged.
 */

import pino from "pino";
import { expect, test } from "vitest";

import { createRedactingLogMethod } from "../src/index.js";

test("createRedactingLogMethod initializes the real core and returns a working pino hook", async () => {
  const chunks: string[] = [];
  const destination = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const logger = pino(
    { base: null, timestamp: false, hooks: { logMethod: await createRedactingLogMethod() } },
    destination,
  );

  logger.info({ user: "alice" }, "user %s logged in", "alice");

  expect(chunks.map((chunk) => JSON.parse(chunk))).toEqual([{ level: 30, user: "alice", msg: "user alice logged in" }]);
});
