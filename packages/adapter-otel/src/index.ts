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
 */

import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { MaskLeafOptions } from "@redact-secret/adapter";

import { RedactingSpanProcessorWith } from "./span-processor.js";

export type { MaskLeafOptions } from "@redact-secret/adapter";
export { type RedactAttributesOptions, RedactingSpanProcessorWith, redactAttributesWith } from "./span-processor.js";

/** Awaits `initialize()` once, then wraps `next` with the real scanner. */
export async function createRedactingSpanProcessor(
  next: SpanProcessor,
  options: MaskLeafOptions = {},
): Promise<RedactingSpanProcessorWith> {
  const { initialize, scanAndRedact } = await import("@redact-secret/core");
  await initialize();
  return new RedactingSpanProcessorWith(next, scanAndRedact, options);
}
