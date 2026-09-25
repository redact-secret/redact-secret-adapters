/**
 * The live factory when the core cannot be initialized: it does not reject,
 * and every operation fails closed to the fixed blocked result, never
 * falling back to returning input.
 */

import { expect, test, vi } from "vitest";

vi.mock("@redact-secret/core", () => ({
  initialize: () =>
    Promise.reject(Object.assign(new Error("artifact missing near SECRET_TOKEN_1"), { code: "INITIALIZATION_FAILED" })),
  scanAndRedact: () => {
    throw new Error("must not be reached");
  },
  createIncrementalSanitizer: () => {
    throw new Error("must not be reached");
  },
}));

const { createMcpBoundary, mcpBlockedResult, toCallToolResult } = await import("../src/index.js");

const LIMITS = {
  wholeInputLimits: { maxInputBytes: 256, maxFindings: 4 },
  incrementalLimits: {
    maxInputCodeUnits: 256,
    maxBufferedCodeUnits: 192,
    maxTokenCodeUnits: 64,
    maxMultilineCodeUnits: 64,
  },
  traversalLimits: { maxDepth: 3, maxNodes: 16 },
};
const FAILED = { outcome: "blocked", reason: "core_error", code: "INITIALIZATION_FAILED" };

test("an initialization failure fails every operation closed to the fixed blocked result", async () => {
  const mcp = await createMcpBoundary(LIMITS);
  const result = { content: [{ type: "text", text: "SECRET_TOKEN_1" }] };
  expect(mcp.sanitizeToolResult(result)).toEqual(FAILED);
  expect(mcp.sanitizeToolArguments({ q: "SECRET_TOKEN_1" })).toEqual(FAILED);
  expect(await mcp.sanitizeToolCall(() => result)).toEqual(FAILED);
  expect(await mcp.sanitizeStreamedToolResult(["SECRET_TOKEN_1"])).toEqual(FAILED);
  expect(toCallToolResult(mcp.sanitizeToolResult(result))).toEqual(mcpBlockedResult());
  expect(await mcp.wrapToolHandler(() => result)({})).toEqual(mcpBlockedResult());
});

test("malformed options still reject, with a fixed message", async () => {
  await expect(createMcpBoundary({ ...LIMITS, binaryContent: "scan" } as never)).rejects.toThrow(TypeError);
  await expect(createMcpBoundary(null as never)).rejects.toThrow(TypeError);
});
