/**
 * The aggregate operation budget reaches the MCP boundary through
 * `adapter-ai-context` (redact-secret-adapters#173), on the real installed
 * core: a tool result over the budget is the boundary's fixed
 * `blocked` / `limit_exceeded` outcome, never a partly sanitized result.
 */

import { expect, test } from "vitest";

import { createMcpBoundary, toCallToolResult } from "../src/index.js";

test("operationLimits pass through, and an over-budget tool result carries no value", async () => {
  const mcp = await createMcpBoundary({ operationLimits: { maxLeaves: 1 } });
  const outcome = mcp.sanitizeToolResult({
    content: [
      { type: "text", text: "one" },
      { type: "text", text: "two" },
    ],
  });
  expect(outcome.outcome).toBe("blocked");
  if (outcome.outcome === "blocked") expect(outcome.reason).toBe("limit_exceeded");
  expect(JSON.stringify(toCallToolResult(outcome))).not.toContain("one");
});

test("the defaults leave an ordinary tool result untouched", async () => {
  const mcp = await createMcpBoundary();
  const outcome = mcp.sanitizeToolResult({ content: [{ type: "text", text: "hello" }] });
  expect(outcome.outcome).toBe("ok");
});
