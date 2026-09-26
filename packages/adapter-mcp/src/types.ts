/**
 * The public types of the MCP boundary (redact-secret/redact-secret#612,
 * `docs/reference/mcp-boundary.md` in the core repository). Outcomes,
 * findings, limits and signals are the AI-context boundary's own types,
 * imported from `@redact-secret/adapter-ai-context`: this package adds only
 * the MCP shape.
 *
 * No type is imported from an MCP SDK. A `CallToolResult` is a structural
 * shape here, as it is on the wire, so neither SDK line enters the runtime
 * or the type graph.
 */

import type {
  AbortedOutcome,
  AiContextBoundaryOptions,
  BlockedOutcome,
  BlockReason,
  CancellationSignal,
  JsonValue,
  OkOutcome,
} from "@redact-secret/adapter-ai-context";
import type { SecretScanErrorCode } from "@redact-secret/core";

/** A tool, or a streamed tool's producer, threw or rejected. Its error was never read. */
export interface ToolErrorOutcome {
  readonly outcome: "tool_error";
}

/** Every MCP operation ends in exactly one of these. A non-`ok` outcome carries no value and no findings. */
export type McpOutcome<T> = OkOutcome<T> | BlockedOutcome | AbortedOutcome | ToolErrorOutcome;

/** A resource read threw or rejected. Its error was never read. */
export interface ReadErrorOutcome {
  readonly outcome: "read_error";
}

/** Every `resources/read` operation ends in exactly one of these. */
export type McpResourceOutcome<T> = OkOutcome<T> | BlockedOutcome | AbortedOutcome | ReadErrorOutcome;

/** A fixed, input-free JSON-RPC error object: code -32603, a fixed message, never `data`. */
export type McpResourceErrorObject = {
  readonly code: number;
  readonly message: string;
};

/** What a `resources/read` outcome delivers: the sanitized result, or a fixed JSON-RPC error. */
export type McpResourceReadResponse<T> = { readonly result: T } | { readonly error: McpResourceErrorObject };

/** A sanitized `CallToolResult` (or sanitized tool arguments): a plain JSON object. */
export type JsonObject = { readonly [key: string]: JsonValue };

/**
 * One text block, as the fixed results and a released stream carry it. A
 * type alias, not an interface, so it is assignable to the SDKs' index-signed
 * content types.
 */
export type McpTextContent = {
  readonly type: "text";
  readonly text: string;
};

/** The fixed `isError` results, and a released streamed result. Assignable to either SDK line's `CallToolResult`. */
export type McpTextResult = {
  content: McpTextContent[];
  isError?: true;
};

/** Which crossing an audit record describes: a tool call's arguments or result, or a `resources/read` result. */
export type McpStage = "arguments" | "result" | "resource";

/**
 * The input-free audit record of one crossing. `reason` is present only for
 * `blocked`, and `code` only when the core raised an error from its fixed
 * registry. It holds no count, size, offset, or text derived from input.
 */
export interface McpAuditRecord {
  readonly stage: McpStage;
  readonly outcome: McpOutcome<unknown>["outcome"] | McpResourceOutcome<unknown>["outcome"];
  readonly reason?: BlockReason;
  readonly code?: SecretScanErrorCode;
}

/** How a base64 payload (`image.data`, `audio.data`, `resource.blob`) is treated. */
export type McpBinaryContent = "block" | "pass";

export interface McpBoundaryOptions {
  /**
   * `"block"` (the default) blocks a result that carries a base64 payload as
   * `unsupported_value`: it cannot be scanned. `"pass"` passes a string
   * payload unchanged and unscanned, at its original key position; every
   * other field of the block is still scanned. A non-string payload always
   * blocks.
   */
  readonly binaryContent?: McpBinaryContent;
  /**
   * Observational: called once per crossing with the input-free audit
   * record. An exception it throws is swallowed, never read, and never
   * changes an outcome. Findings reach auditing only through the AI-context
   * boundary's `onFinding`.
   */
  readonly onAudit?: (record: McpAuditRecord) => void;
}

/** The live factory's options: the AI-context boundary's, plus the MCP ones. */
export type CreateMcpBoundaryOptions = AiContextBoundaryOptions & McpBoundaryOptions;

export interface McpOperationOptions {
  readonly signal?: CancellationSignal;
}

export interface McpToolCallOptions extends McpOperationOptions {
  /**
   * Opt-in argument sanitation. When this key is present (even as
   * `undefined`), the arguments are sanitized first, labelled
   * `tool-arguments`; on any non-`ok` outcome the tool is not invoked.
   * `invoke` then receives the sanitized arguments, never these.
   */
  readonly arguments?: unknown;
}

/** What `sanitizeToolCall` hands the host's invocation. */
export interface McpInvokeContext {
  readonly signal?: CancellationSignal;
  /** The sanitized arguments; present only when `arguments` was passed. */
  readonly arguments?: JsonObject;
}

