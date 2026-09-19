/**
 * A `SpanProcessor` (OpenTelemetry JS, pinned against
 * `@opentelemetry/sdk-trace-base@2.11.0`:
 * https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/sdk-trace/src/SpanProcessor.ts)
 * that redacts every string and string-array attribute — including
 * OpenInference (`llm.input_messages`, `input.value`, ...) and GenAI
 * semantic-convention attributes (`gen_ai.prompt`, ...) — on a span and its
 * events before handing the span to the next processor. It does not
 * allowlist those attribute names: every string-shaped attribute value is
 * scanned, which covers any semantic convention without hardcoding it and
 * without a dependency on either convention's attribute list.
 *
 * `ReadableSpan.attributes` is typed `readonly` but is a plain, mutable
 * object at runtime (not frozen); `onEnd` mutates it in place, matching
 * how community OTel JS redaction processors work. That assumption is
 * load-bearing: a frozen `attributes` object would make this processor a
 * silent no-op, so `test/otel-host.test.ts` asserts the mutation took
 * effect on a real span, at both ends of the declared SDK range.
 *
 * This file never imports `@opentelemetry/sdk-trace-base` at runtime — the
 * imports below are `import type`, erased at compile time. A
 * `SpanProcessor` is a structural (duck-typed) interface in JS, so
 * wrapping one needs no dependency, and this module is testable with a
 * plain object.
 */

import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { MaskLeafOptions, ScanAndRedact } from "@redact-secret/adapter";
import { maskLeafWith } from "@redact-secret/adapter";

/**
 * Options for the span processor: `policy` and `maxStringLength`, passed
 * straight to `maskLeafWith`. Attribute bags are flat, so no walk budget
 * applies.
 */
export type RedactAttributesOptions = MaskLeafOptions;

/** A mutable view of an attribute bag; see the module docstring. */
type MutableAttributes = Record<string, unknown>;

function maskAttributeValue(scanAndRedact: ScanAndRedact, value: unknown, options: MaskLeafOptions): unknown {
  if (typeof value === "string") {
    return maskLeafWith(scanAndRedact, value, options);
  }
  if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
    return value.map((item) => maskLeafWith(scanAndRedact, item, options));
  }
  // Numbers, booleans, and homogeneous number/boolean arrays are the only
  // other attribute value shapes OpenTelemetry allows; none of them can
  // carry a secret as free text, so they pass through unchanged.
  return value;
}

/** Mutates `attributes` in place. A no-op for `undefined`/`null`. */
export function redactAttributesWith(
  scanAndRedact: ScanAndRedact,
  attributes: object | null | undefined,
  options: RedactAttributesOptions = {},
): void {
  if (attributes == null) return;
  const bag = attributes as MutableAttributes;
  for (const key of Object.keys(bag)) {
    bag[key] = maskAttributeValue(scanAndRedact, bag[key], options);
  }
}

/**
 * Wraps `next` (any object shaped like a `SpanProcessor`) and redacts
 * every span's and event's string attributes before delegating to it.
 * `scanAndRedact` is injected so this class is testable without the built
 * native addon; see `./index.ts` for the live factory.
 */
export class RedactingSpanProcessorWith implements SpanProcessor {
  readonly #next: SpanProcessor;
  readonly #scanAndRedact: ScanAndRedact;
  readonly #options: RedactAttributesOptions;

  constructor(next: SpanProcessor, scanAndRedact: ScanAndRedact, options: RedactAttributesOptions = {}) {
    if (typeof next?.onEnd !== "function") {
      throw new TypeError("RedactingSpanProcessorWith: next must be a SpanProcessor");
    }
    if (typeof scanAndRedact !== "function") {
      throw new TypeError("RedactingSpanProcessorWith: scanAndRedact must be a function");
    }
    this.#next = next;
    this.#scanAndRedact = scanAndRedact;
    this.#options = options;
  }

  onStart(...args: Parameters<SpanProcessor["onStart"]>): void {
    this.#next.onStart?.(...args);
  }

  onEnd(span: ReadableSpan): void {
    redactAttributesWith(this.#scanAndRedact, span.attributes, this.#options);
    for (const event of span.events ?? []) {
      redactAttributesWith(this.#scanAndRedact, event.attributes, this.#options);
    }
    this.#next.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.#next.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#next.forceFlush ? this.#next.forceFlush() : Promise.resolve();
  }
}
