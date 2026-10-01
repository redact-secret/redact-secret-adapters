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
import type {
  MaskLeafOptions,
  OperationBudget,
  OperationLimits,
  OutcomeCounter,
  ScanAndRedact,
  ValueCounts,
} from "@redact-secret/adapter";
import {
  countLeaf,
  createOperationBudget,
  createOutcomeCounter,
  ERROR_MARKER,
  LIMIT_MARKER,
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

export interface RedactingSpanProcessorOptions extends Omit<MaskLeafOptions, "budget"> {
  /**
   * Overrides for the aggregate budget of **one span** (see
   * `@redact-secret/adapter`'s `budget.ts`), shared by the span name, every
   * attribute, event and link and the status message. Past it, every string
   * not yet inspected becomes `[REDACTED:LIMIT_EXCEEDED]` and the core is not
   * called; the span is still forwarded, never with text the budget did not
   * allow to be inspected. It is a work counter, not a wall-clock timeout.
   */
  readonly operationLimits?: Partial<OperationLimits> | undefined;
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

/** `key` is the attribute name the string sits directly under, when it has one. */
type Mask = (text: string, key?: string) => string;

/** A span field that did not take a masked write. The message names the field, never its value. */
class UnredactableFieldError extends Error {}

/** What one span is masked against: its counter (when reported) and its aggregate budget. */
interface SpanState {
  readonly counter: OutcomeCounter | undefined;
  readonly budget: OperationBudget;
}

/**
 * `state` is read on every call, not captured, so one masker serves every
 * span and the processor can swap in a fresh per-span counter and budget.
 */
function maskerFor(scanAndRedact: ScanAndRedact, options: MaskLeafOptions, state: () => SpanState): Mask {
  return (text, key) => {
    const { counter, budget } = state();
    try {
      // One leaf of the span's budget; the scans it makes are charged inside.
      if (!budget.chargeLeaf()) {
        if (counter !== undefined) counter.limited += 1;
        return LIMIT_MARKER;
      }
      const leaf = maskLeafOutcomeWith(scanAndRedact, text, { ...options, key, budget });
      if (counter !== undefined) countLeaf(counter, leaf);
      return leaf.text;
    } catch {
      if (counter !== undefined) counter.failed += 1;
      return ERROR_MARKER;
    }
  };
}

/** The masked value, or `value` itself when nothing in it changed. */
function maskAttributeValue(mask: Mask, budget: OperationBudget, value: unknown, key: string): unknown {
  // Every value, and every element of an array value, is a node of the span's budget.
  budget.chargeNode();
  if (typeof value === "string") return mask(value, key);
  if (Array.isArray(value)) {
    // OpenTelemetry allows null/undefined holes in a homogeneous array, so
    // every string element is masked and every other element kept in place.
    // An element is not directly under the attribute's name, so it is masked
    // without key context, as an array element is everywhere else.
    const masked = value.map((item) => {
      budget.chargeNode();
      return typeof item === "string" ? mask(item) : item;
    });
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

function redactBag(mask: Mask, budget: OperationBudget, bag: object | null | undefined, field: string): void {
  if (bag == null) return;
  for (const key of Object.keys(bag)) {
    // Charged as a key occurrence. Failing it exhausts the budget, and every
    // string from here on is replaced by a marker rather than inspected.
    budget.chargeKey();
    writeBack(bag, key, maskAttributeValue(mask, budget, (bag as Record<string, unknown>)[key], key), field);
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
  const { operationLimits, ...leafOptions } = options as MaskLeafOptions & {
    operationLimits?: Partial<OperationLimits>;
  };
  const budget = createOperationBudget(operationLimits);
  try {
    redactBag(
      maskerFor(scanAndRedact, leafOptions, () => ({ counter: undefined, budget })),
      budget,
      attributes,
      "attributes",
    );
  } catch {
    throw new TypeError("redactAttributesWith: a masked attribute could not be written back");
  }
}

function redactSpan(mask: Mask, budget: OperationBudget, span: ReadableSpan): void {
  if (typeof span.name === "string") {
    budget.chargeNode();
    writeBack(span, "name", mask(span.name), "span.name");
  }
  redactBag(mask, budget, span.attributes, "span.attributes");
  const status = span.status;
  if (typeof status?.message === "string") {
    budget.chargeNode();
    const message = mask(status.message);
    // Replaced, not mutated: the status object may be the caller's own.
    if (message !== status.message) writeBack(span, "status", { ...status, message }, "span.status");
  }
  for (const [index, event] of (span.events ?? []).entries()) {
    budget.chargeNode();
    if (typeof event.name === "string") writeBack(event, "name", mask(event.name), `span.events[${index}].name`);
    redactBag(mask, budget, event.attributes, `span.events[${index}].attributes`);
  }
  for (const [index, link] of (span.links ?? []).entries()) {
    budget.chargeNode();
    redactBag(mask, budget, link.attributes, `span.links[${index}].attributes`);
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
  // The span being masked right now: one budget per `onEnd`, swapped like the
  // counter so a downstream processor that ends a span re-entrantly has its own.
  #budget: OperationBudget;
  readonly #limits: Partial<OperationLimits> | undefined;
  #reporting = false;
  #warned = false;

  constructor(next: SpanProcessor, scanAndRedact: ScanAndRedact, options: RedactingSpanProcessorOptions = {}) {
    if (typeof next?.onEnd !== "function") {
      throw new TypeError("RedactingSpanProcessorWith: next must be a SpanProcessor");
    }
    if (typeof scanAndRedact !== "function") {
      throw new TypeError("RedactingSpanProcessorWith: scanAndRedact must be a function");
    }
    const { onOutcome, operationLimits, ...maskOptions } = options;
    if (onOutcome !== undefined && typeof onOutcome !== "function") {
      throw new TypeError("RedactingSpanProcessorWith: onOutcome must be a function");
    }
    this.#next = next;
    this.#onOutcome = onOutcome;
    this.#limits = operationLimits;
    this.#budget = createOperationBudget(operationLimits);
    this.#mask = maskerFor(scanAndRedact, maskOptions, () => ({
      counter: onOutcome === undefined ? undefined : this.#counter,
      budget: this.#budget,
    }));
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
    const counting = this.#onOutcome !== undefined;
    // A fresh counter per span, so `onOutcome` reports this span's values and
    // not a running total, and the previous one is restored: a downstream
    // processor may end a span synchronously inside `#next.onEnd` below (a
    // `SimpleSpanProcessor` over an instrumented exporter, or any processor
    // that emits a span of its own), which re-enters this method.
    const outer = this.#counter;
    const outerBudget = this.#budget;
    if (counting) this.#counter = createOutcomeCounter();
    this.#budget = createOperationBudget(this.#limits);
    let dropped = false;
    let counts: ValueCounts | undefined;
    try {
      try {
        redactSpan(this.#mask, this.#budget, span);
      } catch (error) {
        this.#warnDropped(error instanceof UnredactableFieldError ? error.message : "unexpected span shape");
        dropped = true;
      }
      // Snapshotted before delegating, because this span's numbers are final
      // here and `#report` runs after a nested `onEnd` may have replaced the
      // field.
      if (counting) counts = toValueCounts(this.#counter);
    } finally {
      this.#counter = outer;
      this.#budget = outerBudget;
    }
    // Reported whether the span was forwarded or dropped, and after the next
    // processor has had it, so an observer cannot affect what is exported.
    try {
      if (!dropped) this.#next.onEnd(span);
    } finally {
      if (counts !== undefined) this.#report(counts, dropped);
    }
  }

  #report(values: ValueCounts, dropped: boolean): void {
    if (this.#onOutcome === undefined || this.#reporting) return;
    this.#reporting = true;
    try {
      notify(this.#onOutcome, { host: "otel", unit: "span", values, dropped } satisfies OtelSpanOutcome);
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
