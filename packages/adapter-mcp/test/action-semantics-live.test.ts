/**
 * The policy action truth table for the MCP boundary
 * (redact-secret/redact-secret-adapters#214, `docs/action-semantics.md`): the
 * exact outcome and the exact result a host would put on the wire, for each of
 * allow / warn / redact / block, for a core failure, a tool failure, a limit and
 * a cancelled request, on the real installed core with the legacy callback
 * `policy`. Every expected value is spelled out. A non-ok outcome is asserted to
 * be exactly its fixed shape and its wire result a fixed, input-free message.
 * Values are synthetic and the credential is built at runtime.
 */

import { describe, expect, test } from "vitest";

import { INVALID_POLICY, policyFor, SYNTHETIC_TOKEN, THROWING_POLICY } from "../../../fixtures/action-semantics.js";
import {
  createMcpBoundary,
  type McpAuditRecord,
  type McpBoundary,
  type McpOutcome,
  mcpBlockedResult,
  mcpResourceBlockedError,
  mcpResourceReadError,
  mcpToolErrorResult,
  toCallToolResult,
  toReadResourceResponse,
} from "../src/index.js";

const T = SYNTHETIC_TOKEN;
const TEXT = `x ${T} y`;

const BASE = {
  wholeInputLimits: { maxInputBytes: 4096, maxFindings: 16 },
  incrementalLimits: {
    maxInputCodeUnits: 16384,
    maxBufferedCodeUnits: 2176,
    maxTokenCodeUnits: 1024,
    maxMultilineCodeUnits: 2048,
  },
  traversalLimits: { maxDepth: 6, maxNodes: 64 },
};

const finding = (action: string) => ({
  id: "finding-1",
  type: "github_token",
  detector: "github-token",
  confidence: "high",
  action,
  obfuscation: "none",
  start: 2,
  end: 42,
});

const result = (text: string) => ({ content: [{ type: "text", text }] });

const BLOCKED_WIRE = {
  content: [
    {
      type: "text",
      text: "This MCP tool call was blocked by secret-redaction policy. No content, arguments, or error detail is included.",
    },
  ],
  isError: true,
};
const TOOL_ERROR_WIRE = {
  content: [{ type: "text", text: "This MCP tool call failed. No content, arguments, or error detail is included." }],
  isError: true,
};

function open(options: Record<string, unknown> = {}): Promise<McpBoundary> {
  return createMcpBoundary({ ...BASE, ...options });
}

/** What reaches the wire for a non-ok outcome carries nothing of the input. */
function expectWire(outcome: McpOutcome<unknown>, expected: unknown): void {
  const wire = toCallToolResult(outcome);
  expect(wire).toEqual(expected);
  expect(JSON.stringify(outcome)).not.toContain(T);
  expect(JSON.stringify(wire)).not.toContain(T);
}

describe("tool results: one finding, one policy action", () => {
  test.each([
    // allow and warn: ok, the wire result still carries the credential. Caller responsibility.
    ["allow", TEXT],
    ["warn", TEXT],
    ["redact", "x <SECRET_1> y"],
  ] as const)("%s", async (action, text) => {
    const boundary = await open({ policy: policyFor(action) });
    const outcome = boundary.sanitizeToolResult(result(TEXT));
    expect(outcome).toEqual({ outcome: "ok", value: result(text), findings: [finding(action)] });
    expect(toCallToolResult(outcome)).toEqual(result(text));
  });

  test("block: blocked / policy, and the wire result is the fixed isError result", async () => {
    const boundary = await open({ policy: policyFor("block") });
    const outcome = boundary.sanitizeToolResult(result(TEXT));
    expect(outcome).toEqual({ outcome: "blocked", reason: "policy" });
    expectWire(outcome, BLOCKED_WIRE);
    expect(mcpBlockedResult()).toEqual(BLOCKED_WIRE);
  });

  test("block takes the whole result, not the one content item that matched", async () => {
    const boundary = await open({ policy: policyFor("block") });
    const outcome = boundary.sanitizeToolResult({
      content: [
        { type: "text", text: "clean" },
        { type: "text", text: TEXT },
      ],
    });
    expect(outcome).toEqual({ outcome: "blocked", reason: "policy" });
  });

  test("streamed output: allow and warn release the text, redact masks it, block releases nothing", async () => {
    for (const [action, text] of [
      ["allow", TEXT],
      ["warn", TEXT],
      ["redact", "x <SECRET_1> y"],
    ] as const) {
      const boundary = await open({ policy: policyFor(action) });
      expect(await boundary.sanitizeStreamedToolResult(["x ", T, " y"])).toEqual({
        outcome: "ok",
        value: result(text),
        findings: [finding(action)],
      });
    }
    const block = await open({ policy: policyFor("block") });
    const outcome = await block.sanitizeStreamedToolResult(["x ", T, " y"]);
    expect(outcome).toEqual({ outcome: "blocked", reason: "policy" });
    expectWire(outcome, BLOCKED_WIRE);
  });

  test("a wrapped server handler returns the sanitized result or the fixed isError result", async () => {
    for (const [action, wire] of [
      ["warn", result(TEXT)],
      ["redact", result("x <SECRET_1> y")],
      ["block", BLOCKED_WIRE],
    ] as const) {
      const boundary = await open({ policy: policyFor(action) });
      const handler = boundary.wrapToolHandler(async () => result(TEXT));
      expect(await handler({}, {})).toEqual(wire);
    }
  });
});

