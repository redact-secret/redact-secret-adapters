/**
 * A `SpanProcessor` (OpenTelemetry JS, pinned against
 * `@opentelemetry/sdk-trace-base@2.11.0`:
 * https://github.com/open-telemetry/opentelemetry-js/blob/main/packages/sdk-trace/src/SpanProcessor.ts)
 * that redacts the span name, every string and string-array attribute —
 * including OpenInference (`llm.input_messages`, `input.value`, ...) and
 * GenAI semantic-convention attributes (`gen_ai.prompt`, ...) — each event's
 * name and attributes, the status message, and each link's attributes,
 * before handing the span to the next processor. It does not
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

import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
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
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

function maskAttributeValue(scanAndRedact: ScanAndRedact, value: unknown, options: MaskLeafOptions): unknown {
  if (typeof value === "string") {
    return maskLeafWith(scanAndRedact, value, options);
  }
  if (Array.isArray(value)) {
    // OpenTelemetry allows null/undefined holes in a homogeneous array, so
    // every string element is masked and every other element kept in place.
    return value.map((item) => (typeof item === "string" ? maskLeafWith(scanAndRedact, item, options) : item));
  }
  // Numbers and booleans cannot carry a secret as free text.
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

  /**
   * Forwards the SDK's optional, experimental `onEnding` (called while the
   * span is still writable). Typed structurally: it is absent from the
   * `SpanProcessor` interface at the low end of the declared SDK range.
   */
  onEnding(span: Span): void {
    (this.#next as { onEnding?: (span: Span) => void }).onEnding?.(span);
  }

  onEnd(span: ReadableSpan): void {
    const mask = (text: unknown) =>
      typeof text === "string" ? maskLeafWith(this.#scanAndRedact, text, this.#options) : text;
    const target = span as Mutable<ReadableSpan>;
    target.name = mask(span.name) as string;
    redactAttributesWith(this.#scanAndRedact, span.attributes, this.#options);
    for (const event of span.events ?? []) {
      (event as Mutable<typeof event>).name = mask(event.name) as string;
      redactAttributesWith(this.#scanAndRedact, event.attributes, this.#options);
    }
    if (span.status && typeof span.status.message === "string") {
      (span.status as Mutable<typeof span.status>).message = mask(span.status.message) as string;
    }
    for (const link of span.links ?? []) {
      redactAttributesWith(this.#scanAndRedact, link.attributes, this.#options);
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
