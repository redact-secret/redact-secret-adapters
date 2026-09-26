/**
 * The MCP boundary (redact-secret/redact-secret#612) over an AI-context
 * boundary (redact-secret/redact-secret#610). It is a thin specialization:
 * every scan, nested-value walk, policy decision, limit, and core-error
 * mapping is `@redact-secret/adapter-ai-context`'s. This module detects
 * nothing and walks nothing. It adds only the MCP shape:
 *
 * - which parts of a `CallToolResult` are scanned (all of it, as one value),
 *   which content block types exist, and what happens to base64 payloads;
 * - the key-context backstop over the sanitized structured parts (narrowed
 *   by the key-aware `sanitizeValue`, redact-secret/redact-secret#842);
 * - the `tool-arguments` label for opt-in argument sanitation;
 * - a streamed result that stops pulling once the stream stops accepting;
 * - the fixed, input-free `isError` results and audit record;
 * - structural wrappers for a server tool handler of either SDK line.
 *
 * No MCP SDK is imported, at runtime or for types.
 */

import type {
  AbortedOutcome,
  AiContextBoundary,
  AiContextOutcome,
  BlockedOutcome,
  CancellationSignal,
  JsonValue,
  OkOutcome,
} from "@redact-secret/adapter-ai-context";

import type {
  JsonObject,
  McpAuditRecord,
  McpBoundary,
  McpBoundaryOptions,
  McpHandlerOptions,
  McpInvokeContext,
  McpOperationOptions,
  McpOutcome,
  McpStage,
  McpTextResult,
  McpToolCallOptions,
  ToolErrorOutcome,
  WrappedHandler,
} from "./types.js";

/** The AI-context labels this specialization uses. */
export const MCP_BOUNDARY_LABELS = Object.freeze({ arguments: "tool-arguments", result: "tool-result" } as const);

/** The content block types of protocol revisions 2025-06-18 and 2025-11-25. Any other type blocks. */
export const MCP_CONTENT_TYPES = Object.freeze(["text", "image", "audio", "resource_link", "resource"] as const);

/** The MCP boundary's outcomes: the AI-context three, plus the host's own `tool_error`. */
export const MCP_OUTCOMES = Object.freeze(["ok", "blocked", "aborted", "tool_error"] as const);

/** The only keys an audit record may carry. */
export const MCP_AUDIT_FIELDS = Object.freeze(["stage", "outcome", "reason", "code"] as const);

/** Fixed text of the result every `blocked` outcome maps to. */
export const MCP_BLOCKED_TEXT =
  "This MCP tool call was blocked by secret-redaction policy. No content, arguments, or error detail is included.";

/** Fixed text of the result a `tool_error` outcome maps to. */
export const MCP_TOOL_ERROR_TEXT = "This MCP tool call failed. No content, arguments, or error detail is included.";

const ABORTED: AbortedOutcome = Object.freeze({ outcome: "aborted" });
const UNSUPPORTED: BlockedOutcome = Object.freeze({ outcome: "blocked", reason: "unsupported_value" });
const POLICY: BlockedOutcome = Object.freeze({ outcome: "blocked", reason: "policy" });
const TOOL_ERROR: ToolErrorOutcome = Object.freeze({ outcome: "tool_error" });
const NO_FINDINGS = Object.freeze([]);

/** Fixed, input-free `CallToolResult` for a `blocked` outcome. A new object on every call. */
export function mcpBlockedResult(): McpTextResult {
  return { content: [{ type: "text", text: MCP_BLOCKED_TEXT }], isError: true };
}

/** Fixed, input-free `CallToolResult` for a `tool_error` outcome. A new object on every call. */
export function mcpToolErrorResult(): McpTextResult {
  return { content: [{ type: "text", text: MCP_TOOL_ERROR_TEXT }], isError: true };
}

/**
 * What an outcome may put on the wire, into a log, a store, or model
 * context: `ok` delivers its value and nothing else; every `blocked` reason
 * delivers {@link mcpBlockedResult}; `tool_error` delivers
 * {@link mcpToolErrorResult}; `aborted` delivers nothing (`null`). Never a
 * JSON-RPC error: its `message` and `data` are free text hosts log verbatim.
 */
export function toCallToolResult<T>(outcome: McpOutcome<T>): T | McpTextResult | null {
  switch (outcome?.outcome) {
    case "ok":
      return outcome.value;
    case "blocked":
      return mcpBlockedResult();
    case "tool_error":
      return mcpToolErrorResult();
    case "aborted":
      return null;
    default:
      throw new TypeError("toCallToolResult: not an MCP boundary outcome");
  }
}

