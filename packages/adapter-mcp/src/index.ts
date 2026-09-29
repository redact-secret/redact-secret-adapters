/**
 * `@redact-secret/adapter-mcp`: the supported MCP redaction boundary
 * (redact-secret/redact-secret#612), a thin specialization of
 * `@redact-secret/adapter-ai-context`.
 *
 * ```js
 * import { createMcpBoundary, toCallToolResult } from "@redact-secret/adapter-mcp";
 *
 * const mcp = await createMcpBoundary(); // conservative documented defaults
 * const outcome = await mcp.sanitizeToolCall(({ signal }) => client.callTool(params, undefined, { signal }));
 * const safe = toCallToolResult(outcome); // null when aborted
 *
 * const read = await mcp.sanitizeResourceRead(({ signal }) => client.readResource({ uri }, { signal }));
 * const response = toReadResourceResponse(read); // { result } | { error } | null
 * ```
 *
 * The core is loaded on call, by `@redact-secret/adapter-ai-context`'s live
 * factory. No MCP SDK is imported.
 */

import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";

import { createMcpBoundaryWith } from "./boundary.js";
import type { CreateMcpBoundaryOptionsWithDefaults, McpBoundary } from "./types.js";

export type { CoreActivation } from "@redact-secret/adapter-ai-context";
export {
  createMcpBoundaryWith,
  MCP_AUDIT_FIELDS,
  MCP_BLOCKED_TEXT,
  MCP_BOUNDARY_LABELS,
  MCP_CONTENT_TYPES,
  MCP_OUTCOMES,
  MCP_RESOURCE_BLOCKED_MESSAGE,
  MCP_RESOURCE_ERROR_CODE,
  MCP_RESOURCE_OUTCOMES,
  MCP_RESOURCE_READ_ERROR_MESSAGE,
  MCP_TOOL_ERROR_TEXT,
  McpResourceError,
  mcpAuditRecord,
  mcpBlockedResult,
  mcpResourceBlockedError,
  mcpResourceReadError,
  mcpToolErrorResult,
  toCallToolResult,
  toReadResourceResponse,
} from "./boundary.js";
export type {
  CreateMcpBoundaryOptions,
  CreateMcpBoundaryOptionsWithDefaults,
  JsonObject,
  McpAuditRecord,
  McpBinaryContent,
  McpBoundary,
  McpBoundaryOptions,
  McpChunks,
  McpHandlerOptions,
  McpInvokeContext,
  McpOperationOptions,
  McpOutcome,
  McpResourceErrorLike,
  McpResourceErrorObject,
  McpResourceOutcome,
  McpResourceReadResponse,
  McpStage,
  McpTextContent,
  McpTextResult,
  McpToolCallOptions,
  ReadErrorOutcome,
  ToolErrorOutcome,
  WrappedHandler,
  WrappedResourceHandler,
} from "./types.js";

/**
 * Loads and initializes `@redact-secret/core` through
 * `createAiContextBoundary`, and returns the MCP boundary over it.
 *
 * Any limit set left out comes from `AI_CONTEXT_DEFAULT_LIMITS` — documented,
 * finite values, never an unbounded mode. Passing all three, as callers before
 * `0.1.0-alpha.2` had to, behaves exactly as it did, and
 * `createMcpBoundaryWith` over an explicit boundary is unchanged.
 *
 * `options.pii` is forwarded to the AI-context factory, which activates core
 * PII selectors for the whole process. Omitted, an activation the application
 * already made is accepted rather than fought over. Given, a selection that is
 * not the one actually active fails the boundary closed, like any other
 * initialization failure.
 *
 * Like the AI-context live factory, it never rejects for an initialization
 * failure: every operation then fails closed as `blocked` / `core_error`,
 * which maps to the fixed blocked result. Rejects only for malformed
 * `options`, with a fixed message.
 */
export async function createMcpBoundary(options: CreateMcpBoundaryOptionsWithDefaults = {}): Promise<McpBoundary> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("createMcpBoundary: options are required");
  }
  const { binaryContent, onAudit, ...aiContextOptions } = options;
  // Read by property so an activation inherited through a prototype is
  // forwarded too; the rest spread above copies own enumerable keys only.
  const { pii } = options;
  const boundary = await createAiContextBoundary(pii === undefined ? aiContextOptions : { ...aiContextOptions, pii });
  return createMcpBoundaryWith(boundary, { binaryContent, onAudit });
}
