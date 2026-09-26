/**
 * The framework-neutral AI-context boundary over an injected core
 * (redact-secret/redact-secret#610). This module never imports
 * `@redact-secret/core` at runtime: the core arrives as an argument, so it
 * is testable without a native addon and shares the core instance (and its
 * one `initialize()`) with the application.
 *
 * It detects nothing and decides no policy. It hands text to the core's
 * `scanAndRedact` or incremental session, and maps what comes back onto
 * `ok` / `blocked` / `aborted`. Nested values are traversed by the shared
 * strict walker in `@redact-secret/adapter`.
 *
 * `sanitizeValue` is key-aware (redact-secret/redact-secret#842): a string
 * leaf under an object key that its own scan does not redact is scanned once
 * more, through the same `scanAndRedact`, inside its key-context view
 * `{"<key>":"<leaf>"}`, and a finding there is mapped back to leaf offsets.
 * The core's contextual detection decides whether the pair is a secret; this
 * module holds no key pattern or name list.
 */

import { isStrictWalkLimits, type StrictVisit, walkStrict } from "@redact-secret/adapter";
import type { SecretScanErrorCode } from "@redact-secret/core";

import type {
  AbortedOutcome,
  AiContextBoundary,
  AiContextBoundaryOptions,
  AiContextCore,
  AiContextOutcome,
  AiContextStream,
  BlockedOutcome,
  BlockReason,
  BoundaryLabel,
  CancellationSignal,
  ContextMessage,
  ContextPart,
  JsonValue,
  OkOutcome,
  OperationOptions,
  SafeFinding,
} from "./types.js";

/** The fields a finding keeps when it crosses the boundary, in this order. */
export const SAFE_FINDING_FIELDS = Object.freeze([
  "id",
  "type",
  "detector",
  "confidence",
  "action",
  "obfuscation",
  "start",
  "end",
] as const satisfies readonly (keyof SafeFinding)[]);

export const BLOCK_REASONS = Object.freeze([
  "policy",
  "limit_exceeded",
  "unsupported_value",
  "lifecycle",
  "core_error",
] as const satisfies readonly BlockReason[]);

const LIMIT_CODES: ReadonlySet<SecretScanErrorCode> = new Set([
  "INPUT_LIMIT_EXCEEDED",
  "FINDING_LIMIT_EXCEEDED",
  "BUFFER_LIMIT_EXCEEDED",
  "TOKEN_LIMIT_EXCEEDED",
  "MULTILINE_LIMIT_EXCEEDED",
]);

/** The core's fixed error-code registry. Only these may cross the boundary. */
const CORE_CODES: ReadonlySet<string> = new Set<SecretScanErrorCode>([
  "INVALID_INPUT",
  "INVALID_OPTIONS",
  "INVALID_DETECTOR",
  "DETECTOR_FAILURE",
  "INVALID_CANDIDATE",
  "POLICY_FAILURE",
  "INVALID_POLICY_ACTION",
  "INVALID_FINDINGS",
  "PLACEHOLDER_FAILURE",
  "INVALID_PLACEHOLDER",
  "INVALID_LIMITS",
  "INPUT_LIMIT_EXCEEDED",
  "FINDING_LIMIT_EXCEEDED",
  "BUFFER_LIMIT_EXCEEDED",
  "TOKEN_LIMIT_EXCEEDED",
  "MULTILINE_LIMIT_EXCEEDED",
  "INVALID_STATE",
  "INVALID_RULESET",
  "NOT_INITIALIZED",
  "INITIALIZATION_FAILED",
  "INVALID_CHUNK",
  "INVALID_UTF8",
  "UNPAIRED_SURROGATE",
]);

const ABORTED: AbortedOutcome = Object.freeze({ outcome: "aborted" });
const DEFAULT_BOUNDARY: BoundaryLabel = "context";

function blocked(reason: BlockReason, code?: SecretScanErrorCode): BlockedOutcome {
  return code === undefined
    ? Object.freeze({ outcome: "blocked", reason })
    : Object.freeze({ outcome: "blocked", reason, code });
}

function ok<T>(value: T, findings: SafeFinding[]): OkOutcome<T> {
  return Object.freeze({ outcome: "ok", value, findings: Object.freeze(findings) });
}

function isAborted(signal: CancellationSignal | undefined): boolean {
  try {
    return signal != null && signal.aborted === true;
  } catch {
    // A signal whose `aborted` cannot be read is not a signal we can trust
    // to say "keep going".
    return true;
  }
}

