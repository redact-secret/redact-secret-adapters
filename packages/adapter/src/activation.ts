/**
 * The one core-activation step every live factory in this repository runs
 * (redact-secret/redact-secret-adapters#51).
 *
 * PII detection in `@redact-secret/core` is opt-in, **process-wide and
 * one-shot**: `initialize({ pii })` records a selection in a per-profile cell,
 * the first selection wins, and a later *different* selection fails with
 * `PII_ACTIVATION_CONFLICT`. An empty selection (`selectors=off`) is a
 * different selection, not a neutral one. That makes "who calls `initialize`
 * first" a contract question rather than an implementation detail, because an
 * adapter and its host both want to call it.
 *
 * Three rules settle it, and nothing here decides policy:
 *
 * 1. **No `pii` given.** Call `initialize()` as before, but treat a
 *    `PII_ACTIVATION_CONFLICT` as success. The conflict says the core is
 *    already loaded under the application's own selection — the application's
 *    choice to make, and not something an adapter should override or refuse.
 *    Every other initialization failure is rethrown exactly as before, so the
 *    fail-closed behaviour each host adapter documents is unchanged.
 * 2. **`pii` given.** Pass it through as `initialize({ pii })`, so the
 *    adapter-first order works and the selection is explicit in the caller's
 *    code rather than implied by import order.
 * 3. **`pii` given.** Read {@link readPiiActivation} afterwards and refuse
 *    when the active identity does not reflect what was asked for. Without
 *    this an adapter-first caller who lost the race would run with PII off and
 *    be told nothing, which is the failure this module exists to remove.
 *
 * `piiActivation()` is **optional** on the core binding — the core's own
 * runtime calls it as `native.piiActivation?.()` — so it is feature-detected
 * here. A core too old to report one keeps working when `pii` is omitted (the
 * declared `@redact-secret/core` floor does not move for this), and fails with
 * a fixed code when `pii` is passed, rather than silently doing nothing.
 *
 * Everything this module can throw carries a fixed message and a fixed code.
 * No selector, no input, no core exception message, and no field path is ever
 * read into an error, a return value, or a counter.
 *
 * ## Activation is not masking
 *
 * Activating PII selectors turns PII *detection* on. Under the core's default
 * policy, PII finding types are confidence-gated rather than always redacted:
 * a `High`-confidence PII finding redacts, and `Medium` and `Low` resolve to
 * `warn`. A `warn` finding leaves the text alone (see `./mask-leaf.ts`), so
 * lower-confidence PII still reaches a log line, a span or an AI context as
 * plaintext. A caller who needs all of it masked supplies their own `policy`
 * that maps those findings to `redact`; this repository decides nothing about
 * policy, and does not synthesize one. The outcome counters make the gap
 * visible: such a leaf is counted `scanned` with a non-zero `findings` and
 * **not** counted `redacted`.
 */

import type { CoreActivation, InitializableCore } from "./types.js";

/**
 * The core's own error code for "a different PII selection is already active
 * in this process". Matched by code only; the error's message is never read.
 */
export const PII_ACTIVATION_CONFLICT = "PII_ACTIVATION_CONFLICT";

/** The fixed codes {@link activateCore} refuses with. Input-free by construction. */
export type CoreActivationErrorCode = "PII_ACTIVATION_UNSUPPORTED" | "PII_ACTIVATION_NOT_ACTIVE";

const MESSAGES: Readonly<Record<CoreActivationErrorCode, string>> = Object.freeze({
  PII_ACTIVATION_UNSUPPORTED:
    "activateCore: this @redact-secret/core does not report a PII activation, so the pii option cannot be honored; upgrade the core or omit pii",
  PII_ACTIVATION_NOT_ACTIVE:
    "activateCore: the PII activation active in this process does not reflect the requested selection",
});

/**
 * A refusal to run with a PII selection that is not actually active. Its
 * `message` is one of two fixed strings and its `code` one of two fixed
 * codes; neither carries a selector, an input, or the core's own error text.
 */
export class CoreActivationError extends Error {
  readonly code: CoreActivationErrorCode;

  constructor(code: CoreActivationErrorCode) {
    super(MESSAGES[code]);
    this.name = "CoreActivationError";
    this.code = code;
  }
}

