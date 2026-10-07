/**
 * A `LogRecordProcessor` (OpenTelemetry JS Logs SDK, qualified against
 * `@opentelemetry/sdk-logs` 0.200.0 through 0.222.0:
 * https://github.com/open-telemetry/opentelemetry-js/blob/main/experimental/packages/sdk-logs/src/LogRecordProcessor.ts)
 * that redacts a log record's body, severity text, event name and every
 * attribute value before handing the record to the next processor.
 *
 * Why this is the supported seam: the SDK documents that "a
 * LogRecordProcessor may freely modify logRecord for the duration of the
 * OnEmit call". Wrapping the processor that owns the exporter therefore
 * protects the record before a `SimpleLogRecordProcessor` exports it or a
 * `BatchLogRecordProcessor` buffers it (a batch processor keeps the very
 * object it was given, and the SDK makes the record read-only once `emit`
 * returns, so nothing can be redacted later).
 *
 * Writes go through the record's own setters where the SDK has them
 * (`setBody`, `setSeverityText`, `setEventName`) and through the public
 * `attributes` bag otherwise. `setAttribute` is deliberately not used for
 * a rewrite: at the low end of the range it counts the call as a further
 * attribute, which would report a spurious `droppedAttributesCount` in the
 * exported record. Every write is read back. If one does not take (a
 * record already made read-only, a frozen attribute bag), the record is
 * dropped, never forwarded unredacted, with a one-time process warning
 * naming the field and never its value.
 *
 * This file never imports `@opentelemetry/sdk-logs` at runtime: the import
 * below is `import type`, erased at compile time. A `LogRecordProcessor` is
 * a structural (duck-typed) interface in JS, so wrapping one needs no
 * dependency and this module is testable with a plain object.
 */

import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import type { Limits, MaskLeafOptions, OutcomeCounter, ScanAndRedact, ValueCounts } from "@redact-secret/adapter";
import {
  bindScanConfig,
  CYCLE_MARKER,
  countLeaf,
  createOutcomeCounter,
  DEFAULT_LIMITS,
  ERROR_MARKER,
  LIMIT_MARKER,
  maskLeafOutcomeWith,
  notify,
  toValueCounts,
} from "@redact-secret/adapter";

/** What the SDK hands `onEmit`: `LogRecord` at the low end of the range, `ReadWriteLogRecord` at the high end. */
type EmittedLogRecord = Parameters<LogRecordProcessor["onEmit"]>[0];
type EmitContext = Parameters<LogRecordProcessor["onEmit"]>[1];

/**
 * The slice of a record this module touches, typed structurally because the
 * two ends of the SDK range name and declare the record differently
 * (`eventName` and `setEventName` exist only at the high end).
 */
interface MutableLogRecord {
  body?: unknown;
  severityText?: unknown;
  eventName?: unknown;
  attributes?: Record<string, unknown> | null;
  setBody?: (body: never) => unknown;
  setSeverityText?: (severityText: never) => unknown;
  setEventName?: (eventName: never) => unknown;
}

/**
 * One summary per **log record**, the unit a host counts in. Every field is
 * bounded and enumerated; `values`' definitions are in
 * `@redact-secret/adapter`'s `outcome.ts`. No attribute name, key, value or
 * error text is in it.
 */
export interface OtelLogRecordOutcome {
  readonly host: "otel-logs";
  readonly unit: "log-record";
  readonly values: ValueCounts;
  /**
   * `true` when **this processor** did not hand the record to the next one,
   * because a masked value would not write back. It does not mean the record
   * was filtered out, and `false` does not mean the record was exported:
   * whether the next processor kept it and whether an exporter succeeded are
   * things this adapter never learns and does not report.
   */
  readonly dropped: boolean;
}

export interface RedactingLogRecordProcessorOptions extends MaskLeafOptions {
  /**
   * Walk budgets for one record, shared by its body and all its attributes.
   * The defaults are the shared adapter ones (`DEFAULT_LIMITS`). A value past
   * a budget becomes `[REDACTED:LIMIT_EXCEEDED]`; it is never passed through.
   * An invalid override falls back to the default for that key.
   */
  readonly limits?: Partial<Limits> | undefined;
  /**
   * Observational: called once per record, synchronously at the end of
   * `onEmit`, after the record has either been forwarded or dropped.
   * Increment your own counters from it.
   *
   * It cannot change what is exported, and anything it throws is swallowed,
   * never read, and never rethrown — including for a record that was dropped.
   * It is re-entrancy-guarded. No exporter or network client is created for it.
   */
  readonly onOutcome?: (outcome: OtelLogRecordOutcome) => void;
}