/**
 * Maps anything thrown to a fixed failure. Reads `code` only, and only
 * forwards it when it is in the core's registry. Never reads `message`.
 */
export function failureFrom(error: unknown): BlockedOutcome {
  let code: SecretScanErrorCode | undefined;
  try {
    const candidate: unknown =
      error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    if (typeof candidate === "string" && CORE_CODES.has(candidate)) code = candidate as SecretScanErrorCode;
  } catch {
    code = undefined;
  }
  if (code !== undefined && LIMIT_CODES.has(code)) return blocked("limit_exceeded", code);
  if (code === "INVALID_STATE") return blocked("lifecycle", code);
  return blocked("core_error", code);
}

function safeFinding(finding: SafeFinding): SafeFinding {
  const copy: Record<string, unknown> = {};
  for (const field of SAFE_FINDING_FIELDS) copy[field] = finding[field];
  return Object.freeze(copy) as unknown as SafeFinding;
}

/** A result not shaped like `{ text: string, findings: object[] }` is a core failure, never passed on. */
function readResult(result: unknown): { text: string; findings: SafeFinding[] } | undefined {
  if (result === null || typeof result !== "object") return undefined;
  const { text, findings } = result as { text?: unknown; findings?: unknown };
  if (typeof text !== "string" || !Array.isArray(findings)) return undefined;
  if (!findings.every((finding) => finding !== null && typeof finding === "object")) return undefined;
  return { text, findings: findings.map((finding: SafeFinding) => safeFinding(finding)) };
}

function hasAction(findings: readonly SafeFinding[], ...actions: string[]): boolean {
  return findings.some((finding) => actions.includes(finding.action));
}

function validateOptions(options: AiContextBoundaryOptions): void {
  if (options === null || typeof options !== "object") {
    throw new TypeError("createAiContextBoundary: options are required");
  }
  const { wholeInputLimits, incrementalLimits, traversalLimits, onFinding } = options;
  if (wholeInputLimits === null || typeof wholeInputLimits !== "object") {
    throw new TypeError("createAiContextBoundary: wholeInputLimits is required");
  }
  if (incrementalLimits === null || typeof incrementalLimits !== "object") {
    throw new TypeError("createAiContextBoundary: incrementalLimits is required");
  }
  if (!isStrictWalkLimits(traversalLimits)) {
    throw new TypeError(
      "createAiContextBoundary: traversalLimits.maxDepth and maxNodes must be non-negative safe integers",
    );
  }
  if (onFinding !== undefined && typeof onFinding !== "function") {
    throw new TypeError("createAiContextBoundary: onFinding must be a function");
  }
}

/**
 * Creates the boundary over an injected core. `core.scanAndRedact` must not
 * be called before the core is initialized; if it is, the core's own
 * `NOT_INITIALIZED` error makes every operation fail closed as
 * `blocked` / `core_error` / `NOT_INITIALIZED`.
 *
 * Throws a `TypeError` with a fixed message only when `options` is
 * malformed (a missing limit set, an invalid traversal bound): that is a
 * programming error, not an input.
 */
