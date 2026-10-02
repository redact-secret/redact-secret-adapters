/**
 * The live OpenTelemetry JS **logs** integration: a `LogRecordProcessor`. It
 * does not see spans or metrics; the trace package
 * (`@redact-secret/adapter-otel-trace`) does not see log records. Each signal
 * has its own package, its own peer range and its own qualification.
 *
 * ```js
 * import { LoggerProvider, BatchLogRecordProcessor } from "@opentelemetry/sdk-logs";
 * import { createRedactingLogRecordProcessor } from "@redact-secret/adapter-otel-logs";
 *
 * const loggerProvider = new LoggerProvider({
 *   processors: [await createRedactingLogRecordProcessor(new BatchLogRecordProcessor(exporter))],
 * });
 * ```
 *
 * `await initialize()` must resolve before `scanAndRedact` is used; this
 * factory enforces that order. It is the only code in the package that loads
 * `@redact-secret/core` at runtime, and does so on call, so importing the
 * injected API never loads the native core.
 *
 * PII detection is opt-in and process-wide in the core. Omit `pii` and this
 * factory initializes the core as before and accepts whatever selection the
 * application already activated, in either order. Pass
 * `createRedactingLogRecordProcessor(next, { pii: ["pii:global"] })` to
 * activate a selection from here instead, and the factory rejects rather than
 * run with PII off. See `@redact-secret/adapter`'s `activateCore`.
 */

import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { activateCore, type CoreActivation } from "@redact-secret/adapter";

import { type RedactingLogRecordProcessorOptions, RedactingLogRecordProcessorWith } from "./log-record-processor.js";

export type { CoreActivation, Limits, MaskLeafOptions } from "@redact-secret/adapter";
export {
  type OtelLogRecordOutcome,
  type RedactingLogRecordProcessorOptions,
  RedactingLogRecordProcessorWith,
} from "./log-record-processor.js";

/** {@link RedactingLogRecordProcessorOptions} plus the live factory's PII activation. */
export type CreateRedactingLogRecordProcessorOptions = RedactingLogRecordProcessorOptions & CoreActivation;

/**
 * Awaits `initialize()` once, then wraps `next` with the real scanner.
 * `options.onOutcome` reports one input-free summary per log record.
 *
 * `options.pii` activates core PII selectors for the whole process. Omit it
 * and an activation the application already made is accepted rather than
 * fought over. Pass it and this rejects — with a fixed message and code, never
 * a selector or a core message — rather than run with PII off.
 */
export async function createRedactingLogRecordProcessor(
  next: LogRecordProcessor,
  options: CreateRedactingLogRecordProcessorOptions = {},
): Promise<RedactingLogRecordProcessorWith> {
  // `pii` is read by property so an inherited activation survives, and
  // `options` is forwarded as the same object so every other inherited key
  // does too. `pii` rides along unread, as any unknown key would.
  const activation: CoreActivation = options.pii === undefined ? {} : { pii: options.pii };
  const loaded = await import("@redact-secret/core");
  await activateCore(loaded, activation);
  return new RedactingLogRecordProcessorWith(next, loaded.scanAndRedact, options);
}