/** The input-free audit record of one crossing. */
export function mcpAuditRecord(outcome: McpOutcome<unknown>, stage: McpStage): McpAuditRecord {
  if (stage !== "arguments" && stage !== "result") throw new TypeError("mcpAuditRecord: unknown stage");
  const record: { -readonly [K in keyof McpAuditRecord]: McpAuditRecord[K] } = { stage, outcome: outcome.outcome };
  if (outcome.outcome === "blocked") {
    record.reason = outcome.reason;
    if (outcome.code !== undefined) record.code = outcome.code;
  }
  return Object.freeze(record);
}

function isAborted(signal: CancellationSignal | undefined): boolean {
  try {
    return signal != null && signal.aborted === true;
  } catch {
    return true;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function define(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, enumerable: true, configurable: true, writable: true });
}

/** A copy of `object` without `omit`, in the original key order. */
function without(object: Record<string, unknown>, omit: string): Record<string, unknown> {
  const copy: Record<string, unknown> = {};
  for (const key of Object.keys(object)) if (key !== omit) define(copy, key, object[key]);
  return copy;
}

/** `sanitized` with `key` put back, unscanned, at its original position in `original`. */
function restore(original: Record<string, unknown>, sanitized: Record<string, unknown>, key: string) {
  const out: Record<string, unknown> = {};
  for (const name of Object.keys(original)) define(out, name, name === key ? original[key] : sanitized[name]);
  return out;
}

function ok<T>(value: T, findings: OkOutcome<unknown>["findings"]): OkOutcome<T> {
  return Object.freeze({ outcome: "ok", value, findings });
}

type Reassemble = ((clean: Record<string, unknown>) => Record<string, unknown>) | null;
type Prepared = { failure: BlockedOutcome } | { view: unknown; reassemble: Reassemble };

/** The `signal` of a server handler context: `extra.signal` (v1) or `ctx.mcpReq.signal` (v2). */
function signalOf(context: unknown): CancellationSignal | undefined {
  try {
    if (context === null || typeof context !== "object") return undefined;
    const direct = (context as { signal?: CancellationSignal }).signal;
    if (direct != null) return direct;
    return (context as { mcpReq?: { signal?: CancellationSignal } }).mcpReq?.signal ?? undefined;
  } catch {
    // A context whose signal cannot be read is treated as cancelled.
    return { aborted: true };
  }
}

/**
 * Creates the MCP boundary over an AI-context boundary the host configured
 * (limits, policy, `onFinding`). Throws a `TypeError` with a fixed message
 * for a missing boundary or malformed options: a programming error, not an
 * input.
 */