/** A record field that did not take a masked write. The message names the field, never its value. */
class UnredactableFieldError extends Error {}

function resolveLimits(overrides: Partial<Limits> | undefined): Limits {
  const limits: { -readonly [K in keyof Limits]: number } = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    const value: unknown = overrides?.[key];
    if (typeof value === "number" && value >= 0) limits[key] = value;
  }
  return limits;
}

function isPlainObject(value: object): boolean {
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Defines a data key without invoking inherited setters such as `__proto__`. */
function defineDataKey(out: object, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
}

const encoder = new TextEncoder();
const strictDecoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Masks one record's values. A new instance per record: it owns the record's
 * leaf and node budgets and its outcome counter.
 */
class RecordMasker {
  readonly counter: OutcomeCounter = createOutcomeCounter();
  #leaves: number;
  #nodes: number;

  constructor(
    private readonly scanAndRedact: ScanAndRedact,
    private readonly options: MaskLeafOptions,
    private readonly limits: Limits,
  ) {
    this.#leaves = limits.maxTotalLeaves;
    this.#nodes = limits.maxNodes;
  }

  #marker(marker: string): string {
    if (marker === LIMIT_MARKER) this.counter.limited += 1;
    else this.counter.failed += 1;
    return marker;
  }

  /** Scans one string leaf. Past the leaf budget it is never scanned and never passed through. */
  string(text: string): string {
    if (this.#leaves <= 0) return this.#marker(LIMIT_MARKER);
    this.#leaves -= 1;
    const leaf = maskLeafOutcomeWith(this.scanAndRedact, text, {
      scanConfig: this.options.scanConfig,
      maxStringLength: this.limits.maxStringLength,
    });
    countLeaf(this.counter, leaf);
    return leaf.text;
  }

  /**
   * OTLP `bytesValue`. The bytes are scanned as UTF-8 text. Bytes that are
   * not valid UTF-8 cannot be scanned for a text secret, so they are replaced
   * (fail closed), not exported opaque.
   */
  #bytes(bytes: Uint8Array): Uint8Array {
    if (this.#leaves <= 0 || bytes.byteLength > this.limits.maxStringLength) {
      return encoder.encode(this.#marker(LIMIT_MARKER));
    }
    let text: string;
    try {
      text = strictDecoder.decode(bytes);
    } catch {
      return encoder.encode(this.#marker(ERROR_MARKER));
    }
    const masked = this.string(text);
    return masked === text ? bytes : encoder.encode(masked);
  }

  /**
   * The masked value, or `value` itself (same reference) when nothing in it
   * changed. Numbers, booleans and `null` cannot carry a secret as free text.
   * Never throws: an unreadable value becomes `[REDACTED:ERROR]`.
   */
  value(value: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
    if (this.#nodes <= 0) return this.#marker(LIMIT_MARKER);
    this.#nodes -= 1;
    if (typeof value === "string") return this.string(value);
    if (typeof value !== "object" || value === null) return value;
    if (value instanceof Uint8Array) return this.#bytes(value);
    if (depth >= this.limits.maxDepth) return this.#marker(LIMIT_MARKER);
    if (seen.has(value)) return this.#marker(CYCLE_MARKER);
    seen.add(value);
    try {
      return Array.isArray(value) ? this.#array(value, depth, seen) : this.#object(value, depth, seen);
    } catch {
      // A throwing getter, a revoked proxy, a throwing toJSON.
      return this.#marker(ERROR_MARKER);
    } finally {
      seen.delete(value);
    }
  }

  #array(source: readonly unknown[], depth: number, seen: Set<object>): unknown {
    const length = source.length;
    const kept = Math.min(length, this.limits.maxArrayLength);
    const out: unknown[] = [];
    let changed = kept !== length;
    // Elements past the bound are dropped, never passed through.
    if (changed) this.counter.limited += 1;
    for (let index = 0; index < kept; index += 1) {
      const item = source[index];
      const masked = this.value(item, depth + 1, seen);
      if (masked !== item) changed = true;
      out.push(masked);
    }
    return changed ? out : source;
  }

  #object(source: object, depth: number, seen: Set<object>): unknown {
    // `toJSON()` replaces the value the way JSON serialization would (Date,
    // URL, Buffer, ...), and is checked on plain objects too: a `toJSON` left
    // on a kept object would run again at serialization time and emit its
    // unmasked result.
    const toJSON: unknown = (source as { toJSON?: unknown }).toJSON;
    if (typeof toJSON === "function") {
      return this.value(toJSON.call(source, ""), depth + 1, seen);
    }
    if (source instanceof Error) {
      return this.#object(
        {
          type: String(source.name),
          message: String(source.message ?? ""),
          ...(typeof source.stack === "string" ? { stack: source.stack } : {}),
          ...(source.cause === undefined ? {} : { cause: source.cause }),
        },
        depth,
        seen,
      );
    }
    const record = source as Record<string, unknown>;
    const allKeys = Object.keys(source);
    const keys = allKeys.slice(0, this.limits.maxObjectKeys);
    let changed = keys.length !== allKeys.length || !isPlainObject(source);
    if (keys.length !== allKeys.length) this.counter.limited += 1;
    const out = {};
    for (const key of keys) {
      let masked: unknown;
      let original: unknown;
      try {
        original = record[key];
        masked = this.value(original, depth + 1, seen);
      } catch {
        masked = this.#marker(ERROR_MARKER);
      }
      if (masked !== original) changed = true;
      defineDataKey(out, key, masked);
    }
    return changed ? out : source;
  }
}

