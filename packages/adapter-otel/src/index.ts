/**
 * The live OpenTelemetry JS integration:
 *
 * ```js
 * import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
 * import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel";
 *
 * const provider = new NodeTracerProvider({
 *   spanProcessors: [await createRedactingSpanProcessor(new BatchSpanProcessor(exporter))],
 * });
 * ```
 *
 * `await initialize()` must resolve before `scanAndRedact` is used; this
 * factory enforces that order. It is the only code in the package that loads
 * `@redact-secret/core` at runtime, and does so on call (as
 * `@redact-secret/adapter`'s `createMaskSecrets` does), so importing the
 * injected API never loads the native core.
 *
 * PII detection is opt-in and process-wide in the core. Omit `pii` and this
 * factory initializes the core as before and accepts whatever selection the
 * application already activated, in either order. Pass
 * `createRedactingSpanProcessor(next, { pii: ["pii:global"] })` to activate a
 * selection from here instead, and the factory rejects rather than run with
 * PII off. See `@redact-secret/adapter`'s `activateCore` for the whole rule,
 * including why activation is not the same as masking every PII value.
 */

import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { activateCore, type CoreActivation } from "@redact-secret/adapter";

import { type RedactingSpanProcessorOptions, RedactingSpanProcessorWith } from "./span-processor.js";

export type { CoreActivation, MaskLeafOptions } from "@redact-secret/adapter";
export {
  type OtelSpanOutcome,
  type RedactAttributesOptions,
  type RedactingSpanProcessorOptions,
  RedactingSpanProcessorWith,
  redactAttributesWith,
} from "./span-processor.js";

/** {@link RedactingSpanProcessorOptions} plus the live factory's PII activation. */
export type CreateRedactingSpanProcessorOptions = RedactingSpanProcessorOptions & CoreActivation;

/**
 * Awaits `initialize()` once, then wraps `next` with the real scanner.
 * `options.onOutcome` reports one input-free summary per span.
 *
 * `options.pii` activates core PII selectors for the whole process. Omit it
 * and an activation the application already made is accepted rather than
 * fought over. Pass it and this rejects — with a fixed message and code, never
 * a selector or a core message — rather than run with PII off.
 */
export async function createRedactingSpanProcessor(
  next: SpanProcessor,
  options: CreateRedactingSpanProcessorOptions = {},
): Promise<RedactingSpanProcessorWith> {
  // `pii` is read by property so an inherited activation survives, and
  // `options` is forwarded as the same object so every other inherited key
  // does too. `pii` rides along unread, as any unknown key would.
  const activation: CoreActivation = options.pii === undefined ? {} : { pii: options.pii };
  const loaded = await import("@redact-secret/core");
  await activateCore(loaded, activation);
  return new RedactingSpanProcessorWith(next, loaded.scanAndRedact, options);
}