export function createMcpBoundaryWith(boundary: AiContextBoundary, options: McpBoundaryOptions = {}): McpBoundary {
  if (
    boundary === null ||
    typeof boundary !== "object" ||
    typeof boundary.sanitizeValue !== "function" ||
    typeof boundary.sanitizeText !== "function" ||
    typeof boundary.openStream !== "function"
  ) {
    throw new TypeError("createMcpBoundaryWith: an AI-context boundary is required");
  }
  if (options === null || typeof options !== "object") {
    throw new TypeError("createMcpBoundaryWith: options must be an object");
  }
  const { binaryContent = "block", onAudit } = options;
  if (binaryContent !== "block" && binaryContent !== "pass") {
    throw new TypeError('createMcpBoundaryWith: binaryContent must be "block" or "pass"');
  }
  if (onAudit !== undefined && typeof onAudit !== "function") {
    throw new TypeError("createMcpBoundaryWith: onAudit must be a function");
  }

  function audit<T extends McpOutcome<unknown>>(outcome: T, stage: McpStage): T {
    if (typeof onAudit === "function") {
      try {
        onAudit(mcpAuditRecord(outcome, stage));
      } catch {
        // Observational: a throwing callback never changes the outcome, and
        // its error is never read.
      }
    }
    return outcome;
  }

  function detachBinary(
    object: Record<string, unknown>,
    key: string,
  ): { failure: BlockedOutcome } | { view: Record<string, unknown>; binary: boolean } {
    if (!(key in object)) return { view: object, binary: false };
    if (binaryContent === "block" || typeof object[key] !== "string") return { failure: UNSUPPORTED };
    return { view: without(object, key), binary: true };
  }

  function prepareBlock(block: unknown): Prepared {
    if (!isPlainObject(block) || !(MCP_CONTENT_TYPES as readonly unknown[]).includes(block.type)) {
      return { failure: UNSUPPORTED };
    }
    if (block.type === "image" || block.type === "audio") {
      const detached = detachBinary(block, "data");
      if ("failure" in detached) return detached;
      return { view: detached.view, reassemble: detached.binary ? (clean) => restore(block, clean, "data") : null };
    }
    if (block.type === "resource") {
      const resource = block.resource;
      if (!isPlainObject(resource)) return { failure: UNSUPPORTED };
      const detached = detachBinary(resource, "blob");
      if ("failure" in detached) return detached;
      if (!detached.binary) return { view: block, reassemble: null };
      const view: Record<string, unknown> = {};
      for (const key of Object.keys(block)) define(view, key, key === "resource" ? detached.view : block[key]);
      return {
        view,
        reassemble: (clean) => {
          const out: Record<string, unknown> = {};
          for (const key of Object.keys(block)) {
            define(
              out,
              key,
              key === "resource" ? restore(resource, clean.resource as Record<string, unknown>, "blob") : clean[key],
            );
          }
          return out;
        },
      };
    }
    return { view: block, reassemble: null };
  }

  /**
   * The key-context backstop: each value-shaped part of the SANITIZED value
   * is serialized and scanned once more as text. The key-aware leaf pass
   * already redacted every leaf its own key identifies (placeholders are not
   * detected again), so what is left for this check is context from a
   * sibling or parent key. A `redact` or `block` finding here cannot be
   * mapped back onto one leaf: `policy`.
   */
  function checkKeyContext(parts: unknown[], label: "tool-result" | "tool-arguments", signal?: CancellationSignal) {
    for (const part of parts) {
      const outcome = boundary.sanitizeText(JSON.stringify(part), { boundary: label, signal });
      if (outcome.outcome !== "ok") return outcome;
      if (outcome.findings.some((finding) => finding.action === "redact" || finding.action === "block")) return POLICY;
    }
    return undefined;
  }

  /** The result without `content`, and every block without its already-scanned `text`. */
  function keyContextParts(result: Record<string, unknown>): unknown[] {
    const parts: unknown[] = [without(result, "content")];
    for (const block of Array.isArray(result.content) ? (result.content as Record<string, unknown>[]) : []) {
      if (block.type === "text") parts.push(without(block, "text"));
      else if (block.type === "resource") {
        parts.push({ ...block, resource: without(block.resource as Record<string, unknown>, "text") });
      } else parts.push(block);
    }
    return parts;
  }

  function resultOutcome(result: unknown, signal?: CancellationSignal): McpOutcome<JsonObject> {
    if (isAborted(signal)) return ABORTED;
    if (!isPlainObject(result)) return UNSUPPORTED;
    let content: unknown;
    try {
      content = result.content;
    } catch {
      return UNSUPPORTED;
    }
    if (content !== undefined && !Array.isArray(content)) return UNSUPPORTED;

    const reassembly: Reassemble[] = [];
    let view: unknown = result;
    if (Array.isArray(content)) {
      const blocks: unknown[] = [];
      for (const block of content) {
        let prepared: Prepared;
        try {
          prepared = prepareBlock(block);
        } catch {
          return UNSUPPORTED;
        }
        if ("failure" in prepared) return prepared.failure;
        blocks.push(prepared.view);
        reassembly.push(prepared.reassemble);
      }
      const shaped: Record<string, unknown> = {};
      try {
        for (const key of Object.keys(result)) define(shaped, key, key === "content" ? blocks : result[key]);
      } catch {
        return UNSUPPORTED;
      }
      view = shaped;
    }

    const outcome = boundary.sanitizeValue(view, { boundary: MCP_BOUNDARY_LABELS.result, signal }) as AiContextOutcome<
      Record<string, JsonValue>
    >;
    if (outcome.outcome !== "ok") return outcome;
    const context = checkKeyContext(keyContextParts(outcome.value), MCP_BOUNDARY_LABELS.result, signal);
    if (context !== undefined) return context;
    if (!reassembly.some(Boolean)) return outcome;
    const value: Record<string, unknown> = {};
    for (const key of Object.keys(outcome.value)) {
      define(
        value,
        key,
        key === "content"
          ? (outcome.value.content as Record<string, unknown>[]).map((block, index) => {
              const reassemble = reassembly[index];
              return reassemble ? reassemble(block) : block;
            })
          : outcome.value[key],
      );
    }
    return ok(value as JsonObject, outcome.findings);
  }

  function argumentsOutcome(args: unknown, signal?: CancellationSignal): McpOutcome<JsonObject | undefined> {
    if (isAborted(signal)) return ABORTED;
    if (args === undefined) return ok(undefined, NO_FINDINGS);
    if (!isPlainObject(args)) return UNSUPPORTED;
    const outcome = boundary.sanitizeValue(args, { boundary: MCP_BOUNDARY_LABELS.arguments, signal });
    if (outcome.outcome !== "ok") return outcome;
    return (
      checkKeyContext([outcome.value], MCP_BOUNDARY_LABELS.arguments, signal) ?? (outcome as OkOutcome<JsonObject>)
    );
  }

  async function callOutcome(
    invoke: (context: McpInvokeContext) => unknown,
    context: McpInvokeContext,
  ): Promise<McpOutcome<JsonObject>> {
    const { signal } = context;
    if (isAborted(signal)) return ABORTED;
    if (typeof invoke !== "function") return TOOL_ERROR;
    let raw: unknown;
    try {
      raw = await invoke(Object.freeze(context));
    } catch {
      // The tool's error is never read: its message can carry input.
      return isAborted(signal) ? ABORTED : TOOL_ERROR;
    }
    return resultOutcome(raw, signal);
  }

  type Step = { done?: unknown; value?: unknown };
  type AnyIterator = { next(): Step | Promise<Step>; return?(): unknown };

  function iteratorOf(chunks: unknown): AnyIterator | undefined {
    if (chunks === null || (typeof chunks !== "object" && typeof chunks !== "function")) return undefined;
    const source = chunks as { [Symbol.asyncIterator]?: () => AnyIterator; [Symbol.iterator]?: () => AnyIterator };
    const asyncFactory = source[Symbol.asyncIterator];
    if (typeof asyncFactory === "function") return asyncFactory.call(source);
    const syncFactory = source[Symbol.iterator];
    if (typeof syncFactory === "function") return syncFactory.call(source);
    return undefined;
  }

  /** Resolves with the next step, or with `ABORT` as soon as a real signal fires while the producer is pending. */
  const ABORT = Symbol("abort");
  function nextOrAbort(iterator: AnyIterator, signal: CancellationSignal | undefined): Promise<Step | typeof ABORT> {
    const next = Promise.resolve().then(() => iterator.next());
    if (typeof signal?.addEventListener !== "function") return next;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<typeof ABORT>((resolve) => {
      onAbort = () => resolve(ABORT);
      try {
        signal.addEventListener?.("abort", onAbort, { once: true });
      } catch {
        // Polling `aborted` after each step still applies.
      }
    });
    // A producer that rejects after the race was lost must not surface as
    // an unhandled rejection.
    next.catch(() => undefined);
    return Promise.race([next, aborted]).finally(() => {
      try {
        if (onAbort) signal.removeEventListener?.("abort", onAbort);
      } catch {
        // Nothing to detach from a signal that cannot be read.
      }
    });
  }

  /**
   * Closes the producer without waiting on it: `return()` on its iterator,
   * and `destroy()` on the source when it has one (a Node.js `Readable`,
   * whose async iterator queues `return()` behind a pending `next()`). A
   * producer that is slow to close cannot hold the outcome back.
   */
  function close(iterator: AnyIterator, source: unknown): void {
    try {
      const closing = iterator.return?.();
      if (closing !== null && typeof closing === "object" && typeof (closing as Promise<unknown>).then === "function") {
        (closing as Promise<unknown>).then(undefined, () => undefined);
      }
    } catch {
      // Closing a producer whose output is discarded: the outcome is decided.
    }
    try {
      const destroy = (source as { destroy?: unknown } | null)?.destroy;
      if (typeof destroy === "function") destroy.call(source);
    } catch {
      // As above.
    }
  }

  async function streamOutcome(chunks: unknown, signal?: CancellationSignal): Promise<McpOutcome<McpTextResult>> {
    if (isAborted(signal)) return ABORTED;
    let iterator: AnyIterator | undefined;
    try {
      iterator = iteratorOf(chunks);
    } catch {
      return TOOL_ERROR;
    }
    if (iterator === undefined) return UNSUPPORTED;
    const stream = boundary.openStream({ boundary: MCP_BOUNDARY_LABELS.result, signal });
    if (stream.accepting === true) {
      for (;;) {
        let step: Step | typeof ABORT;
        try {
          step = await nextOrAbort(iterator, signal);
        } catch {
          // The producer's error is never read.
          stream.abort();
          return isAborted(signal) ? ABORTED : TOOL_ERROR;
        }
        if (step === ABORT) {
          stream.abort();
          close(iterator, chunks);
          return ABORTED;
        }
        if (step === null || typeof step !== "object") {
          stream.abort();
          return TOOL_ERROR;
        }
        if (step.done) break;
        stream.append(step.value as string);
        if (stream.accepting !== true) {
          close(iterator, chunks);
          break;
        }
      }
    } else {
      close(iterator, chunks);
    }
    const outcome = stream.finalize();
    if (outcome.outcome !== "ok") return outcome;
    return ok({ content: [{ type: "text", text: outcome.value }] }, outcome.findings);
  }

  /** What a server handler returns for an outcome. `aborted` gets the blocked result, which the SDK never sends for a cancelled request. */
  function wire<T>(outcome: McpOutcome<T>): T | McpTextResult {
    if (outcome.outcome === "ok") return outcome.value;
    return outcome.outcome === "tool_error" ? mcpToolErrorResult() : mcpBlockedResult();
  }

  function splitParams(params: unknown[]): { hasArgs: boolean; args: unknown; context: unknown } {
    return params.length >= 2
      ? { hasArgs: true, args: params[0], context: params[1] }
      : { hasArgs: false, args: undefined, context: params[0] };
  }

  function wrap<H extends (...params: never[]) => unknown, R>(
    handler: H,
    { sanitizeArguments = false }: McpHandlerOptions,
    finish: (invoke: () => unknown, signal: CancellationSignal | undefined) => Promise<McpOutcome<R>>,
  ): (...params: unknown[]) => Promise<R | McpTextResult> {
    if (typeof handler !== "function") throw new TypeError("wrapToolHandler: handler must be a function");
    return async (...params: unknown[]) => {
      const { hasArgs, args, context } = splitParams(params);
      const signal = signalOf(context);
      let forwarded = args;
      if (sanitizeArguments && hasArgs) {
        const sanitized = audit(argumentsOutcome(args, signal), "arguments");
        if (sanitized.outcome !== "ok") return wire(sanitized) as McpTextResult;
        forwarded = sanitized.value;
      }
      const invoke = handler as unknown as (...p: unknown[]) => unknown;
      const call = hasArgs ? () => invoke(forwarded, context) : () => invoke(context);
      return wire(audit(await finish(call, signal), "result"));
    };
  }

  return Object.freeze({
    sanitizeToolResult(result: unknown, { signal }: McpOperationOptions = {}) {
      return audit(resultOutcome(result, signal), "result");
    },
    sanitizeToolArguments(args: unknown, { signal }: McpOperationOptions = {}) {
      return audit(argumentsOutcome(args, signal), "arguments");
    },
    async sanitizeToolCall(invoke: (context: McpInvokeContext) => unknown, options: McpToolCallOptions = {}) {
      const { signal } = options;
      if ("arguments" in options) {
        const sanitized = audit(argumentsOutcome(options.arguments, signal), "arguments");
        if (sanitized.outcome !== "ok") return sanitized;
        return audit(await callOutcome(invoke, { signal, arguments: sanitized.value }), "result");
      }
      return audit(await callOutcome(invoke, { signal }), "result");
    },
    async sanitizeStreamedToolResult(chunks: unknown, { signal }: McpOperationOptions = {}) {
      return audit(await streamOutcome(chunks, signal), "result");
    },
    wrapToolHandler<H extends (...params: never[]) => unknown>(handler: H, options: McpHandlerOptions = {}) {
      return wrap(handler, options, (call, signal) => callOutcome(call, { signal })) as WrappedHandler<H>;
    },
    wrapStreamedToolHandler<H extends (...params: never[]) => unknown>(handler: H, options: McpHandlerOptions = {}) {
      return wrap(handler, options, async (call, signal) => {
        if (isAborted(signal)) return ABORTED;
        let chunks: unknown;
        try {
          chunks = await call();
        } catch {
          return isAborted(signal) ? ABORTED : TOOL_ERROR;
        }
        return streamOutcome(chunks, signal);
      }) as WrappedHandler<H, McpTextResult>;
    },
  });
}
