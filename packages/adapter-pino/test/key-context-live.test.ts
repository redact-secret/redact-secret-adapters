/**
 * Key-aware detection through a real pino logger and the real core
 * (redact-secret-adapters#172): the same synthetic key/value pairs as every
 * other adapter, through the paths pino has for a value — call arguments,
 * child bindings, `mixin()` output and serializer output — each asserted on
 * the exact bytes written. CI runs this at both ends of the declared core and
 * pino ranges.
 */

import pino from "pino";
import { expect, test } from "vitest";

import { expectedLeaf, loadKeyContextCases } from "../../../fixtures/key-context.js";
import { createRedactingHooks, createRedactingLogMethod, createRedactingStreamWrite } from "../src/index.js";

const cases = loadKeyContextCases();
const LEAF = "synthetic-example-value-0001";

async function liveLogger(
  options: pino.LoggerOptions = {},
  hooksOptions: Parameters<typeof createRedactingHooks>[0] = {},
) {
  const chunks: string[] = [];
  const destination = {
    write(chunk: string) {
      chunks.push(chunk);
      return true;
    },
  };
  const hooks = await createRedactingHooks(hooksOptions);
  const logger = pino({ base: null, timestamp: false, hooks, ...options }, destination);
  return { logger, raw: () => chunks.join(""), lines: () => chunks.map((chunk) => JSON.parse(chunk)) };
}

test.each(cases)("$id: call arguments, child bindings, mixin output and serializer output agree", async (testCase) => {
  const { key, value } = testCase;
  const expected = expectedLeaf(testCase);
  const { logger, lines, raw } = await liveLogger({
    mixin: () => ({ mixed: { [key]: value } }),
    serializers: { user: () => ({ [key]: value }) },
  });
  logger.child({ bound: { [key]: value } }).info({ args: { [key]: value }, user: {} }, "hello");

  const [line] = lines();
  expect(line.args).toEqual({ [key]: expected });
  expect(line.bound).toEqual({ [key]: expected });
  expect(line.mixed).toEqual({ [key]: expected });
  expect(line.user).toEqual({ [key]: expected });
  if (testCase.masked !== null) expect(raw()).not.toContain(value);
  // The line is still one valid JSON object with the same keys.
  expect(Object.keys(line)).toEqual(["level", "bound", "mixed", "args", "user", "msg"].filter((name) => name in line));
});

test("a context-dependent credential is masked at the top level of every path, with benign siblings untouched", async () => {
  const { logger, lines, raw } = await liveLogger({ mixin: () => ({ client_secret: LEAF, sibling: LEAF }) });
  logger.child({ password: LEAF }).info({ api_key: LEAF, name: LEAF }, "m");
  const [line] = lines();
  expect(line).toMatchObject({
    password: "<SECRET_1>",
    client_secret: "<SECRET_1>",
    api_key: "<SECRET_1>",
    name: LEAF,
    sibling: LEAF,
  });
  expect(raw().split(LEAF).length - 1).toBe(2);
});

test("escaping is preserved: quotes, backslashes and control characters round-trip as valid JSON", async () => {
  const { logger, lines } = await liveLogger();
  const value = 'say "hi" \\ back\nnext\ttab   end';
  logger.info({ note: value, 'a"b\\c': value, api_key: LEAF }, "m");
  const [line] = lines();
  expect(line.note).toBe(value);
  expect(line['a"b\\c']).toBe(value);
  expect(line.api_key).toBe("<SECRET_1>");
});

test("the final-line hook alone applies key context to bindings and mixin output", async () => {
  const chunks: string[] = [];
  const streamWrite = await createRedactingStreamWrite();
  const logger = pino(
    { base: null, timestamp: false, hooks: { streamWrite }, mixin: () => ({ password: LEAF }) },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  logger.child({ api_key: LEAF }).info("m");
  expect(JSON.parse(chunks[0] ?? "")).toMatchObject({ api_key: "<SECRET_1>", password: "<SECRET_1>" });
});

test("the call-argument hook alone applies key context to a merging object", async () => {
  const chunks: string[] = [];
  const logMethod = await createRedactingLogMethod();
  const logger = pino(
    { base: null, timestamp: false, hooks: { logMethod } },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  logger.info({ api_key: LEAF, name: LEAF });
  expect(JSON.parse(chunks[0] ?? "")).toMatchObject({ api_key: "<SECRET_1>", name: LEAF });
});

test.each([
  ["block", "[REDACTED:BLOCKED]"],
  ["warn", LEAF],
  ["allow", LEAF],
] as const)("policy %s applies to a key-context finding on both hooks", async (action, expected) => {
  const { logger, lines } = await liveLogger({}, { policy: { evaluate: () => action } });
  logger.child({ password: LEAF }).info({ api_key: LEAF }, "m");
  expect(lines()[0]).toMatchObject({ password: expected, api_key: expected });
});

test("a throwing getter on the merging object fails closed and the value never reaches the destination", async () => {
  const { logger, raw } = await liveLogger();
  logger.info({
    api_key: LEAF,
    get boom(): string {
      throw new Error(LEAF);
    },
  });
  expect(raw()).not.toContain(LEAF);
  expect(raw()).toContain("[REDACTED:ERROR]");
});

test("a key that is valid JSON but not a plain string value keeps the lexer honest", async () => {
  const { logger, lines } = await liveLogger();
  logger.info({ api_key: [LEAF], password: { nested: LEAF }, count: 1, ok: true, nothing: null });
  const [line] = lines();
  // An array element and a nested object value are not directly under api_key/password.
  expect(line).toMatchObject({ api_key: [LEAF], password: { nested: LEAF }, count: 1, ok: true, nothing: null });
});
