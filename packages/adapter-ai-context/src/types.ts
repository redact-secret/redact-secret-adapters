/**
 * The public types of the AI-context boundary
 * (redact-secret/redact-secret#610, `docs/reference/ai-context-boundary.md`
 * in the core repository). Core shapes are imported as types from the core
 * itself, so a core change to a finding, a limit, or an error code fails to
 * compile here instead of silently widening what crosses the boundary.
 */

import type { StrictWalkLimits } from "@redact-secret/adapter";
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

export interface AiContextBoundaryOptions {
  /** Whole-input bounds for every `scanAndRedact` call, enforced by the core. Required. */
  readonly wholeInputLimits: WholeInputLimits;
  /** Bounds for every incremental session, enforced by the core. Required. */
  readonly incrementalLimits: IncrementalLimits;
  /** Bounds for nested values, enforced here: `maxDepth` counts containers including the root, `maxNodes` every visited value. Required. */
  readonly traversalLimits: TraversalLimits;
  /**
   * Passed to the core unchanged, on both the whole-input and the
   * incremental path. It sees safe metadata only. A throwing policy fails
   * the operation closed as `core_error` / `POLICY_FAILURE`.
   */
  readonly policy?: IncrementalSecretPolicy;
  /** Passed to the core unchanged. A throwing formatter fails closed as `core_error` / `PLACEHOLDER_FAILURE`. */
  readonly placeholderFormatter?: PlaceholderFormatter;
  /**
   * Observational telemetry, called once per finding in scan order with
   * safe metadata only. An exception it throws is swallowed, never read,
   * and never changes an outcome.
   */
  readonly onFinding?: (finding: SafeFinding, context: FindingContext) => void;
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
