/**
 * Coexistence with `@redact-secret/vault`
 * (redact-secret/redact-secret-adapters#52), on the **real installed core**
 * through the live factory.
 *
 * A tool result is one of the places a host most often holds text it captured
 * on the way to a model. If this boundary rewrote a `<rsv_…>` token, what the
 * host then logs, persists and puts into context would no longer match the
 * mapping the application still holds, and `restore()` would answer
 * `RESTORE_DENIED` with nothing to point at. `@redact-secret/vault` ships from
 * the sibling `redact-secret-vault` repository and is **not** a
 * dependency of this one; only the shape of its token is reproduced here.
 *
 * The fixed texts this package emits are checked for the literal `rsv_` too,
 * because the vault refuses any input that already holds one
 * (`TOKEN_LITERAL_IN_INPUT`).
 */

import { expect, test } from "vitest";

import { VAULT_TOKEN, VAULT_TOKEN_CONTEXTS, VAULT_TOKEN_LITERAL } from "../../../fixtures/vault-token.js";
import {
  createMcpBoundary,
  MCP_BLOCKED_TEXT,
  MCP_RESOURCE_BLOCKED_MESSAGE,
  MCP_RESOURCE_READ_ERROR_MESSAGE,
  MCP_TOOL_ERROR_TEXT,
  mcpBlockedResult,
  mcpResourceBlockedError,
  mcpResourceReadError,
  mcpToolErrorResult,
  toCallToolResult,
  toReadResourceResponse,
} from "../src/index.js";

test("every adversarial context survives a tool result byte for byte", async () => {
  const mcp = await createMcpBoundary();
  for (const { name, text } of VAULT_TOKEN_CONTEXTS) {
    const result = { content: [{ type: "text", text }] };
    const outcome = mcp.sanitizeToolResult(result);
    expect(outcome.outcome, name).toBe("ok");
    expect(toCallToolResult(outcome), name).toEqual(result);
  }
});

test("a token survives structuredContent, _meta, tool arguments, and a resource read", async () => {
  const mcp = await createMcpBoundary();
  const result = {
    content: [{ type: "text", text: `Client(api_key="${VAULT_TOKEN}")` }],
    structuredContent: { api_key: VAULT_TOKEN, headers: { Authorization: `Bearer ${VAULT_TOKEN}` } },
    _meta: { note: `the capture note says ${VAULT_TOKEN}` },
  };
  expect(toCallToolResult(mcp.sanitizeToolResult(result))).toEqual(result);

  const args = { api_key: VAULT_TOKEN, command: `export OPENAI_API_KEY=${VAULT_TOKEN}` };
  const sanitizedArgs = mcp.sanitizeToolArguments(args);
  expect(sanitizedArgs.outcome).toBe("ok");
  if (sanitizedArgs.outcome === "ok") expect(sanitizedArgs.value).toEqual(args);

  const read = { contents: [{ uri: "file:///notes.txt", text: `Authorization: Bearer ${VAULT_TOKEN}` }] };
  const response = toReadResourceResponse(mcp.sanitizeResourceResult(read));
  expect(response).toEqual({ result: read });
});

test("a token survives streamed tool output split across chunks", async () => {
  const mcp = await createMcpBoundary();
  const text = `progress\nexport OPENAI_API_KEY=${VAULT_TOKEN}\ndone\n`;
  const split = text.indexOf(VAULT_TOKEN) + 8;
  const outcome = await mcp.sanitizeStreamedToolResult([text.slice(0, split), text.slice(split)]);
  expect(toCallToolResult(outcome)).toEqual({ content: [{ type: "text", text }] });
});

test("no fixed text this package emits contains the literal the vault refuses", () => {
  const fixed = [
    MCP_BLOCKED_TEXT,
    MCP_TOOL_ERROR_TEXT,
    MCP_RESOURCE_BLOCKED_MESSAGE,
    MCP_RESOURCE_READ_ERROR_MESSAGE,
    JSON.stringify(mcpBlockedResult()),
    JSON.stringify(mcpToolErrorResult()),
    JSON.stringify(mcpResourceBlockedError()),
    JSON.stringify(mcpResourceReadError()),
  ];
  for (const text of fixed) expect(text).not.toContain(VAULT_TOKEN_LITERAL);
});
