/**
 * The MCP boundary forwards the AI-context occurrences of the findings it
 * carries unchanged (redact-secret-adapters#177), on the real core.
 */

import { findingOccurrences } from "@redact-secret/adapter-ai-context";
import { expect, test } from "vitest";

import { createMcpBoundary } from "../src/index.js";

const TOKEN = `ghp_${"x".repeat(36)}`;

test("an MCP tool result's findings have occurrences at the same indexes, and the outcome JSON is unchanged", async () => {
  const mcp = await createMcpBoundary();
  const outcome = mcp.sanitizeToolResult({
    content: [
      { type: "text", text: `first ${TOKEN}` },
      { type: "text", text: `second ${TOKEN}` },
    ],
  });
  if (outcome.outcome !== "ok") throw new Error("expected ok");
  const occurrences = findingOccurrences(outcome);
  expect(occurrences).toHaveLength(outcome.findings.length);
  expect(outcome.findings.length).toBeGreaterThanOrEqual(2);
  expect(new Set((occurrences ?? []).map((occurrence) => JSON.stringify(occurrence))).size).toBe(
    outcome.findings.length,
  );
  expect(JSON.stringify(outcome)).not.toContain("rangeScope");
});