export function createAiContextBoundaryWith(core: AiContextCore, options: AiContextBoundaryOptions): AiContextBoundary {
  validateOptions(options);
  const { wholeInputLimits, incrementalLimits, traversalLimits, policy, placeholderFormatter, onFinding } = options;
  const wholeInputOptions = Object.freeze({ policy, placeholderFormatter, limits: wholeInputLimits });
  const incrementalOptions = Object.freeze({ policy, placeholderFormatter, limits: incrementalLimits });

  function emit(findings: readonly SafeFinding[], boundary: BoundaryLabel): void {
    if (typeof onFinding !== "function") return;
    for (const finding of findings) {
      try {
        onFinding(finding, Object.freeze({ boundary }));
      } catch {
        // Telemetry is observational: a throwing callback never changes the
        // outcome, and its error is never read or rethrown.
      }
    }
  }

  /** One whole-input scan. */
  function scanText(text: unknown): { text: string; findings: SafeFinding[] } | { failure: BlockedOutcome } {
    if (typeof text !== "string") return { failure: blocked("unsupported_value") };
    let result: unknown;
    try {
      result = core.scanAndRedact(text, wholeInputOptions);
    } catch (error) {
      return { failure: failureFrom(error) };
    }
    return readResult(result) ?? { failure: blocked("core_error") };
  }

  /**
   * One string leaf, key-aware (core contract: "Key-aware `sanitizeValue`").
   * The leaf is scanned alone; when that redacts or blocks nothing and the
   * leaf sits directly under an object key, it is scanned again in its view
   * `{"<key>":"<leaf>"}` (key and leaf verbatim). A view finding inside the
   * leaf's span is shifted to leaf offsets; a redacting or blocking one
   * outside it blocks as `policy`, since the key cannot be rewritten. The
   * view's result replaces the leaf-alone one, whole, when it redacts or
   * blocks, or when the leaf alone reported nothing. Two results are never
   * merged.
   */
  function scanLeaf(text: string, key: string | undefined): ReturnType<typeof scanText> {
    const alone = scanText(text);
    if ("failure" in alone || key === undefined || hasAction(alone.findings, "redact", "block")) return alone;
    const prefix = `{"${key}":"`;
    const suffix = '"}';
    const view = scanText(prefix + text + suffix);
    if ("failure" in view) return view;
    const leafEnd = prefix.length + text.length;
    const findings: SafeFinding[] = [];
    for (const finding of view.findings) {
      if (finding.start >= prefix.length && finding.end <= leafEnd) {
        findings.push(
          Object.freeze({ ...finding, start: finding.start - prefix.length, end: finding.end - prefix.length }),
        );
      } else if (hasAction([finding], "redact", "block")) {
        return { failure: blocked("policy") };
      }
    }
    if (!hasAction(findings, "redact", "block") && alone.findings.length > 0) return alone;
    // Nothing outside the leaf was rewritten, so the view's text is the
    // prefix, the sanitized leaf, and the suffix; anything else is a core
    // that broke its own contract.
    if (
      !view.text.startsWith(prefix) ||
      !view.text.endsWith(suffix) ||
      view.text.length < prefix.length + suffix.length
    ) {
      return { failure: blocked("core_error") };
    }
    return { text: view.text.slice(prefix.length, view.text.length - suffix.length), findings };
  }

  function sanitizeText(text: string, { boundary = DEFAULT_BOUNDARY, signal }: OperationOptions = {}) {
    if (isAborted(signal)) return ABORTED;
    const scanned = scanText(text);
    if ("failure" in scanned) return scanned.failure;
    emit(scanned.findings, boundary);
    if (hasAction(scanned.findings, "block")) return blocked("policy");
    if (isAborted(signal)) return ABORTED;
    return ok(scanned.text, scanned.findings);
  }

  function sanitizeValue(
    value: unknown,
    { boundary = DEFAULT_BOUNDARY, signal }: OperationOptions = {},
  ): AiContextOutcome<JsonValue> {
    if (isAborted(signal)) return ABORTED;
    const findings: SafeFinding[] = [];
    const walked = walkStrict<BlockedOutcome>(value, traversalLimits, {
      string(text, key): StrictVisit<BlockedOutcome> {
        const scanned = scanLeaf(text, key);
        if ("failure" in scanned) return { ok: false, failure: scanned.failure };
        emit(scanned.findings, boundary);
        findings.push(...scanned.findings);
        if (hasAction(scanned.findings, "block")) return { ok: false, failure: blocked("policy") };
        return { ok: true, text: scanned.text };
      },
      key(key) {
        // A key cannot be rewritten without changing the value's shape, so a
        // key finding that would be redacted or blocked blocks the value.
        const scanned = scanText(key);
        if ("failure" in scanned) return { ok: false, failure: scanned.failure };
        emit(scanned.findings, boundary);
        if (hasAction(scanned.findings, "block", "redact")) return { ok: false, failure: blocked("policy") };
        return { ok: true };
      },
    });
    if (!walked.ok) return typeof walked.failure === "string" ? blocked(walked.failure) : walked.failure;
    if (isAborted(signal)) return ABORTED;
    return ok(walked.value as JsonValue, findings);
  }

  function sanitizeToolResult(result: unknown, { signal }: Omit<OperationOptions, "boundary"> = {}) {
    return typeof result === "string"
      ? sanitizeText(result, { boundary: "tool-result", signal })
      : sanitizeValue(result, { boundary: "tool-result", signal });
  }

  function buildContext(
    parts: readonly ContextPart[],
    { signal }: Omit<OperationOptions, "boundary"> = {},
  ): AiContextOutcome<readonly ContextMessage[]> {
    if (isAborted(signal)) return ABORTED;
    if (!Array.isArray(parts)) return blocked("unsupported_value");
    const messages: ContextMessage[] = [];
    const findings: SafeFinding[] = [];
    for (const part of parts as readonly unknown[]) {
      let role: unknown;
      let boundary: BoundaryLabel;
      let isText: boolean;
      let content: unknown;
      try {
        if (part === null || typeof part !== "object") return blocked("unsupported_value");
        ({ role } = part as { role?: unknown });
        boundary = (part as { boundary?: BoundaryLabel }).boundary ?? DEFAULT_BOUNDARY;
        isText = "text" in part;
        if (!isText && !("value" in part)) return blocked("unsupported_value");
        content = isText ? (part as { text: unknown }).text : (part as { value: unknown }).value;
      } catch {
        return blocked("unsupported_value");
      }
      // The role is a host-chosen label, not input: it is required to be a
      // string and is never scanned.
      if (typeof role !== "string") return blocked("unsupported_value");
      const outcome = isText
        ? sanitizeText(content as string, { boundary, signal })
        : sanitizeValue(content, { boundary, signal });
      if (outcome.outcome !== "ok") return outcome;
      findings.push(...outcome.findings);
      messages.push(Object.freeze({ role, content: outcome.value }));
    }
    if (isAborted(signal)) return ABORTED;
    return ok(Object.freeze(messages), findings);
  }

  function openStream({ boundary = DEFAULT_BOUNDARY, signal }: OperationOptions = {}): AiContextStream {
    let session: ReturnType<AiContextCore["createIncrementalSanitizer"]> | undefined;
    let terminal: BlockedOutcome | AbortedOutcome | undefined;
    let finalized = false;
    let staged = "";
    let findings: SafeFinding[] = [];

    const onAbort = (): void => {
      if (!finalized) fail(ABORTED);
    };
    const detach = (): void => {
      try {
        signal?.removeEventListener?.("abort", onAbort);
      } catch {
        // Nothing to detach from a signal that cannot be read.
      }
    };

    function fail(outcome: BlockedOutcome | AbortedOutcome): void {
      if (terminal === undefined) terminal = outcome;
      staged = "";
      findings = [];
      detach();
      if (session !== undefined) {
        try {
          session.abort();
        } catch {
          // Cleanup on an already-failed session: the outcome is decided.
        }
      }
    }

    function record(result: unknown): void {
      const read = readResult(result);
      if (read === undefined) {
        fail(blocked("core_error"));
        return;
      }
      emit(read.findings, boundary);
      findings.push(...read.findings);
      staged += read.text;
      if (hasAction(read.findings, "block")) fail(blocked("policy"));
    }

    if (isAborted(signal)) {
      fail(ABORTED);
    } else {
      try {
        session = core.createIncrementalSanitizer(incrementalOptions);
      } catch (error) {
        fail(failureFrom(error));
      }
      if (terminal === undefined) {
        try {
          signal?.addEventListener?.("abort", onAbort, { once: true });
        } catch {
          // Polling `signal.aborted` on every call still applies.
        }
      }
    }

    return Object.freeze({
      get accepting(): boolean {
        return !finalized && terminal === undefined;
      },
      append(chunk: string): void {
        if (finalized || terminal !== undefined) return;
        if (isAborted(signal)) {
          fail(ABORTED);
          return;
        }
        if (typeof chunk !== "string") {
          fail(blocked("unsupported_value"));
          return;
        }
        try {
          record((session as NonNullable<typeof session>).append(chunk));
        } catch (error) {
          fail(failureFrom(error));
        }
      },
      finalize(): AiContextOutcome<string> {
        if (finalized) return blocked("lifecycle");
        finalized = true;
        if (terminal === undefined && isAborted(signal)) fail(ABORTED);
        if (terminal === undefined) {
          try {
            record((session as NonNullable<typeof session>).finalize());
          } catch (error) {
            fail(failureFrom(error));
          }
        }
        detach();
        if (terminal !== undefined) return terminal;
        const outcome = ok(staged, findings);
        staged = "";
        findings = [];
        return outcome;
      },
      abort(): void {
        if (finalized) return;
        fail(ABORTED);
      },
    });
  }

  return Object.freeze({ sanitizeText, sanitizeValue, sanitizeToolResult, buildContext, openStream });
}
