/**
 * `activateCore`: the one process-wide PII activation step every live factory
 * runs (redact-secret/redact-secret-adapters#51).
 *
 * The core is injected here, as everywhere else in this package, so these run
 * without the native artifact. That also suits the behaviour under test,
 * which is a *lifecycle* one: a real core's selection cell is one-shot per
 * process, so a suite could exercise exactly one ordering against it.
 *
 * Injection alone is not enough, though — it cannot tell whether a live
 * factory still routes through `activateCore` at all, which is how
 * `createMaskSecrets` kept a bare `initialize()` through #51. A real core,
 * one ordering per spawned process, covers that in
 * `activation-live.test.ts`.
 *
 * No selector string here is a credential and none of them is real; they are
 * the core's own documented activation-identity shape.
 */

import { expect, test, vi } from "vitest";

import {
  activateCore,
  activationReflects,
  activePiiActivation,
  CoreActivationError,
  isPiiActivationConflict,
  PII_ACTIVATION_CONFLICT,
  readPiiActivation,
} from "../src/index.js";

const PII_ON = "credentials=full;selectors=pii:global;families=email,phone;vocabulary=pii-context/v1";
const PII_TWO = "credentials=full;selectors=pii:global,pii:eu;families=email;vocabulary=pii-context/v1";
const PII_OFF = "credentials=full;selectors=off;families=;vocabulary=pii-context/v1";

/** The core's own refusal, shape included: a code, plus a message nothing reads. */
function conflict(): Error {
  return Object.assign(new Error("a different PII selection is already active"), {
    code: PII_ACTIVATION_CONFLICT,
  });
}

function initializationFailed(): Error {
  return Object.assign(new Error("artifact missing near SECRET_TOKEN_1"), { code: "INITIALIZATION_FAILED" });
}

/** A core that records how `initialize` was called and reports a fixed identity. */
function fakeCore(options: { identity?: string | (() => string); rejectWith?: () => Error } = {}) {
  const initialize = vi.fn(async () => {
    if (options.rejectWith !== undefined) throw options.rejectWith();
  });
  const core: { initialize: typeof initialize; piiActivation?: () => string } = { initialize };
  if (options.identity !== undefined) {
    const identity = options.identity;
    core.piiActivation = typeof identity === "function" ? identity : () => identity;
  }
  return core;
}

test("without pii it initializes as before, and reports no identity for a core that has none", async () => {
  const core = fakeCore();
  await expect(activateCore(core)).resolves.toBeUndefined();
  // The floor protection: the argument-free call a beta.6 core accepts.
  expect(core.initialize).toHaveBeenCalledWith();
});

test("without pii an activation conflict is success: the application's own selection wins", async () => {
  const core = fakeCore({ identity: PII_ON, rejectWith: conflict });
  await expect(activateCore(core)).resolves.toBe(PII_ON);
  await expect(activateCore(core, {})).resolves.toBe(PII_ON);
});

test("without pii every other initialization failure is rethrown unchanged", async () => {
  const failure = initializationFailed();
  const core = fakeCore({ rejectWith: () => failure });
  await expect(activateCore(core)).rejects.toBe(failure);
});

test("with pii the selection is forwarded to initialize", async () => {
  const core = fakeCore({ identity: PII_ON });
  await expect(activateCore(core, { pii: ["pii:global"] })).resolves.toBe(PII_ON);
  expect(core.initialize).toHaveBeenCalledWith({ pii: ["pii:global"] });
});

test("with pii a conflict is absorbed when the active identity already reflects the request", async () => {
  const core = fakeCore({ identity: PII_ON, rejectWith: conflict });
  await expect(activateCore(core, { pii: ["pii:global"] })).resolves.toBe(PII_ON);
});

test("with pii an active identity that does not reflect the request is refused, with a fixed code", async () => {
  const core = fakeCore({ identity: PII_OFF });
  const refusal = await activateCore(core, { pii: ["pii:global"] }).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(CoreActivationError);
  expect((refusal as CoreActivationError).code).toBe("PII_ACTIVATION_NOT_ACTIVE");
  expect((refusal as CoreActivationError).message).toBe(
    "activateCore: the PII activation active in this process does not reflect the requested selection",
  );
});

