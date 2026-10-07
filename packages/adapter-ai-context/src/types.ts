/**
 * The public types of the AI-context boundary
 * (redact-secret/redact-secret#610, `docs/reference/ai-context-boundary.md`
 * in the core repository). Core shapes are imported as types from the core
 * itself, so a core change to a finding, a limit, or an error code fails to
 * compile here instead of silently widening what crosses the boundary.
 */

import type { ActionPolicyInput, OperationLimits, StrictWalkLimits } from "@redact-secret/adapter";
import type {
  IncrementalLimits,
  IncrementalSanitizer,
  IncrementalSanitizerOptions,
  IncrementalSecretPolicy,
  PlaceholderFormatter,
  ScanAndRedactOptions,
  ScanResult,
  SecretFinding,
  SecretScanErrorCode,
  WholeInputLimits,
} from "@redact-secret/core";

/**
 * The documented core operations this package uses, injected: pass
 * `@redact-secret/core` itself, or a fake in tests. Nothing else of the core
 * is read.
 */
export interface AiContextCore {
  readonly scanAndRedact: (input: string, options?: ScanAndRedactOptions) => ScanResult;
  readonly createIncrementalSanitizer: (options: IncrementalSanitizerOptions) => IncrementalSanitizer;
}

/**
 * Where a value is crossing into the AI workflow. Goes to telemetry only;
 * never changes an outcome. `tool-arguments` labels the arguments of a tool
 * call (the MCP boundary's opt-in argument sanitation), and `resource` the
 * contents of an MCP `resources/read` result (redact-secret/redact-secret#843).
 */
export type BoundaryLabel = "user-input" | "tool-result" | "tool-arguments" | "resource" | "context";

/** Why an operation was blocked. Fixed set; a new reason is a contract change. */
export type BlockReason = "policy" | "limit_exceeded" | "unsupported_value" | "lifecycle" | "core_error";

/**
 * A finding as it crosses the boundary: exactly these eight fields, copied
 * by allowlist, so a field the core adds later cannot reach a host.
 */
export type SafeFinding = Readonly<
  Pick<SecretFinding, "id" | "type" | "detector" | "confidence" | "action" | "obfuscation" | "start" | "end">
>;

export interface OkOutcome<T> {
  readonly outcome: "ok";
  /** The only thing that may go to a model, a tool, a log, or storage. */
  readonly value: T;
  readonly findings: readonly SafeFinding[];
}

export interface BlockedOutcome {
  readonly outcome: "blocked";
  readonly reason: BlockReason;
  /** Present only when the core raised an error with a code from its fixed registry. */
  readonly code?: SecretScanErrorCode;
}

export interface AbortedOutcome {
  readonly outcome: "aborted";
}

/** Every operation ends in exactly one of these. A non-`ok` outcome carries no value and no findings. */
export type AiContextOutcome<T> = OkOutcome<T> | BlockedOutcome | AbortedOutcome;

/** A JSON-shaped value: what `sanitizeValue` accepts and returns. */
export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** The subset of `AbortSignal` this package reads. A real `AbortSignal` also gets an `abort` listener. */
export interface CancellationSignal {
  readonly aborted: boolean;
  addEventListener?: (type: "abort", listener: () => void, options?: { once?: boolean }) => void;
  removeEventListener?: (type: "abort", listener: () => void) => void;
}

export interface OperationOptions {
  /** Defaults to `"context"`. */
  readonly boundary?: BoundaryLabel;
  readonly signal?: CancellationSignal;
}

export type TraversalLimits = StrictWalkLimits;

/** Telemetry context: exactly the boundary label, nothing else. */
export interface FindingContext {
  readonly boundary: BoundaryLabel;
}

/** The unit every range in this package is counted in: UTF-16 code units of the scanned string. */
export type RangeUnit = "utf16-code-units";

