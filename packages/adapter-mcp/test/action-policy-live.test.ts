/**
 * The declarative `actionPolicy` through the real core at the MCP boundary
 * (redact-secret-adapters#217): the exact outcome and wire result of a tool
 * call for each action, whole-input and streamed, equal to the same action as
 * a callback policy (`action-semantics-live.test.ts`, #214). The option rides
 * the AI-context factory, so there is one snapshot and one capability check.
 * Values are synthetic.
 */

import type { CoreOptionsError } from "@redact-secret/adapter";
import { describe, expect, test } from "vitest";

import {
  actionPolicyForms,
  CORE_HAS_ACTION_POLICY,
  MALFORMED_POLICY,
  UNMATCHED_POLICY,
} from "../../../fixtures/action-policy.js";
import { SYNTHETIC_TOKEN } from "../../../fixtures/action-semantics.js";
import { createMcpBoundary, mcpBlockedResult, toCallToolResult } from "../src/index.js";

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
const result = (text: string) => ({ content: [{ type: "text", text }] });
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

describe.skipIf(!CORE_HAS_ACTION_POLICY)("a core with actionPolicy", () => {
  test.each([
    ["allow", TEXT],
    ["warn", TEXT],
    ["redact", "x <SECRET_1> y"],
    ["default", "x <SECRET_1> y"],
  ] as const)("%s: tool results keep the structure; the wrapped handler and a stream agree", async (action, text) => {
    const forms = actionPolicyForms(action);
    for (const actionPolicy of [forms.object, forms.text, forms.bytes]) {
      const boundary = await createMcpBoundary({ ...BASE, actionPolicy });
      const expectedFinding = finding(action === "default" ? "redact" : action);
      const outcome = boundary.sanitizeToolResult(result(TEXT));
      expect(outcome).toEqual({ outcome: "ok", value: result(text), findings: [expectedFinding] });
      expect(toCallToolResult(outcome)).toEqual(result(text));
      expect(await boundary.wrapToolHandler(async () => result(TEXT))({}, {})).toEqual(result(text));
      expect(await boundary.sanitizeStreamedToolResult(["x ", T, " y"])).toEqual({
        outcome: "ok",
        value: result(text),
        findings: [expectedFinding],
      });
    }
  });

  test("block: blocked / policy, and the wire result is the fixed isError result with nothing of the input", async () => {
    const boundary = await createMcpBoundary({ ...BASE, actionPolicy: actionPolicyForms("block").object });
    const outcome = boundary.sanitizeToolResult(result(TEXT));
    expect(outcome).toEqual({ outcome: "blocked", reason: "policy" });
    expect(toCallToolResult(outcome)).toEqual(mcpBlockedResult());
    expect(await boundary.wrapToolHandler(async () => result(TEXT))({}, {})).toEqual(mcpBlockedResult());
    expect(await boundary.sanitizeStreamedToolResult(["x ", T, " y"])).toEqual({
      outcome: "blocked",
      reason: "policy",
    });
    expect(JSON.stringify(mcpBlockedResult())).not.toContain(T);
  });

  test("a finding no rule matches keeps the default action", async () => {
    const boundary = await createMcpBoundary({ ...BASE, actionPolicy: UNMATCHED_POLICY });
    expect(boundary.sanitizeToolResult(result(TEXT))).toEqual({
      outcome: "ok",
      value: result("x <SECRET_1> y"),
      findings: [finding("redact")],
    });
  });

  test("it is a snapshot, taken when the boundary is created", async () => {
    const object = structuredClone(actionPolicyForms("warn").object);
    const boundary = await createMcpBoundary({ ...BASE, actionPolicy: object });
    (object.rules[0] as { action: string }).action = "block";
    expect(boundary.sanitizeToolResult(result(TEXT))).toMatchObject({ outcome: "ok", value: result(TEXT) });
  });

  test("a malformed policy and a callback conflict reject the live factory, naming nothing of the input", async () => {
    const error = await createMcpBoundary({ ...BASE, actionPolicy: MALFORMED_POLICY }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as CoreOptionsError).coreCode).toBe("INVALID_ACTION_POLICY");
    await expect(
      createMcpBoundary({
        ...BASE,
        policy: { evaluate: () => "redact" },
        actionPolicy: actionPolicyForms("warn").object,
      }),
    ).rejects.toThrow("mutually exclusive");
  });
});

describe.skipIf(CORE_HAS_ACTION_POLICY)("a core older than actionPolicy", () => {
  test("the live factory rejects a requested actionPolicy by name; the callback policy still works", async () => {
    const error = await createMcpBoundary({ ...BASE, actionPolicy: actionPolicyForms("block").object }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as CoreOptionsError).code).toBe("CORE_OPTION_UNSUPPORTED");
    const legacy = await createMcpBoundary({ ...BASE, policy: { evaluate: () => "block" } });
    expect(legacy.sanitizeToolResult(result(TEXT))).toEqual({ outcome: "blocked", reason: "policy" });
  });
});
