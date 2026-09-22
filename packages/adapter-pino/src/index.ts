/**
 * The live pino integration:
 *
 * ```js
 * import pino from "pino";
 * import { createRedactingLogMethod, createRedactingStreamWrite } from "@redact-secret/adapter-pino";
 *
 * const logger = pino({
 *   hooks: {
 *     logMethod: await createRedactingLogMethod(),
 *     streamWrite: await createRedactingStreamWrite(), // child bindings and mixin() output
 *   },
 *   redact: ["req.headers.authorization"], // pino's own path-based redact still applies, on top
 * });
 * ```
 *
 * `await initialize()` must resolve before `scanAndRedact` is used; these
 * factories enforce that order. They are the only code in the package that
 * loads `@redact-secret/core` at runtime, and do so on call (as
 * `@redact-secret/adapter`'s `createMaskSecrets` does), so importing the
 * injected API never loads the native core.
 */

import type { MaskOptions, ScanAndRedact } from "@redact-secret/adapter";

import { createRedactingLogMethodWith, type RedactingLogMethod } from "./log-method.js";
import { createRedactingStreamWriteWith, type RedactingStreamWrite } from "./stream-write.js";

export { formatPinoMessage } from "./format-message.js";
export { createRedactingLogMethodWith, type RedactingLogMethod } from "./log-method.js";
export { createRedactingStreamWriteWith, type RedactingStreamWrite } from "./stream-write.js";

async function initializedScanner(): Promise<ScanAndRedact> {
  const { initialize, scanAndRedact } = await import("@redact-secret/core");
  await initialize();
  return scanAndRedact;
}

/** Awaits `initialize()` once, then returns a pino `hooks.logMethod`. */
export async function createRedactingLogMethod(options: MaskOptions = {}): Promise<RedactingLogMethod> {
  return createRedactingLogMethodWith(await initializedScanner(), options);
}

/** Awaits `initialize()` once, then returns a pino `hooks.streamWrite`. */
export async function createRedactingStreamWrite(options: MaskOptions = {}): Promise<RedactingStreamWrite> {
  return createRedactingStreamWriteWith(await initializedScanner(), options);
}