/**
 * What a finding's `start` and `end` index into
 * (redact-secret/redact-secret-adapters#177). They are **never** offsets into
 * a whole document, a whole context or a serialized value.
 *
 * - `"text"`: the whole string given to `sanitizeText`, or to a text part of
 *   `buildContext`.
 * - `"leaf"`: one string leaf of a structured value (`sanitizeValue`, a value
 *   part of `buildContext`), so `leaf.slice(start, end)` is the matched span.
 *   When the finding came from the leaf's key-context view, it is already
 *   mapped back to the leaf; the key is never part of the range.
 * - `"key"`: one object key, scanned on its own. Reaches `onFinding` only; a
 *   finding that would be redacted or blocked blocks the value, so none is in
 *   `ok.findings`.
 * - `"stream"`: the logical text of an open stream, from its first appended
 *   chunk: absolute offsets over all chunks, not per chunk.
 */
export type RangeScope = "text" | "leaf" | "key" | "stream";

/**
 * Where one finding came from: additive provenance for the finding it
 * accompanies, so a finding in a flattened result can be told apart from one
 * with the same `id` from another scan. It carries **only** non-sensitive
 * ordinals and fixed labels: never a key, a field path, a value, an
 * identifier derived from a secret, or a score.
 *
 * `finding.id` is the core's per-scan id (`finding-1`, ...), unique within one
 * scan and **not** within an operation. Within one operation the tuple
 * (`partIndex`, `rangeScope`, `leafOrdinal` or `keyOrdinal`, `finding.id`) is
 * unique; across operations nothing is.
 */
export type FindingOccurrence =
  | {
      /** `buildContext`: the index of the part in `parts`. Every other operation: `0`. */
      readonly partIndex: number;
      readonly rangeScope: "text" | "stream";
      readonly rangeUnit: RangeUnit;
    }
  | {
      readonly partIndex: number;
      readonly rangeScope: "leaf";
      readonly rangeUnit: RangeUnit;
      /**
       * Zero-based ordinal of the string leaf in document order within its
       * part, counting every string leaf visited, with or without findings.
       * A value reached by two paths (a shared reference) is a leaf at each.
       * Object keys are not leaves.
       */
      readonly leafOrdinal: number;
    }
  | {
      readonly partIndex: number;
      readonly rangeScope: "key";
      readonly rangeUnit: RangeUnit;
      /** Zero-based ordinal of the object key in document order within its part. */
      readonly keyOrdinal: number;
    };

export interface AiContextBoundaryOptions {
  /** Whole-input bounds for every `scanAndRedact` call, enforced by the core. Required. */
  readonly wholeInputLimits: WholeInputLimits;
  /** Bounds for every incremental session, enforced by the core. Required. */
  readonly incrementalLimits: IncrementalLimits;
  /** Bounds for nested values, enforced here: `maxDepth` counts containers including the root, `maxNodes` every visited value. Required. */
  readonly traversalLimits: TraversalLimits;
  /**
   * The aggregate budget of **one operation**: one `sanitizeText`, one
   * `sanitizeValue`, one `buildContext` (every part together). Optional; omitted keys use
   * the shared defaults (`DEFAULT_OPERATION_LIMITS` in `@redact-secret/adapter`),
   * except that `maxBytes` is never lower than four times
   * `wholeInputLimits.maxInputBytes`. It is the sum over everything the
   * operation visits and scans, on top of `wholeInputLimits` (one scan) and
   * `traversalLimits` (one value): every value visited, every object key,
   * every string leaf, every `scanAndRedact` call and its UTF-8 bytes
   * (key-context views and key scans included; a memoized repeat is not a
   * call), and every finding, summed over occurrences. A limit reached is a
   * `blocked` / `limit_exceeded` outcome with no value and no findings, never a
   * partly approved one. An open stream is bounded by `incrementalLimits`, and
   * by this budget's `maxFindings` alone. It is a work counter checked between
   * scans, not a wall-clock timeout: a single core call or a host callback
   * that never returns is not interrupted.
   */
  readonly operationLimits?: Partial<OperationLimits>;
  /**
   * Passed to the core unchanged, on both the whole-input and the
   * incremental path. It sees safe metadata only. A throwing policy fails
   * the operation closed as `core_error` / `POLICY_FAILURE`.
   */
  readonly policy?: IncrementalSecretPolicy;
  /**
   * The core's declarative action policy (an object, UTF-8 JSON text or its
   * bytes), for both the whole-input and the incremental path: the first
   * matching rule decides, an unmatched finding keeps the default action. It
   * is snapshotted once, when the boundary is created, and passed to the core
   * intact; the core owns its syntax and meaning, and `block`, `warn` and
   * `allow` mean here what they mean for any policy. Mutually exclusive with
   * `policy`: both is a `TypeError` at construction. The live factory rejects a
   * core without it, or a document the core refuses, with a fixed
   * `CoreOptionsError`. See `@redact-secret/adapter`'s `ActionPolicyInput`.
   */
  readonly actionPolicy?: ActionPolicyInput;
  /** Passed to the core unchanged. A throwing formatter fails closed as `core_error` / `PLACEHOLDER_FAILURE`. */
  readonly placeholderFormatter?: PlaceholderFormatter;
  /**
   * Observational telemetry, called once per finding in scan order with
   * safe metadata only. The third argument is the finding's
   * {@link FindingOccurrence}: non-sensitive provenance (part, leaf or key
   * ordinal, range scope and unit), so a finding can be placed without the
   * flattened result. For every finding in `ok.findings` it is called with that
   * same finding and the occurrence `findingOccurrences(outcome)` reports at
   * the same index, in the same order; key scans add events with
   * `rangeScope: "key"` that `ok.findings` never carries. An exception it throws is swallowed, never read,
   * and never changes an outcome.
   */
  readonly onFinding?: (finding: SafeFinding, context: FindingContext, occurrence: FindingOccurrence) => void;
}

