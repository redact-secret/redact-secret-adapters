/**
 * Per-crossing scan memoization (#107) at the MCP boundary: the envelope
 * strings every content block repeats (`content`, `type`, `text`, and the
 * key-context check's `{"type":"text"}`) reach the scanner once per result.
 * Every value is synthetic.
 */

import { createAiContextBoundaryWith } from "@redact-secret/adapter-ai-context";
import { describe, expect, test } from "vitest";

import { createFakeCore, LIMITS } from "../../adapter-ai-context/test/fake-core.js";
import { createMcpBoundaryWith } from "../src/index.js";

const SECRET = "SECRET_TOKEN_7";

function setup() {
  const fake = createFakeCore();
  const events: unknown[] = [];
  const ai = createAiContextBoundaryWith(fake.core, {
    ...LIMITS,
    traversalLimits: { maxDepth: 6, maxNodes: 500 },
    onFinding: (finding) => events.push(finding),
  });
  return { mcp: createMcpBoundaryWith(ai), events, calls: fake.calls };
}

const result = (n: number) => ({
  content: Array.from({ length: n }, (_, i) => ({ type: "text", text: `entry ${i} ${SECRET}` })),
});

describe("per-crossing scan memoization", () => {
  test("an extra block costs its own leaf and key view, not its envelope", () => {
    const one = setup();
    const eight = setup();
    one.mcp.sanitizeToolResult(result(1));
    eight.mcp.sanitizeToolResult(result(8));
    // leaf + leaf key-view per block; the SECRET redaction also re-checks nothing else.
    expect((eight.calls.scans.length - one.calls.scans.length) / 7).toBeLessThanOrEqual(2);
  });

  test("clean blocks repeat nothing at all beyond distinct texts", () => {
    const { mcp, calls } = setup();
    mcp.sanitizeToolResult({ content: Array.from({ length: 16 }, () => ({ type: "text", text: "plain" })) });
    expect(calls.scans.length).toBeLessThanOrEqual(new Set(calls.scans).size + 1);
  });

  test("output equals the per-block results and onFinding fires per occurrence", () => {
    const many = setup();
    const outcome = many.mcp.sanitizeToolResult(result(5));
    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.findings).toHaveLength(5);
    expect(many.events).toHaveLength(5);
    (outcome.value.content as unknown[]).forEach((block, i) => {
      const solo = setup().mcp.sanitizeToolResult(result(i + 1));
      expect(solo.outcome === "ok" && (solo.value.content as unknown[])[i]).toEqual(block);
    });
  });
});