test("a refusal echoes no selector, no active identity, and no core message", async () => {
  const core = fakeCore({ identity: PII_OFF, rejectWith: conflict });
  const refusal = await activateCore(core, { pii: ["pii:global"] }).catch((error: unknown) => error);
  const text = `${(refusal as Error).message}\n${String((refusal as Error).stack).split("\n")[0]}`;
  expect(text).not.toContain("pii:global");
  expect(text).not.toContain("selectors=");
  expect(text).not.toContain("a different PII selection is already active");
});

test("with pii a core that reports no activation fails clearly, and is never initialized", async () => {
  const core = fakeCore();
  const refusal = await activateCore(core, { pii: ["pii:global"] }).catch((error: unknown) => error);
  expect(refusal).toBeInstanceOf(CoreActivationError);
  expect((refusal as CoreActivationError).code).toBe("PII_ACTIVATION_UNSUPPORTED");
  // Refused before touching the core, so a too-old core is never locked to a
  // selection it cannot report.
  expect(core.initialize).not.toHaveBeenCalled();
});

test("an empty selection is a selection: it requires PII off and refuses PII on", async () => {
  await expect(activateCore(fakeCore({ identity: PII_OFF }), { pii: [] })).resolves.toBe(PII_OFF);
  await expect(activateCore(fakeCore({ identity: PII_ON }), { pii: [] })).rejects.toBeInstanceOf(CoreActivationError);
});

test("every requested selector must be active, not just one of them", async () => {
  await expect(activateCore(fakeCore({ identity: PII_TWO }), { pii: ["pii:global", "pii:eu"] })).resolves.toBe(PII_TWO);
  await expect(activateCore(fakeCore({ identity: PII_ON }), { pii: ["pii:global", "pii:eu"] })).rejects.toBeInstanceOf(
    CoreActivationError,
  );
});

test("a piiActivation that throws is an identity that reflects nothing, and never a different failure", async () => {
  const throwing = () => {
    throw new Error("piiActivation exploded near SECRET_TOKEN_1");
  };
  expect(readPiiActivation(fakeCore({ identity: throwing }))).toBeUndefined();
  await expect(activateCore(fakeCore({ identity: throwing }), { pii: ["pii:global"] })).rejects.toBeInstanceOf(
    CoreActivationError,
  );
  // Without a selection to assert, an unreadable identity is simply no identity.
  await expect(activateCore(fakeCore({ identity: throwing }))).resolves.toBeUndefined();
});

test("a malformed selection is a programming error, with a message that echoes nothing", async () => {
  await expect(activateCore(fakeCore({ identity: PII_ON }), { pii: "pii:global" as never })).rejects.toThrow(
    "activateCore: pii must be an array of selector strings",
  );
  await expect(activateCore(fakeCore({ identity: PII_ON }), { pii: [1] as never })).rejects.toThrow(TypeError);
  await expect(activateCore({} as never)).rejects.toThrow(TypeError);
  await expect(activateCore(fakeCore(), null as never)).rejects.toThrow(TypeError);
});

test("isPiiActivationConflict reads only the code, and survives a throwing getter", () => {
  expect(isPiiActivationConflict(conflict())).toBe(true);
  expect(isPiiActivationConflict(initializationFailed())).toBe(false);
  expect(isPiiActivationConflict(new Error(PII_ACTIVATION_CONFLICT))).toBe(false);
  expect(isPiiActivationConflict(null)).toBe(false);
  const hostile = {};
  Object.defineProperty(hostile, "code", {
    get() {
      throw new Error("hostile getter");
    },
  });
  expect(isPiiActivationConflict(hostile)).toBe(false);
});

test("activationReflects refuses an identity it cannot parse rather than assuming", () => {
  expect(activationReflects(PII_ON, ["pii:global"])).toBe(true);
  expect(activationReflects(PII_OFF, [])).toBe(true);
  expect(activationReflects("credentials=full;vocabulary=pii-context/v1", ["pii:global"])).toBe(false);
  expect(activationReflects("", ["pii:global"])).toBe(false);
  expect(activationReflects(undefined, [])).toBe(false);
  // A duplicate in the request is still one selector.
  expect(activationReflects(PII_ON, ["pii:global", "pii:global"])).toBe(true);
});

test("activePiiActivation reports the identity, once, outside the six-integer counter", async () => {
  await activateCore(fakeCore({ identity: PII_TWO }), { pii: ["pii:global"] });
  expect(activePiiActivation()).toBe(PII_TWO);
  // It is a string, so it is deliberately not a counter field: an
  // `OutcomeCounter` is six non-negative integers and nothing else.
  expect(typeof activePiiActivation()).toBe("string");
});