/** One part of a context to build: a text or a JSON-shaped value, under a host-chosen role. */
export type ContextPart =
  | { readonly role: string; readonly text: string; readonly boundary?: BoundaryLabel }
  | { readonly role: string; readonly value: unknown; readonly boundary?: BoundaryLabel };

export interface ContextMessage {
  readonly role: string;
  readonly content: unknown;
}

/**
 * A staged incremental boundary over one logical text. Nothing is released
 * before a successful `finalize`, and `finalize` releases at most once.
 */
export interface AiContextStream {
  /**
   * `true` while the stream still scans chunks; `false` once it has failed
   * (a `block` finding, a limit, a lifecycle or core failure), been aborted,
   * or been finalized. Input-free: it says only that later appends will be
   * discarded, never why; the reason arrives at `finalize`. Read it after
   * every `append` to stop pulling from, and cancel, a producer whose output
   * would be discarded unscanned anyway.
   */
  readonly accepting: boolean;
  /** Stages one chunk. Ignored once the stream has failed, been aborted, or been finalized. */
  append(chunk: string): void;
  /** The first call returns the outcome; every later call returns `blocked` / `lifecycle`. */
  finalize(): AiContextOutcome<string>;
  /** Discards staged text and aborts the core session. Does nothing after a successful `finalize`. */
  abort(): void;
}

export interface AiContextBoundary {
  /** One whole-input scan of one string. */
  sanitizeText(text: string, options?: OperationOptions): AiContextOutcome<string>;
  /** One whole-input scan per string leaf and per object key of a bounded JSON-shaped value. */
  sanitizeValue(value: unknown, options?: OperationOptions): AiContextOutcome<JsonValue>;
  /**
   * A tool's result, before it joins context: a string goes through
   * `sanitizeText`, anything else through `sanitizeValue`, with the
   * `tool-result` label.
   */
  sanitizeToolResult(
    result: unknown,
    options?: Omit<OperationOptions, "boundary">,
  ): AiContextOutcome<string | JsonValue>;
  /** All-or-nothing: any part that is not `ok` makes the whole context that outcome. */
  buildContext(
    parts: readonly ContextPart[],
    options?: Omit<OperationOptions, "boundary">,
  ): AiContextOutcome<readonly ContextMessage[]>;
  /** Opens one staged incremental session. */
  openStream(options?: OperationOptions): AiContextStream;
}