/** True if `actual` is `expected`, or what the SDK's own attribute limits made of it (a shorter prefix of a string). */
function reflects(expected: unknown, actual: unknown): boolean {
  if (expected === actual) return true;
  if (typeof expected === "string") return typeof actual === "string" && expected.startsWith(actual);
  if (expected instanceof Uint8Array) {
    return (
      actual instanceof Uint8Array &&
      actual.byteLength === expected.byteLength &&
      expected.every((byte, index) => byte === actual[index])
    );
  }
  if (typeof expected !== "object" || expected === null || typeof actual !== "object" || actual === null) return false;
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length <= expected.length &&
      actual.every((item, i) => reflects(expected[i], item))
    );
  }
  const expectedRecord = expected as Record<string, unknown>;
  const actualRecord = actual as Record<string, unknown>;
  const actualKeys = Object.keys(actualRecord);
  return (
    actualKeys.length <= Object.keys(expectedRecord).length &&
    actualKeys.every((key) => reflects(expectedRecord[key], actualRecord[key]))
  );
}

function redactRecord(masker: RecordMasker, record: MutableLogRecord): void {
  const body = record.body;
  if (body !== undefined) {
    const masked = masker.value(body);
    if (masked !== body) {
      // `setBody` is the SDK's own writer; it does nothing on a read-only record, which the read-back catches.
      if (typeof record.setBody === "function") record.setBody(masked as never);
      else record.body = masked;
      if (!reflects(masked, record.body)) throw new UnredactableFieldError("body did not take the masked write");
    }
  }

  const severityText = record.severityText;
  if (typeof severityText === "string") {
    const masked = masker.string(severityText);
    if (masked !== severityText) {
      if (typeof record.setSeverityText === "function") record.setSeverityText(masked as never);
      else record.severityText = masked;
      if (record.severityText !== masked)
        throw new UnredactableFieldError("severityText did not take the masked write");
    }
  }

  const eventName = record.eventName;
  if (typeof eventName === "string") {
    const masked = masker.string(eventName);
    if (masked !== eventName) {
      if (typeof record.setEventName === "function") record.setEventName(masked as never);
      else record.eventName = masked;
      if (record.eventName !== masked) throw new UnredactableFieldError("eventName did not take the masked write");
    }
  }

  const attributes = record.attributes;
  if (attributes == null) return;
  for (const key of Object.keys(attributes)) {
    const value = attributes[key];
    const masked = masker.value(value);
    if (masked === value) continue;
    try {
      attributes[key] = masked;
    } catch {
      throw new UnredactableFieldError("attributes did not take the masked write");
    }
    if (!reflects(masked, attributes[key]))
      throw new UnredactableFieldError("attributes did not take the masked write");
  }
}

/**
 * Wraps `next` (any object shaped like a `LogRecordProcessor`) and redacts
 * each record's free text before delegating to it. `scanAndRedact` is
 * injected so this class is testable without the built native addon; see
 * `./index.ts` for the live factory.
 */
