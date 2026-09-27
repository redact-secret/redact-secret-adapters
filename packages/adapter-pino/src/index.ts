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
 */

import type { MaskOptions, ScanAndRedact } from "@redact-secret/adapter";

import { createRedactingHooksWith, type RedactingHooks, type RedactingHooksOptions } from "./hooks.js";
import { createRedactingLogMethodWith, type RedactingLogMethod } from "./log-method.js";
import { createRedactingStreamWriteWith, type RedactingStreamWrite } from "./stream-write.js";

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
export { createRedactingStreamWriteWith, PINO_ERROR_LINE, type RedactingStreamWrite } from "./stream-write.js";

async function initializedScanner(): Promise<ScanAndRedact> {
  const { initialize, scanAndRedact } = await import("@redact-secret/core");
  await initialize();
  return scanAndRedact;
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
 */
export async function createRedactingHooks(options: RedactingHooksOptions = {}): Promise<RedactingHooks> {
  return createRedactingHooksWith(await initializedScanner(), options);
}

/**
 * Awaits `initialize()` once, then returns a pino `hooks.logMethod`.
 *
 * This hook alone is **not** the complete boundary: it never sees
 * child-logger bindings or `mixin()` output. Prefer
 * {@link createRedactingHooks}; this factory stays for advanced composition
 * and for callers migrating from `0.1.0`.
 */
export async function createRedactingLogMethod(options: MaskOptions = {}): Promise<RedactingLogMethod> {
  return createRedactingLogMethodWith(await initializedScanner(), options);
}

/**
 * Awaits `initialize()` once, then returns a pino `hooks.streamWrite`.
 *
 * This hook alone is **not** the complete boundary: the host's own
 * serializers, `formatters` and `redact` run over raw values before it. Prefer
 * {@link createRedactingHooks}.
 */
export async function createRedactingStreamWrite(options: MaskOptions = {}): Promise<RedactingStreamWrite> {
  return createRedactingStreamWriteWith(await initializedScanner(), options);
}