describe("resources/read: the wire result is { result } or a fixed JSON-RPC error", () => {
  const contents = { contents: [{ uri: "file:///a", text: TEXT }] };

  test.each([
    ["allow", TEXT],
    ["warn", TEXT],
    ["redact", "x <SECRET_1> y"],
  ] as const)("%s", async (action, text) => {
    const boundary = await open({ policy: policyFor(action) });
    const outcome = boundary.sanitizeResourceResult(contents);
    expect(outcome).toEqual({
      outcome: "ok",
      value: { contents: [{ uri: "file:///a", text }] },
      findings: [finding(action)],
    });
    expect(toReadResourceResponse(outcome)).toEqual({ result: { contents: [{ uri: "file:///a", text }] } });
  });

  test("block, and a failed read, are fixed errors that name neither the URI nor the content", async () => {
    const boundary = await open({ policy: policyFor("block") });
    const blocked = boundary.sanitizeResourceResult(contents);
    expect(blocked).toEqual({ outcome: "blocked", reason: "policy" });
    expect(toReadResourceResponse(blocked)).toEqual({ error: mcpResourceBlockedError() });
    expect(mcpResourceBlockedError()).toEqual({
      code: -32603,
      message:
        "This MCP resource read was blocked by secret-redaction policy. No content, URI, or error detail is included.",
    });
    const failed = await boundary.sanitizeResourceRead(() => {
      throw new Error(`read failed ${T}`);
    });
    expect(failed).toEqual({ outcome: "read_error" });
    expect(toReadResourceResponse(failed)).toEqual({ error: mcpResourceReadError() });
    expect(JSON.stringify(toReadResourceResponse(failed))).not.toContain(T);
  });
});

describe("failure, tool errors, limits and cancellation: fixed and input-free", () => {
  test.each([
    ["a throwing policy", THROWING_POLICY, "POLICY_FAILURE"],
    ["a policy that returns a non-action", INVALID_POLICY, "INVALID_POLICY_ACTION"],
  ] as const)(
    "%s is blocked / core_error with the core's fixed code, and the blocked wire result",
    async (_name, policy, code) => {
      const boundary = await open({ policy });
      const outcome = boundary.sanitizeToolResult(result(TEXT));
      expect(outcome).toEqual({ outcome: "blocked", reason: "core_error", code });
      expectWire(outcome, BLOCKED_WIRE);
    },
  );

  test("a tool that throws is tool_error and a different fixed result; its error is never read", async () => {
    const boundary = await open();
    const outcome = await boundary.sanitizeToolCall(() => {
      throw new Error(`tool failed ${T}`);
    });
    expect(outcome).toEqual({ outcome: "tool_error" });
    expectWire(outcome, TOOL_ERROR_WIRE);
    expect(mcpToolErrorResult()).toEqual(TOOL_ERROR_WIRE);
    const handler = boundary.wrapToolHandler(async () => {
      throw new Error(`handler failed ${T}`);
    });
    expect(await handler({}, {})).toEqual(TOOL_ERROR_WIRE);
  });

  test("a malformed or unsupported shape blocks as unsupported_value, so a later revision fails closed", async () => {
    const boundary = await open();
    expectWire(boundary.sanitizeToolResult({ content: [{ type: "weird", text: T }] }), BLOCKED_WIRE);
    expect(boundary.sanitizeToolResult({ content: [{ type: "weird" }] })).toEqual({
      outcome: "blocked",
      reason: "unsupported_value",
    });
    // A base64 payload cannot be scanned: blocked by default.
    expect(boundary.sanitizeToolResult({ content: [{ type: "image", data: "AAAA", mimeType: "image/png" }] })).toEqual({
      outcome: "blocked",
      reason: "unsupported_value",
    });
  });

  test("limits are blocked / limit_exceeded and the blocked wire result", async () => {
    const bytes = await open({ wholeInputLimits: { maxInputBytes: 16, maxFindings: 16 } });
    const outcome = bytes.sanitizeToolResult(result(TEXT));
    expect(outcome).toEqual({ outcome: "blocked", reason: "limit_exceeded", code: "INPUT_LIMIT_EXCEEDED" });
    expectWire(outcome, BLOCKED_WIRE);
    const depth = await open({ traversalLimits: { maxDepth: 2, maxNodes: 64 } });
    expect(depth.sanitizeToolResult(result(TEXT))).toEqual({ outcome: "blocked", reason: "limit_exceeded" });
    const stream = await open({
      incrementalLimits: { ...BASE.incrementalLimits, maxInputCodeUnits: 3000 },
    });
    const streamed = await stream.sanitizeStreamedToolResult(["a ".repeat(1600), T]);
    expect(streamed).toEqual({ outcome: "blocked", reason: "limit_exceeded", code: "INPUT_LIMIT_EXCEEDED" });
    expectWire(streamed, BLOCKED_WIRE);
  });

  test("a cancelled request is aborted and delivers nothing at all", async () => {
    const boundary = await open();
    const controller = new AbortController();
    controller.abort();
    const outcome = boundary.sanitizeToolResult(result(TEXT), { signal: controller.signal });
    expect(outcome).toEqual({ outcome: "aborted" });
    expect(toCallToolResult(outcome)).toBeNull();
  });
});

describe("observation mode and the audit record", () => {
  test("warn everywhere: the result is unchanged, onFinding sees the finding, and the audit record cannot tell", async () => {
    const audits: McpAuditRecord[] = [];
    const actions: string[] = [];
    const boundary = await open({
      policy: policyFor("warn"),
      onAudit: (record: McpAuditRecord) => audits.push(record),
      onFinding: (found: { action: string }) => actions.push(found.action),
    });
    const outcome = boundary.sanitizeToolResult(result(TEXT));
    expect(outcome).toMatchObject({ outcome: "ok", value: result(TEXT) });
    expect(actions).toEqual(["warn"]);
    // The audit record is input-free by design and says only "ok": a caller that must know a
    // credential was left in the result reads `outcome.findings`, not the audit record.
    expect(audits).toEqual([{ stage: "result", outcome: "ok" }]);
  });
});
