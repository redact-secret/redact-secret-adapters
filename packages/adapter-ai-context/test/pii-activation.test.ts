/**
 * The live AI-context factory against a mocked core, for the process-wide PII
 * activation contract (redact-secret/redact-secret-adapters#51).
 *
 * This package never rejects for an initialization failure — it fails every
 * operation closed — so the two halves of the contract look different here
 * than they do in `adapter-pino` and `adapter-otel`:
 *
 * - An activation **conflict** with no `pii` of our own is no longer a failure
 *   at all. It says the application already activated its own selection, so
 *   the boundary must work, not block.
 * - A `pii` that cannot be shown to be active **is** a failure, and takes the
 *   same fail-closed path as every other one: `blocked` / `core_error`, with
 *   no code, because the refusal carries no code from the core's registry.
 *
 * Mocked rather than live: the core's selection cell is one-shot per
 * process, so a real core could serve only one of these orderings per run.
 * The real core is covered one ordering per spawned process in
 * `packages/adapter/test/activation-live.test.ts`.
 */

import { beforeEach, expect, test, vi } from "vitest";

const core = vi.hoisted(() => ({
  calls: [] as unknown[],
  rejectWith: undefined as (() => Error) | undefined,
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
  Object.defineProperty(module, "piiActivation", {
    configurable: true,
    enumerable: true,
    get: () => (core.identity === undefined ? undefined : () => core.identity),
  });
  return module;
});

const { createAiContextBoundary } = await import("../src/index.js");

const PII_ON = "credentials=full;selectors=pii:global;families=pii:global:email;vocabulary=pii-context/v2";
const PII_OFF = "credentials=full;selectors=off;families=;vocabulary=pii-context/v2";
const OK = { outcome: "ok", value: "token <SECRET_1>", findings: [expect.objectContaining({ action: "redact" })] };
const FAILED_CLOSED = { outcome: "blocked", reason: "core_error" };

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

test("application first: the conflict is absorbed and the boundary works, not blocks", async () => {
  core.identity = PII_ON;
  core.rejectWith = conflict;
  const boundary = await createAiContextBoundary();
  expect(boundary.sanitizeText("token SECRET_TOKEN_1")).toEqual(OK);
  expect(core.calls).toEqual([undefined]);
});

test("adapter first: pii is forwarded to initialize and the boundary works", async () => {
  core.identity = PII_ON;
  const boundary = await createAiContextBoundary({ pii: ["pii:global"] });
  expect(boundary.sanitizeText("token SECRET_TOKEN_1")).toEqual(OK);
  expect(core.calls).toEqual([{ pii: ["pii:global"] }]);
});

test("an activation that does not reflect the request fails every operation closed, and never rejects", async () => {
  core.identity = PII_OFF;
  const boundary = await createAiContextBoundary({ pii: ["pii:global"] });
  // No code: the refusal is this repository's, not one of the core's fixed
  // registry codes, so nothing invented is put in its place.
  expect(boundary.sanitizeText("token SECRET_TOKEN_1")).toEqual(FAILED_CLOSED);
  expect(boundary.sanitizeValue({ a: "SECRET_TOKEN_1" })).toEqual(FAILED_CLOSED);
  expect(boundary.buildContext([{ role: "user", text: "SECRET_TOKEN_1" }])).toEqual(FAILED_CLOSED);
});

test("a core without piiActivation fails closed when pii is passed, and is never initialized", async () => {
  const boundary = await createAiContextBoundary({ pii: ["pii:global"] });
  expect(boundary.sanitizeText("token SECRET_TOKEN_1")).toEqual(FAILED_CLOSED);
  expect(core.calls).toEqual([]);
});

test("a core without piiActivation is unchanged when pii is omitted: the declared floor still works", async () => {
  const boundary = await createAiContextBoundary();
  expect(boundary.sanitizeText("token SECRET_TOKEN_1")).toEqual(OK);
  expect(core.calls).toEqual([undefined]);
});

test("an inherited activation is forwarded, like every other inherited option", async () => {
  core.identity = PII_ON;
  const boundary = await createAiContextBoundary(Object.create({ pii: ["pii:global"] }));
  expect(boundary.sanitizeText("token SECRET_TOKEN_1")).toEqual(OK);
  expect(core.calls).toEqual([{ pii: ["pii:global"] }]);
});

test("malformed options still reject, unchanged by the activation step", async () => {
  // `withDefaultLimits` runs first and rejects a non-object before anything
  // loads the core; a bad limit set still rejects, from the boundary's own
  // validation, after it. Both are exactly as before.
  await expect(createAiContextBoundary(null as never)).rejects.toThrow(TypeError);
  expect(core.calls).toEqual([]);
  await expect(createAiContextBoundary({ traversalLimits: undefined } as never)).rejects.toThrow(TypeError);
});
