/**
 * `@redact-secret/adapter-otel` is the previous name of
 * `@redact-secret/adapter-otel-trace`, kept so existing imports keep working.
 * It re-exports that package's API unchanged: the same functions and the
 * same class object, so `instanceof` and every option behave exactly as they
 * do when imported from the new name. Nothing here adds behavior.
 *
 * The package only ever covered **traces** (a `SpanProcessor`). It does not
 * protect OpenTelemetry Logs, and the new name says so. Migrate by changing
 * the import specifier:
 *
 * ```js
 * // before
 * import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel";
 * // after
 * import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";
 * ```
 *
 * The deprecation is carried by `@deprecated` on every export, the README,
 * and the npm registry. This module prints nothing at import or call time:
 * the package stays side-effect free.
 *
 * @packageDocumentation
 */

import * as trace from "@redact-secret/adapter-otel-trace";

/** @deprecated Import from `@redact-secret/adapter-otel-trace`; this name only covers traces. */
export type CoreActivation = trace.CoreActivation;
/** @deprecated Import from `@redact-secret/adapter-otel-trace`; this name only covers traces. */
export type MaskLeafOptions = trace.MaskLeafOptions;
/** @deprecated Import from `@redact-secret/adapter-otel-trace`; this name only covers traces. */
export type OtelSpanOutcome = trace.OtelSpanOutcome;
/** @deprecated Import from `@redact-secret/adapter-otel-trace`; this name only covers traces. */
export type RedactAttributesOptions = trace.RedactAttributesOptions;
/** @deprecated Import from `@redact-secret/adapter-otel-trace`; this name only covers traces. */
export type RedactingSpanProcessorOptions = trace.RedactingSpanProcessorOptions;
/** @deprecated Import from `@redact-secret/adapter-otel-trace`; this name only covers traces. */
export type CreateRedactingSpanProcessorOptions = trace.CreateRedactingSpanProcessorOptions;

/** @deprecated Import from `@redact-secret/adapter-otel-trace`; this name only covers traces. */
export const createRedactingSpanProcessor: typeof trace.createRedactingSpanProcessor =
  trace.createRedactingSpanProcessor;
/** @deprecated Import from `@redact-secret/adapter-otel-trace`; this name only covers traces. */
export const redactAttributesWith: typeof trace.redactAttributesWith = trace.redactAttributesWith;
/** @deprecated Import from `@redact-secret/adapter-otel-trace`; this name only covers traces. */
export const RedactingSpanProcessorWith: typeof trace.RedactingSpanProcessorWith = trace.RedactingSpanProcessorWith;
/** @deprecated Import from `@redact-secret/adapter-otel-trace`; this name only covers traces. */
export type RedactingSpanProcessorWith = trace.RedactingSpanProcessorWith;
