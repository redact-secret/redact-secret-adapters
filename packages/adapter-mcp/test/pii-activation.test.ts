/**
 * The MCP live factory forwards the PII activation through
 * `adapter-ai-context`, the way it already forwards limits
 * (redact-secret/redact-secret-adapters#51), and keeps its own contract of
 * never rejecting for an initialization failure.
 *
 * Mocked rather than live: `0.1.0-beta.10` is not on the registry, and the
 * core's selection cell is one-shot per process.
 */

import { beforeEach, expect, test, vi } from "vitest";

const core = vi.hoisted(() => ({
  calls: [] as unknown[],
  rejectWith: undefined as (() => Error) | undefined,
  identity: undefined as string | undefined,
}));

vi.mock("@redact-secret/core", async () => {
  const { fakeScanAndRedact } = await import("../../../fixtures/fake-scanner.js");
  const module: Record<string, unknown> = {
    initialize: async (options?: unknown) => {
      core.calls.push(options);
      if (core.rejectWith !== undefined) throw core.rejectWith();
    },
    scanAndRedact: (text: string) => fakeScanAndRedact(text),
    createIncrementalSanitizer: () => {
      throw new Error("must not be reached");
    },
  };
  Object.defineProperty(module, "piiActivation", {
    configurable: true,
    enumerable: true,
    get: () => (core.identity === undefined ? undefined : () => core.identity),
  });
  return module;
});

const { createMcpBoundary, mcpBlockedResult, toCallToolResult } = await import("../src/index.js");

const PII_ON = "credentials=full;selectors=pii:global;families=email;vocabulary=pii-context/v1";
const PII_OFF = "credentials=full;selectors=off;families=;vocabulary=pii-context/v1";
const FAILED_CLOSED = { outcome: "blocked", reason: "core_error" };

function toolResult() {
  return { content: [{ type: "text" as const, text: "token SECRET_TOKEN_1" }] };
}

function conflict(): Error {
  return Object.assign(new Error("a different PII selection is already active"), {
    code: "PII_ACTIVATION_CONFLICT",
  });
}

beforeEach(() => {
  core.calls.length = 0;
  core.rejectWith = undefined;
  core.identity = undefined;
});

test("application first: the conflict is absorbed and the boundary works, not blocks", async () => {
  core.identity = PII_ON;
  core.rejectWith = conflict;
  const mcp = await createMcpBoundary();
  expect(mcp.sanitizeToolResult(toolResult())).toMatchObject({ outcome: "ok" });
  expect(core.calls).toEqual([undefined]);
});

test("adapter first: pii reaches initialize through the AI-context factory", async () => {
  core.identity = PII_ON;
  const mcp = await createMcpBoundary({ pii: ["pii:global"] });
  expect(mcp.sanitizeToolResult(toolResult())).toMatchObject({ outcome: "ok" });
  expect(core.calls).toEqual([{ pii: ["pii:global"] }]);
});

test("pii is forwarded alongside the MCP-only options, not instead of them", async () => {
  core.identity = PII_ON;
  const audits: unknown[] = [];
  const mcp = await createMcpBoundary({ pii: ["pii:global"], binaryContent: "pass", onAudit: (r) => audits.push(r) });
  expect(mcp.sanitizeToolResult(toolResult())).toMatchObject({ outcome: "ok" });
  expect(core.calls).toEqual([{ pii: ["pii:global"] }]);
  expect(audits).toHaveLength(1);
});

test("an activation that does not reflect the request fails every operation closed, and never rejects", async () => {
  core.identity = PII_OFF;
  const mcp = await createMcpBoundary({ pii: ["pii:global"] });
  expect(mcp.sanitizeToolResult(toolResult())).toEqual(FAILED_CLOSED);
  expect(toCallToolResult(mcp.sanitizeToolResult(toolResult()))).toEqual(mcpBlockedResult());
  expect(await mcp.wrapToolHandler(toolResult)({})).toEqual(mcpBlockedResult());
});

test("a core without piiActivation fails closed when pii is passed, and works when it is omitted", async () => {
  expect((await createMcpBoundary({ pii: ["pii:global"] })).sanitizeToolResult(toolResult())).toEqual(FAILED_CLOSED);
  expect(core.calls).toEqual([]);
  expect((await createMcpBoundary()).sanitizeToolResult(toolResult())).toMatchObject({ outcome: "ok" });
  expect(core.calls).toEqual([undefined]);
});
