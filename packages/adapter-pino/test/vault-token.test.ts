/**
 * Coexistence with `@redact-secret/vault`
 * (redact-secret/redact-secret-adapters#52), on the **real installed core**
 * and a real pino logger.
 *
 * A host that captures with the vault on the way to a model and logs the same
 * text with pino would, if either hook rewrote a `<rsv_…>` token, hand the
 * application a value its `restore()` can no longer resolve. The vault is not
 * a dependency of this repository and never will be; the shape of its token is
 * what is pinned. Every byte of the shared fixture's adversarial contexts must
 * reach the destination unchanged — including through `msgPrefix`, which is
 * what gives the core the surrounding context it detects on.
 */

import pino from "pino";
import { expect, test } from "vitest";

import { VAULT_TOKEN, VAULT_TOKEN_CONTEXTS, VAULT_TOKEN_LITERAL } from "../../../fixtures/vault-token.js";
import { createRedactingLogMethod, createRedactingStreamWrite } from "../src/index.js";

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

test("every adversarial context reaches the destination byte for byte", async () => {
  const { logger, lines } = await liveLogger();
  for (const { text } of VAULT_TOKEN_CONTEXTS) logger.info(text);
  expect(lines().map((line) => line.msg)).toEqual(VAULT_TOKEN_CONTEXTS.map((context) => context.text));
});

test("a token survives a message, an interpolated value, a field, a binding, a mixin, and an error", async () => {
  const { logger, raw, lines } = await liveLogger({ mixin: () => ({ mixed: VAULT_TOKEN }) });
  const child = logger.child({ session: VAULT_TOKEN });
  child.info({ auth: `Bearer ${VAULT_TOKEN}` }, "token is %s", VAULT_TOKEN);
  child.error(new Error(`failed with ${VAULT_TOKEN}`));

  const [info, error] = lines();
  expect(info).toMatchObject({ session: VAULT_TOKEN, mixed: VAULT_TOKEN, auth: `Bearer ${VAULT_TOKEN}` });
  expect(info.msg).toBe(`token is ${VAULT_TOKEN}`);
  expect(error.msg).toBe(`failed with ${VAULT_TOKEN}`);
  // Nothing anywhere in the stream was rewritten to a placeholder.
  expect(raw()).not.toMatch(/<SECRET_\d+>|<GENERIC_TOKEN_\d+>|\[REDACTED:/);
});

test("a msgPrefix that would give the core detection context still leaves a token alone", async () => {
  const { logger, lines } = await liveLogger();
  logger.child({}, { msgPrefix: "api_key=" }).info(VAULT_TOKEN);
  expect(lines()).toEqual([{ level: 30, msg: `api_key=${VAULT_TOKEN}` }]);
});

test("nothing these hooks emit for a clean log call contains the literal the vault refuses", async () => {
  const { logger, raw } = await liveLogger();
  logger.info({ note: "ordinary text" }, "ordinary message");
  expect(raw()).not.toContain(VAULT_TOKEN_LITERAL);
});
