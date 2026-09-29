/**
 * The live pino factories against a mocked core, for the process-wide PII
 * activation contract (redact-secret/redact-secret-adapters#51).
 *
 * Mocked rather than live for two reasons: `0.1.0-beta.10`, which introduced
 * `initialize({ pii })` and `piiActivation()`, is not on the registry; and the
 * selection cell is one-shot *per process*, so a real core could serve exactly
 * one of these orderings per run. The mock is the same one
 * `live-init-failure`-style tests use, with the lifecycle members driven from
 * a holder so one file can play every ordering.
 *
 * Secrets are the deterministic fake's magic strings, built at runtime.
 */

import pino from "pino";
import { beforeEach, expect, test, vi } from "vitest";

const core = vi.hoisted(() => ({
  /** Every `initialize` argument, in order. `undefined` is the argument-free call. */
  calls: [] as unknown[],
  /** What `initialize` rejects with, or `undefined` to resolve. */
  rejectWith: undefined as (() => Error) | undefined,
  /** What `piiActivation()` returns; `undefined` means the core has no such export. */
  identity: undefined as string | undefined,
}));

vi.mock("@redact-secret/core", async () => {
  const { fakeScanAndRedact } = await import("../../../fixtures/fake-scanner.js");
  const module: Record<string, unknown> = {
    initialize: async (options?: unknown) => {
      core.calls.push(options);
      if (core.rejectWith !== undefined) throw core.rejectWith();
    },
    scanAndRedact: (text: string) => fakeScanAndRedact(text),
    createIncrementalSanitizer: () => {
      throw new Error("must not be reached");
    },
  };
  // A getter, so "this core predates piiActivation()" is a real absence rather
  // than a function that returns nothing.
  Object.defineProperty(module, "piiActivation", {
    configurable: true,
    enumerable: true,
    get: () => (core.identity === undefined ? undefined : () => core.identity),
  });
  return module;
});

const { createRedactingHooks, createRedactingLogMethod, createRedactingStreamWrite } = await import("../src/index.js");

const PII_ON = "credentials=full;selectors=pii:global;families=email;vocabulary=pii-context/v1";
const PII_OFF = "credentials=full;selectors=off;families=;vocabulary=pii-context/v1";

function conflict(): Error {
  return Object.assign(new Error("a different PII selection is already active"), {
    code: "PII_ACTIVATION_CONFLICT",
  });
}

beforeEach(() => {
  core.calls.length = 0;
  core.rejectWith = undefined;
  core.identity = undefined;
});

/** One line through a real pino logger over the hooks under test. */
function loggerOver(hooks: pino.LoggerOptions["hooks"]) {
  const chunks: string[] = [];
  const logger = pino(
    { base: null, timestamp: false, hooks },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  return { logger, lines: () => chunks.map((chunk) => JSON.parse(chunk)) };
}

test("application first: the adapter absorbs the conflict and still returns working hooks", async () => {
  // The application already ran `initialize({ pii })`, so the adapter's own
  // argument-free call loses the race.
  core.identity = PII_ON;
  core.rejectWith = conflict;

  const { logger, lines } = loggerOver(await createRedactingHooks());
  logger.info("token SECRET_TOKEN_1");

  expect(lines()).toEqual([{ level: 30, msg: "token <SECRET_1>" }]);
  expect(core.calls).toEqual([undefined]);
});

test("application first: the single-hook factories absorb it too", async () => {
  core.identity = PII_ON;
  core.rejectWith = conflict;
  await expect(createRedactingLogMethod()).resolves.toBeTypeOf("function");
  await expect(createRedactingStreamWrite()).resolves.toBeTypeOf("function");
});

test("adapter first: pii is forwarded to initialize and kept out of the hook options", async () => {
  core.identity = PII_ON;

  const hooks = await createRedactingHooks({ pii: ["pii:global"] });

  expect(core.calls).toEqual([{ pii: ["pii:global"] }]);
  const { logger, lines } = loggerOver(hooks);
  logger.info("token SECRET_TOKEN_1");
  expect(lines()).toEqual([{ level: 30, msg: "token <SECRET_1>" }]);
});

test("an activation that does not reflect the request is refused with a fixed code", async () => {
  core.identity = PII_OFF;
  const refusal = await createRedactingHooks({ pii: ["pii:global"] }).catch((error: unknown) => error);
  expect((refusal as { code?: string }).code).toBe("PII_ACTIVATION_NOT_ACTIVE");
  expect((refusal as Error).message).not.toContain("pii:global");
});

test("a core without piiActivation fails clearly when pii is passed", async () => {
  const refusal = await createRedactingHooks({ pii: ["pii:global"] }).catch((error: unknown) => error);
  expect((refusal as { code?: string }).code).toBe("PII_ACTIVATION_UNSUPPORTED");
  expect(core.calls).toEqual([]);
});

test("a core without piiActivation is unchanged when pii is omitted: the declared floor still works", async () => {
  const { logger, lines } = loggerOver(await createRedactingHooks());
  logger.info("token SECRET_TOKEN_1");
  expect(lines()).toEqual([{ level: 30, msg: "token <SECRET_1>" }]);
  expect(core.calls).toEqual([undefined]);
});

test("every other initialization failure still rejects, exactly as before", async () => {
  const failure = Object.assign(new Error("artifact missing near SECRET_TOKEN_1"), {
    code: "INITIALIZATION_FAILED",
  });
  core.rejectWith = () => failure;
  await expect(createRedactingHooks()).rejects.toBe(failure);
  await expect(createRedactingLogMethod()).rejects.toBe(failure);
  await expect(createRedactingStreamWrite()).rejects.toBe(failure);
});

test("an activation changes no output byte", async () => {
  core.identity = PII_ON;
  const withPii = loggerOver(await createRedactingHooks({ pii: ["pii:global"] }));
  const without = loggerOver(await createRedactingHooks());
  for (const { logger } of [withPii, without]) {
    logger.info({ auth: "SECRET_TOKEN_1", note: "WARN_ME" }, "hello %s", "world");
  }
  expect(withPii.lines()).toEqual(without.lines());
});
