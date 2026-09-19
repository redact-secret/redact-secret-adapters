/**
 * The live pino integration:
 *
 * ```js
 * import pino from "pino";
 * import { createRedactingLogMethod } from "@redact-secret/adapter-pino";
 *
 * const logger = pino({
 *   hooks: { logMethod: await createRedactingLogMethod() },
 *   redact: ["req.headers.authorization"], // pino's own path-based redact still applies, on top
 * });
 * ```
 *
 * `await initialize()` must resolve before `scanAndRedact` is used; this
 * factory enforces that order. This is the only module in the package that
 * imports `@redact-secret/core` at runtime.
 */

import type { MaskOptions } from "@redact-secret/adapter";
import { initialize, scanAndRedact } from "@redact-secret/core";

import { createRedactingLogMethodWith, type RedactingLogMethod } from "./log-method.js";

export { formatPinoMessage } from "./format-message.js";
export { createRedactingLogMethodWith, type RedactingLogMethod } from "./log-method.js";

/** Awaits `initialize()` once, then returns a pino `hooks.logMethod`. */
export async function createRedactingLogMethod(options: MaskOptions = {}): Promise<RedactingLogMethod> {
  await initialize();
  return createRedactingLogMethodWith(scanAndRedact, options);
}