/** Chunks of one logical text, from a streaming decoder. */
export type McpChunks = Iterable<unknown> | AsyncIterable<unknown>;

export interface McpHandlerOptions {
  /** Sanitize the handler's arguments (label `tool-arguments`) before it runs. Default `false`. */
  readonly sanitizeArguments?: boolean;
}

export interface McpBoundary {
  /**
   * One `CallToolResult`, before it is logged, persisted, or placed into
   * model context: the whole result as ONE AI-context `sanitizeValue`
   * (label `tool-result`), then the key-context backstop.
   */
  sanitizeToolResult(result: unknown, options?: McpOperationOptions): McpOutcome<JsonObject>;
  /**
   * Opt-in: a tool call's `arguments` (label `tool-arguments`), then the
   * key-context backstop. Absent arguments are `ok` with no value; anything but
   * a plain object is `unsupported_value`.
   */
  sanitizeToolArguments(args: unknown, options?: McpOperationOptions): McpOutcome<JsonObject | undefined>;
  /**
   * Runs the host's tool invocation (a client `callTool`, or any function
   * returning a `CallToolResult`) and sanitizes its result. A throw or
   * rejection is `tool_error`, its error never read.
   */
  sanitizeToolCall(
    invoke: (context: McpInvokeContext) => unknown,
    options?: McpToolCallOptions,
  ): Promise<McpOutcome<JsonObject>>;
  /**
   * Chunks of one logical text through one staged AI-context stream,
   * released as `{ content: [{ type: "text", text }] }` only by a successful
   * finalize. Stops pulling and closes the producer as soon as the stream
   * stops accepting.
   */
  sanitizeStreamedToolResult(chunks: unknown, options?: McpOperationOptions): Promise<McpOutcome<McpTextResult>>;
  /**
   * Wraps an MCP server tool handler (`(args, ctx)` or `(ctx)`, either SDK
   * line): reads the request's signal from `ctx`, optionally sanitizes the
   * arguments, catches every handler failure before the SDK can turn its
   * message into result text, and returns the sanitized result or a fixed
   * `isError` result. Preventive: the host still applies the boundary.
   */
  wrapToolHandler<H extends (...params: never[]) => unknown>(
    handler: H,
    options?: McpHandlerOptions,
  ): WrappedHandler<H>;
  /** As `wrapToolHandler`, for a handler that returns (or resolves to) chunks of one logical text. */
  wrapStreamedToolHandler<H extends (...params: never[]) => unknown>(
    handler: H,
    options?: McpHandlerOptions,
  ): WrappedHandler<H, McpTextResult>;
  /**
   * One `ReadResourceResult` (`resources/read`,
   * redact-secret/redact-secret#843), before it is logged, persisted, or
   * placed into model context: the whole result as ONE AI-context
   * `sanitizeValue` (label `resource`), then the key-context backstop.
   * Entry `text` is scanned as text whatever its `mimeType`; a `blob`
   * follows `binaryContent`.
   */
  sanitizeResourceResult(result: unknown, options?: McpOperationOptions): McpResourceOutcome<JsonObject>;
  /**
   * Runs the host's resource read (a client `readResource`, or any function
   * returning a `ReadResourceResult`) and sanitizes its result. A throw or
   * rejection is `read_error`, its error never read.
   */
  sanitizeResourceRead(
    invoke: (context: McpInvokeContext) => unknown,
    options?: McpOperationOptions,
  ): Promise<McpResourceOutcome<JsonObject>>;
  /**
   * Wraps an MCP server resource read callback (`(uri, extra)`,
   * `(uri, variables, extra)`, or a low-level `(request, extra)`, either SDK
   * line): reads the request's signal from the last parameter, catches every
   * callback failure, and resolves to the sanitized result or throws a
   * {@link McpResourceErrorLike} carrying exactly the fixed JSON-RPC error.
   * Preventive: the host still applies the boundary.
   */
  wrapResourceReadHandler<H extends (...params: never[]) => unknown>(handler: H): WrappedResourceHandler;
}

/** What a wrapped resource read callback throws: an `Error` whose `code` and `message` are the fixed JSON-RPC error. */
export interface McpResourceErrorLike extends Error {
  readonly code: number;
}

/**
 * A wrapped resource read callback accepts whatever the SDK passes, so it is
 * assignable to either line's read callback, and resolves to the sanitized
 * `ReadResourceResult`.
 */
export type WrappedResourceHandler = (...params: unknown[]) => Promise<JsonObject>;

/**
 * A wrapped handler accepts whatever the SDK passes (`(args, ctx)` or
 * `(ctx)`), so it is assignable to either line's tool callback, and resolves
 * to the sanitized result or a fixed `isError` result.
 */
export type WrappedHandler<H extends (...params: never[]) => unknown, R = Awaited<ReturnType<H>>> = (
  ...params: unknown[]
) => Promise<R | McpTextResult>;
