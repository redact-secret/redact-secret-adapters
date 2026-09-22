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
 * `ReadableSpan`'s fields are typed `readonly` but are plain, writable
 * objects at runtime, and `onEnd` writes the masked values back in place.
 * Every write is read back. If one does not take (a frozen bag, a setter
 * that ignores it), the span is dropped — never forwarded unredacted —
 * with a one-time process warning naming the field, never its value.
 * `test/otel-host.test.ts` asserts the writes take effect on a real span,
 * at both ends of the declared SDK range.
 *
 * This file never imports `@opentelemetry/sdk-trace-base` at runtime — the
 * imports below are `import type`, erased at compile time. A
 * `SpanProcessor` is a structural (duck-typed) interface in JS, so
 * wrapping one needs no dependency, and this module is testable with a
 * plain object.
 */

import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { MaskLeafOptions, ScanAndRedact } from "@redact-secret/adapter";
import { ERROR_MARKER, maskLeafWith } from "@redact-secret/adapter";

/**
 * Options for the span processor: `policy` and `maxStringLength`, passed
 * straight to `maskLeafWith`. Attribute bags are flat, so no walk budget
 * applies.
 */
export type RedactAttributesOptions = MaskLeafOptions;

type Mask = (text: string) => string;

/** A span field that did not take a masked write. The message names the field, never its value. */
class UnredactableFieldError extends Error {}

function maskerFor(scanAndRedact: ScanAndRedact, options: MaskLeafOptions): Mask {
  return (text) => {
    try {
      return maskLeafWith(scanAndRedact, text, options);
    } catch {
      return ERROR_MARKER;
    }
  };
}

/** The masked value, or `value` itself when nothing in it changed. */
function maskAttributeValue(mask: Mask, value: unknown): unknown {
  if (typeof value === "string") return mask(value);
  if (Array.isArray(value)) {
    // OpenTelemetry allows null/undefined holes in a homogeneous array, so
    // every string element is masked and every other element kept in place.
    const masked = value.map((item) => (typeof item === "string" ? mask(item) : item));
    return masked.some((item, index) => item !== value[index]) ? masked : value;
  }
  // Numbers and booleans cannot carry a secret as free text.
  return value;
}

/** Writes `value` to `target[key]` if it differs, and throws if the write does not show. */
function writeBack(target: object, key: string, value: unknown, field: string): void {
  const record = target as Record<string, unknown>;
  if (record[key] === value) return;
  try {
    record[key] = value;
  } catch {
    throw new UnredactableFieldError(`${field} did not take the masked write`);
  }
  if (record[key] !== value) throw new UnredactableFieldError(`${field} did not take the masked write`);
}

function redactBag(mask: Mask, bag: object | null | undefined, field: string): void {
  if (bag == null) return;
  for (const key of Object.keys(bag)) {
    writeBack(bag, key, maskAttributeValue(mask, (bag as Record<string, unknown>)[key]), field);
  }
}

/**
 * Mutates `attributes` in place. A no-op for `undefined`/`null`. Throws a
 * `TypeError` naming no value if a masked value cannot be written back.
 */
export function redactAttributesWith(
  scanAndRedact: ScanAndRedact,
  attributes: object | null | undefined,
  options: RedactAttributesOptions = {},
): void {
  try {
    redactBag(maskerFor(scanAndRedact, options), attributes, "attributes");
  } catch {
    throw new TypeError("redactAttributesWith: a masked attribute could not be written back");
  }
}

function redactSpan(mask: Mask, span: ReadableSpan): void {
  if (typeof span.name === "string") writeBack(span, "name", mask(span.name), "span.name");
  redactBag(mask, span.attributes, "span.attributes");
  const status = span.status;
  if (typeof status?.message === "string") {
    const message = mask(status.message);
    // Replaced, not mutated: the status object may be the caller's own.
    if (message !== status.message) writeBack(span, "status", { ...status, message }, "span.status");
  }
  for (const [index, event] of (span.events ?? []).entries()) {
    if (typeof event.name === "string") writeBack(event, "name", mask(event.name), `span.events[${index}].name`);
    redactBag(mask, event.attributes, `span.events[${index}].attributes`);
  }
  for (const [index, link] of (span.links ?? []).entries()) {
    redactBag(mask, link.attributes, `span.links[${index}].attributes`);
  }
}

/**
 * Wraps `next` (any object shaped like a `SpanProcessor`) and redacts each
 * span's free text before delegating to it. `scanAndRedact` is injected so
 * this class is testable without the built native addon; see `./index.ts`
 * for the live factory.
 */
export class RedactingSpanProcessorWith implements SpanProcessor {
  readonly #next: SpanProcessor;
  readonly #mask: Mask;
  #warned = false;

  constructor(next: SpanProcessor, scanAndRedact: ScanAndRedact, options: RedactAttributesOptions = {}) {
    if (typeof next?.onEnd !== "function") {
      throw new TypeError("RedactingSpanProcessorWith: next must be a SpanProcessor");
    }
    if (typeof scanAndRedact !== "function") {
      throw new TypeError("RedactingSpanProcessorWith: scanAndRedact must be a function");
    }
    this.#next = next;
    this.#mask = maskerFor(scanAndRedact, options);
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

  /** Never throws: a span that cannot be redacted is dropped, not exported. */
  onEnd(span: ReadableSpan): void {
    try {
      redactSpan(this.#mask, span);
    } catch (error) {
      this.#warnDropped(error instanceof UnredactableFieldError ? error.message : "unexpected span shape");
      return;
    }
    this.#next.onEnd(span);
  }

  shutdown(): Promise<void> {
    return this.#next.shutdown();
  }

  forceFlush(): Promise<void> {
    return this.#next.forceFlush ? this.#next.forceFlush() : Promise.resolve();
  }

  #warnDropped(reason: string): void {
    if (this.#warned) return;
    this.#warned = true;
    const message = `@redact-secret/adapter-otel: dropped a span that could not be redacted (${reason})`;
    try {
      if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
        process.emitWarning(message, { code: "REDACT_SECRET_SPAN_DROPPED" });
      } else {
        console.warn(message);
      }
    } catch {
      // A warning is best effort; the span is dropped either way.
    }
  }
}
