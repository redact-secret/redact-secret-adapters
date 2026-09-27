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
import type { MaskLeafOptions, OutcomeCounter, ScanAndRedact, ValueCounts } from "@redact-secret/adapter";
import {
  countLeaf,
  createOutcomeCounter,
  ERROR_MARKER,
  maskLeafOutcomeWith,
  notify,
  toValueCounts,
} from "@redact-secret/adapter";

/**
 * @deprecated Use `MaskLeafOptions` (`{ policy, maxStringLength }`), which
 * this package re-exports; this alias adds nothing and will be removed in a
 * future major version.
 */
export type RedactAttributesOptions = MaskLeafOptions;

/**
 * One summary per **span**, the unit a host counts in
 * (redact-secret/redact-secret-adapters#45). Every field is bounded and
 * enumerated; `values`' definitions are in `@redact-secret/adapter`'s
 * `outcome.ts`. No attribute name, key, value or error text is in it.
 */
export interface OtelSpanOutcome {
  readonly host: "otel";
  readonly unit: "span";
  readonly values: ValueCounts;
  /**
   * `true` when **this processor** did not hand the span to the next one,
   * because a masked value would not write back. It does not mean the span
   * was sampled out, and `false` does not mean the span was exported: whether
   * the next processor kept it and whether an exporter succeeded are things
   * this adapter never learns and does not report.
   */
  readonly dropped: boolean;
}

export interface RedactingSpanProcessorOptions extends MaskLeafOptions {
  /**
   * Observational: called once per span, synchronously at the end of `onEnd`,
   * after the span has either been forwarded or dropped. Increment your own
   * counters from it.
   *
   * It cannot change what is exported, and anything it throws is swallowed,
   * never read, and never rethrown — including for a span that was dropped.
   * It is re-entrancy-guarded. No exporter or network client is created for it.
   */
  readonly onOutcome?: (outcome: OtelSpanOutcome) => void;
}

type Mask = (text: string) => string;

/** A span field that did not take a masked write. The message names the field, never its value. */
class UnredactableFieldError extends Error {}

/**
 * `counter` is read on every call, not captured, so one masker serves every
 * span and the processor can swap in a fresh per-span counter.
 */
function maskerFor(scanAndRedact: ScanAndRedact, options: MaskLeafOptions, counter?: () => OutcomeCounter): Mask {
  return (text) => {
    try {
      const leaf = maskLeafOutcomeWith(scanAndRedact, text, options);
      if (counter !== undefined) countLeaf(counter(), leaf);
      return leaf.text;
    } catch {
      if (counter !== undefined) counter().failed += 1;
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
  options: MaskLeafOptions = {},
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
  readonly #onOutcome: ((outcome: OtelSpanOutcome) => void) | undefined;
  #counter: OutcomeCounter = createOutcomeCounter();
  #reporting = false;
  #warned = false;

  constructor(next: SpanProcessor, scanAndRedact: ScanAndRedact, options: RedactingSpanProcessorOptions = {}) {
    if (typeof next?.onEnd !== "function") {
      throw new TypeError("RedactingSpanProcessorWith: next must be a SpanProcessor");
    }
    if (typeof scanAndRedact !== "function") {
      throw new TypeError("RedactingSpanProcessorWith: scanAndRedact must be a function");
    }
    const { onOutcome, ...maskOptions } = options;
    if (onOutcome !== undefined && typeof onOutcome !== "function") {
      throw new TypeError("RedactingSpanProcessorWith: onOutcome must be a function");
    }
    this.#next = next;
    this.#onOutcome = onOutcome;
    this.#mask = maskerFor(scanAndRedact, maskOptions, onOutcome === undefined ? undefined : () => this.#counter);
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
    // A fresh counter per span, so `onOutcome` reports this span's values and
    // not a running total. Read through a getter by `#mask`.
    if (this.#onOutcome !== undefined) this.#counter = createOutcomeCounter();
    let dropped = false;
    try {
      redactSpan(this.#mask, span);
    } catch (error) {
      this.#warnDropped(error instanceof UnredactableFieldError ? error.message : "unexpected span shape");
      dropped = true;
    }
    // Reported whether the span was forwarded or dropped, and after the next
    // processor has had it, so an observer cannot affect what is exported.
    try {
      if (!dropped) this.#next.onEnd(span);
    } finally {
      this.#report(dropped);
    }
  }

  #report(dropped: boolean): void {
    if (this.#onOutcome === undefined || this.#reporting) return;
    this.#reporting = true;
    try {
      notify(this.#onOutcome, {
        host: "otel",
        unit: "span",
        values: toValueCounts(this.#counter),
        dropped,
      } satisfies OtelSpanOutcome);
    } finally {
      this.#reporting = false;
    }
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
