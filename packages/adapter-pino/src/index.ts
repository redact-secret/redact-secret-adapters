/**
 * The live pino integration. One setup step installs the complete boundary:
 *
 * ```js
 * import pino from "pino";
 * import { createRedactingHooks } from "@redact-secret/adapter-pino";
 *
 * const logger = pino({
 *   hooks: await createRedactingHooks(),
 *   redact: ["req.headers.authorization"], // pino's own path-based redact still applies, on top
 * });
 * ```
 *
 * `createRedactingHooks` returns both hooks pino needs: `logMethod`, which
 * sees a call's arguments before pino serializes or formats anything, and
 * `streamWrite`, which sees the finished line and so covers child-logger
 * bindings and `mixin()` output. Neither covers the other's input, which is
 * why they are installed together. Pass the application's own
 * `hooks` to compose with them rather than replace them:
 * `createRedactingHooks({ hooks: myHooks })`.
 *
 * `await initialize()` must resolve before `scanAndRedact` is used; these
 * factories enforce that order. They are the only code in the package that
 * loads `@redact-secret/core` at runtime, and do so on call (as
 * `@redact-secret/adapter`'s `createMaskSecrets` does), so importing the
 * injected API never loads the native core.
 *
 * PII detection is opt-in and process-wide in the core. Omit `pii` and these
 * factories initialize the core as before and accept whatever selection the
 * application already activated, in either order. Pass
 * `createRedactingHooks({ pii: ["pii:global"] })` to activate a selection from
 * here instead, and the factory rejects rather than run with PII off. See
 * `@redact-secret/adapter`'s `activateCore` for the whole rule, including why
 * activation is not the same as masking every PII value.
 */

import { activateCore, type CoreActivation, type MaskOptions, type ScanAndRedact } from "@redact-secret/adapter";

import { createRedactingHooksWith, type RedactingHooks, type RedactingHooksOptions } from "./hooks.js";
import { createRedactingLogMethodWith, type RedactingLogMethod } from "./log-method.js";
import { createRedactingStreamWriteWith, type RedactingStreamWrite, type StreamWriteOptions } from "./stream-write.js";

export { formatPinoMessage } from "./format-message.js";
export {
  createRedactingHooksWith,
  type PinoHostHooks,
  type PinoLogOutcome,
  type PinoRedactionStage,
  type RedactingHooks,
  type RedactingHooksOptions,
} from "./hooks.js";
export { createRedactingLogMethodWith, type RedactingLogMethod } from "./log-method.js";
export {
  createRedactingStreamWriteWith,
  DEFAULT_LINE_LIMITS,
  PINO_ERROR_LINE,
  PINO_LIMIT_LINE,
  type PinoLineLimits,
  type RedactingStreamWrite,
  type StreamWriteOptions,
} from "./stream-write.js";

/** {@link RedactingHooksOptions} plus the live factory's PII activation. */
export type CreateRedactingHooksOptions = RedactingHooksOptions & CoreActivation;

/** {@link MaskOptions} plus the live single-hook factories' PII activation. */
export type CreateRedactingHookOptions = MaskOptions & CoreActivation;

/** {@link StreamWriteOptions} (walk options plus `lineLimits`) plus the live factory's PII activation. */
export type CreateRedactingStreamWriteOptions = StreamWriteOptions & CoreActivation;

/**
 * Reads `pii` by property, not by rest-destructuring: a property read follows
 * the prototype chain, so an options object layered over a shared base
 * (`Object.create(defaults)`) keeps its activation — and, just as importantly,
 * the rest of `options` reaches the injected factory as the same object,
 * inherited `hooks`, `policy` and `onOutcome` included. `pii` itself rides
 * along as an unread extra key, the way every other unknown key does.
 */
function activationOf(options: CoreActivation): CoreActivation {
  return options.pii === undefined ? {} : { pii: options.pii };
}

async function initializedScanner(activation: CoreActivation): Promise<ScanAndRedact> {
  const loaded = await import("@redact-secret/core");
  await activateCore(loaded, activation);
  return loaded.scanAndRedact;
}

/**
 * Awaits `initialize()` once, then returns both pino hooks — the complete
 * supported boundary — ready to pass as `pino({ hooks })`.
 *
 * `options.hooks` is the application's own `hooks` object; its `logMethod`
 * and `streamWrite` are composed with the redacting ones (redaction runs
 * last, closest to the bytes) rather than replaced, and any other key is
 * forwarded unchanged. `options.policy` and `options.limits` go to both
 * hooks.
 *
 * `options.pii` activates core PII selectors for the whole process. Omit it
 * and an activation the application already made is accepted rather than
 * fought over. Pass it and this rejects — with a fixed message and code, never
 * a selector or a core message — rather than run with PII off.
 */
export async function createRedactingHooks(options: CreateRedactingHooksOptions = {}): Promise<RedactingHooks> {
  return createRedactingHooksWith(await initializedScanner(activationOf(options)), options);
}

/**
 * Awaits `initialize()` once, then returns a pino `hooks.logMethod`.
 *
 * This hook alone is **not** the complete boundary: it never sees
 * child-logger bindings or `mixin()` output. Prefer
 * {@link createRedactingHooks}; this factory stays for advanced composition
 * and for callers migrating from `0.1.0`.
 */
export async function createRedactingLogMethod(options: CreateRedactingHookOptions = {}): Promise<RedactingLogMethod> {
  return createRedactingLogMethodWith(await initializedScanner(activationOf(options)), options);
}

/**
 * Awaits `initialize()` once, then returns a pino `hooks.streamWrite`.
 *
 * This hook alone is **not** the complete boundary: the host's own
 * serializers, `formatters` and `redact` run over raw values before it. Prefer
 * {@link createRedactingHooks}.
 */
export async function createRedactingStreamWrite(
  options: CreateRedactingStreamWriteOptions = {},
): Promise<RedactingStreamWrite> {
  return createRedactingStreamWriteWith(await initializedScanner(activationOf(options)), options);
}
