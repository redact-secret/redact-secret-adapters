/**
 * `@redact-secret/adapter-mcp`: the supported MCP redaction boundary
 * (redact-secret/redact-secret#612), a thin specialization of
 * `@redact-secret/adapter-ai-context`.
 *
 * ```js
 * import { createMcpBoundary, toCallToolResult } from "@redact-secret/adapter-mcp";
 *
 * const mcp = await createMcpBoundary({ wholeInputLimits, incrementalLimits, traversalLimits });
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
import type { CreateMcpBoundaryOptions, McpBoundary } from "./types.js";

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
 * Like the AI-context live factory, it never rejects for an initialization
 * failure: every operation then fails closed as `blocked` / `core_error`,
 * which maps to the fixed blocked result. Rejects only for malformed
 * `options`, with a fixed message.
 */
export async function createMcpBoundary(options: CreateMcpBoundaryOptions): Promise<McpBoundary> {
  if (options === null || typeof options !== "object") {
    throw new TypeError("createMcpBoundary: options are required");
  }
  const { binaryContent, onAudit, ...aiContextOptions } = options;
  const boundary = await createAiContextBoundary(aiContextOptions);
  return createMcpBoundaryWith(boundary, { binaryContent, onAudit });
}