export class RedactingLogRecordProcessorWith implements LogRecordProcessor {
  readonly #next: LogRecordProcessor;
  readonly #scanAndRedact: ScanAndRedact;
  readonly #maskOptions: MaskLeafOptions;
  readonly #limits: Limits;
  readonly #onOutcome: ((outcome: OtelLogRecordOutcome) => void) | undefined;
  #reporting = false;
  #warned = false;

  constructor(
    next: LogRecordProcessor,
    scanAndRedact: ScanAndRedact,
    options: RedactingLogRecordProcessorOptions = {},
  ) {
    if (typeof next?.onEmit !== "function") {
      throw new TypeError("RedactingLogRecordProcessorWith: next must be a LogRecordProcessor");
    }
    if (typeof scanAndRedact !== "function") {
      throw new TypeError("RedactingLogRecordProcessorWith: scanAndRedact must be a function");
    }
    const { onOutcome, limits, ...maskOptions } = options;
    if (onOutcome !== undefined && typeof onOutcome !== "function") {
      throw new TypeError("RedactingLogRecordProcessorWith: onOutcome must be a function");
    }
    this.#next = next;
    this.#scanAndRedact = scanAndRedact;
    // Validated and snapshotted once, here: every scan of every record uses
    // this one `scanConfig` (policy, actionPolicy, limits, ruleset, formatter).
    this.#maskOptions = bindScanConfig(maskOptions);
    // The top-level `maxStringLength` is the shared adapter option and wins over `limits.maxStringLength`.
    this.#limits = resolveLimits(
      maskOptions.maxStringLength === undefined ? limits : { ...limits, maxStringLength: maskOptions.maxStringLength },
    );
    this.#onOutcome = onOutcome;
  }

  /**
   * Redacts the record in place, then delegates. A record that cannot be
   * redacted is dropped, not exported, and nothing is thrown at the code that
   * emitted it. A throw from `next` is not swallowed here.
   */
  onEmit(logRecord: EmittedLogRecord, context?: EmitContext): void {
    // A fresh masker per record: this record's budgets and counts, never a
    // running total, and safe when a downstream processor emits a record of
    // its own synchronously from inside `next.onEmit`, which re-enters here.
    const masker = new RecordMasker(this.#scanAndRedact, this.#maskOptions, this.#limits);
    let dropped = false;
    try {
      redactRecord(masker, logRecord as unknown as MutableLogRecord);
    } catch (error) {
      this.#warnDropped(error instanceof UnredactableFieldError ? error.message : "unexpected record shape");
      dropped = true;
    }
    // Snapshotted before delegating, because these numbers are final here.
    const counts = this.#onOutcome === undefined ? undefined : toValueCounts(masker.counter);
    // Reported whether the record was forwarded or dropped, and after the next
    // processor has had it, so an observer cannot affect what is exported.
    try {
      if (!dropped) this.#next.onEmit(logRecord, context);
    } finally {
      if (counts !== undefined) this.#report(counts, dropped);
    }
  }

  /**
   * Forwards the SDK's optional `enabled` (high end of the range only), so
   * wrapping a processor does not change which records are created. A wrapped
   * processor without one is enabled, as the SDK treats a processor without it.
   */
  enabled(options: unknown): boolean {
    const next = this.#next as { enabled?: (options: unknown) => boolean };
    return typeof next.enabled === "function" ? next.enabled(options) : true;
  }

  #report(values: ValueCounts, dropped: boolean): void {
    if (this.#onOutcome === undefined || this.#reporting) return;
    this.#reporting = true;
    try {
      notify(this.#onOutcome, {
        host: "otel-logs",
        unit: "log-record",
        values,
        dropped,
      } satisfies OtelLogRecordOutcome);
    } finally {
      this.#reporting = false;
    }
  }

  shutdown(): Promise<void> {
    return this.#next.shutdown();
  }

  /** `options` (a timeout, at the high end of the range) is forwarded as given; the low end takes none and ignores it. */
  forceFlush(options?: unknown): Promise<void> {
    return (this.#next.forceFlush as (options?: unknown) => Promise<void>).call(this.#next, options);
  }

  #warnDropped(reason: string): void {
    if (this.#warned) return;
    this.#warned = true;
    const message = `@redact-secret/adapter-otel-logs: dropped a log record that could not be redacted (${reason})`;
    try {
      if (typeof process !== "undefined" && typeof process.emitWarning === "function") {
        process.emitWarning(message, { code: "REDACT_SECRET_LOG_RECORD_DROPPED" });
      } else {
        console.warn(message);
      }
    } catch {
      // A warning is best effort; the record is dropped either way.
    }
  }
}