/** `error.code`, read defensively: a throwing getter must not become a different failure. */
function errorCode(error: unknown): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  try {
    const code: unknown = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Whether `error` is the core's "a different PII selection is already active" refusal. */
export function isPiiActivationConflict(error: unknown): boolean {
  return errorCode(error) === PII_ACTIVATION_CONFLICT;
}

/**
 * The selectors named by an activation identity, or `undefined` when the
 * string is not one.
 *
 * An identity looks like
 * `credentials=full;selectors=pii:global;families=pii:global:email,…;vocabulary=pii-context/v2`,
 * or `credentials=full;selectors=off;families=;vocabulary=pii-context/v2` when
 * PII is off. Only the `selectors` field is read, and only to compare it with
 * what the caller asked for — it is never logged, returned in an error, or
 * counted.
 */
function activeSelectors(identity: string): readonly string[] | undefined {
  for (const field of identity.split(";")) {
    const separator = field.indexOf("=");
    if (separator < 0) continue;
    if (field.slice(0, separator).trim() !== "selectors") continue;
    const value = field.slice(separator + 1).trim();
    // `off` and an empty field both mean "no selectors are active".
    if (value === "" || value === "off") return [];
    return value
      .split(",")
      .map((selector) => selector.trim())
      .filter((selector) => selector !== "");
  }
  return undefined;
}

/**
 * Whether `identity` reflects the requested `pii` selection.
 *
 * Deliberately strict, because the alternative is running under a selection
 * the caller did not ask for and never hearing about it: an empty request must
 * find PII off, and a non-empty one must find every requested selector active.
 * An identity this module cannot parse does not reflect anything and is
 * refused.
 */
export function activationReflects(identity: string | undefined, pii: readonly string[]): boolean {
  if (typeof identity !== "string") return false;
  const active = activeSelectors(identity);
  if (active === undefined) return false;
  const requested = [...new Set(pii)];
  if (requested.length === 0) return active.length === 0;
  return requested.every((selector) => active.includes(selector));
}

/**
 * The core's canonical activation identity, or `undefined` when this core does
 * not report one or the call fails. Feature-detected, never thrown from: a
 * core that predates `piiActivation()` is a supported core.
 */
export function readPiiActivation(core: InitializableCore): string | undefined {
  if (typeof core.piiActivation !== "function") return undefined;
  try {
    const identity: unknown = core.piiActivation();
    return typeof identity === "string" ? identity : undefined;
  } catch {
    return undefined;
  }
}

let observedActivation: string | undefined;

/**
 * The PII activation identity observed by the last successful
 * {@link activateCore} in this process, or `undefined` when none has been
 * observed — no live factory has run yet, or this core does not report one.
 *
 * This is the counter surface's companion, not part of it. An
 * `OutcomeCounter` is six non-negative integers and nothing else, so a string
 * does not belong on it (see `./outcome.ts`); the identity is a single
 * process-wide fact, read here on demand rather than repeated per log record
 * or per span. The core's selection is one-shot, so the value never changes
 * once set. It is the core's own canonical identity string and holds nothing
 * derived from any input.
 */
export function activePiiActivation(): string | undefined {
  return observedActivation;
}

function validSelection(pii: unknown): pii is readonly string[] {
  return Array.isArray(pii) && pii.every((selector) => typeof selector === "string");
}

/**
 * Loads-and-activates step for a live factory: `await activateCore(await
 * import("@redact-secret/core"), options)`.
 *
 * Resolves with the active PII activation identity when the core reports one,
 * else `undefined`. Rejects with the core's own error for an initialization
 * failure that is not a {@link PII_ACTIVATION_CONFLICT}, so each host
 * adapter's existing failure behaviour is unchanged, and with a
 * {@link CoreActivationError} when a requested `pii` selection cannot be shown
 * to be active.
 */
export async function activateCore(
  core: InitializableCore,
  activation: CoreActivation = {},
): Promise<string | undefined> {
  if (core === null || typeof core !== "object" || typeof core.initialize !== "function") {
    throw new TypeError("activateCore: core must expose initialize()");
  }
  if (activation === null || typeof activation !== "object") {
    throw new TypeError("activateCore: activation must be an object");
  }
  const { pii } = activation;

  if (pii === undefined) {
    try {
      await core.initialize();
    } catch (error) {
      // A conflict is the application's own selection winning the race, which
      // is exactly the outcome this path wants. Anything else still fails.
      if (!isPiiActivationConflict(error)) throw error;
    }
    return remember(readPiiActivation(core));
  }

  if (!validSelection(pii)) {
    throw new TypeError("activateCore: pii must be an array of selector strings");
  }
  if (typeof core.piiActivation !== "function") {
    throw new CoreActivationError("PII_ACTIVATION_UNSUPPORTED");
  }
  try {
    await core.initialize({ pii });
  } catch (error) {
    // A conflict here is not yet a failure: an application that already
    // activated the same selection is a correct setup, and one that activated
    // a different one is caught by the check below, with a fixed code rather
    // than the core's message.
    if (!isPiiActivationConflict(error)) throw error;
  }
  const identity = readPiiActivation(core);
  if (!activationReflects(identity, pii)) {
    throw new CoreActivationError("PII_ACTIVATION_NOT_ACTIVE");
  }
  return remember(identity);
}

function remember(identity: string | undefined): string | undefined {
  if (identity !== undefined) observedActivation = identity;
  return identity;
}
