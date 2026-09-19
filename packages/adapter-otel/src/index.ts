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
 * factory enforces that order. This is the only module in the package that
 * imports `@redact-secret/core` at runtime.
 */

import type { SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { initialize, scanAndRedact } from "@redact-secret/core";

import { type RedactAttributesOptions, RedactingSpanProcessorWith } from "./span-processor.js";

export { type RedactAttributesOptions, RedactingSpanProcessorWith, redactAttributesWith } from "./span-processor.js";

/** Awaits `initialize()` once, then wraps `next` with the real scanner. */
export async function createRedactingSpanProcessor(
  next: SpanProcessor,
  options: RedactAttributesOptions = {},
): Promise<RedactingSpanProcessorWith> {
  await initialize();
  return new RedactingSpanProcessorWith(next, scanAndRedact, options);
}
