/**
 * The MCP boundary's documented default limits
 * (redact-secret/redact-secret-adapters#46), on the **real installed core**: a
 * caller starts with `createMcpBoundary()` and a checked `ok`, overrides still
 * work, `binaryContent`/`onAudit` still compose with the defaults, and the
 * block and abort paths are unchanged.
 *
 * Tokens are synthetic and built at runtime.
 */

import { AI_CONTEXT_DEFAULT_LIMITS } from "@redact-secret/adapter-ai-context";
import { expect, test } from "vitest";

import { createMcpBoundary, MCP_BLOCKED_TEXT, mcpBlockedResult, toCallToolResult } from "../src/index.js";

const TOKEN = `ghp_${"SYNTHETICREVOKED"}${"0".repeat(20)}`;

test("a boundary with no options sanitizes a tool result and reports ok", async () => {
  const mcp = await createMcpBoundary();
  const outcome = mcp.sanitizeToolResult({
    content: [{ type: "text", text: `deploy ok\nAPI_KEY=${TOKEN}` }],
    structuredContent: { env: [`API_KEY=${TOKEN}`] },
  });

  expect(outcome.outcome).toBe("ok");
  const safe = toCallToolResult(outcome);
  expect(JSON.stringify(safe)).not.toContain(TOKEN);
  expect(JSON.stringify(safe)).toMatch(/<SECRET_\d+>/);
});

test("an omitted limit set is the documented preset, not an unbounded mode", async () => {
  const mcp = await createMcpBoundary();
  const tooLong = "a".repeat(AI_CONTEXT_DEFAULT_LIMITS.wholeInputLimits.maxInputBytes + 1);
  const outcome = mcp.sanitizeToolResult({ content: [{ type: "text", text: tooLong }] });

  expect(outcome.outcome).toBe("blocked");
  if (outcome.outcome === "blocked") expect(outcome.reason).toBe("limit_exceeded");
});

test("an explicit limit override still applies", async () => {
  const mcp = await createMcpBoundary({ wholeInputLimits: { maxInputBytes: 16, maxFindings: 2 } });
  const outcome = mcp.sanitizeToolResult({ content: [{ type: "text", text: "a".repeat(64) }] });

  expect(outcome.outcome).toBe("blocked");
});

test("binaryContent and onAudit still compose with the default limits", async () => {
  const audits: { stage: string; outcome: string }[] = [];
  const mcp = await createMcpBoundary({
    binaryContent: "block",
    onAudit: (record) => audits.push({ stage: record.stage, outcome: record.outcome }),
  });
  const outcome = mcp.sanitizeToolResult({
    content: [{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }],
  });

  // The default: a payload that cannot be scanned blocks the whole result.
  expect(outcome.outcome).toBe("blocked");
  if (outcome.outcome === "blocked") expect(outcome.reason).toBe("unsupported_value");
  expect(toCallToolResult(outcome)).toEqual(mcpBlockedResult());
  expect(JSON.stringify(mcpBlockedResult())).toContain(MCP_BLOCKED_TEXT);
  expect(audits).toEqual([{ stage: "result", outcome: "blocked" }]);
});

test("an unsupported value shape blocks, and a cancelled call aborts, under the defaults", async () => {
  const mcp = await createMcpBoundary();
  // A content type no protocol revision this package qualifies against defines.
  expect(mcp.sanitizeToolResult({ content: [{ type: "video", url: "x" }] }).outcome).toBe("blocked");

  const aborted = await mcp.sanitizeToolCall(() => ({ content: [{ type: "text", text: "unused" }] }), {
    signal: { aborted: true },
  });
  expect(aborted).toEqual({ outcome: "aborted" });
  expect(toCallToolResult(aborted)).toBeNull();
});

test("options that are not an object are still a TypeError", async () => {
  await expect(createMcpBoundary(null as unknown as undefined)).rejects.toThrow(TypeError);
});
