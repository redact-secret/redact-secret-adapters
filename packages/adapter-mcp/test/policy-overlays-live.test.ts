/**
 * Policy overlays on the MCP boundary through the real core
 * (redact-secret-adapters#215, `docs/policy-overlays.md`): the exact outcome and
 * the exact result a host puts on the wire for a credential, a lower-confidence
 * `warn`, a private key and a benign control, under the default policy, a
 * one-rule override with default fallback, a full callback replacement and a
 * partial callback. A `warn` is an `ok` result that still carries the text; a
 * `block` is the fixed `isError` result with nothing of the input. Synthetic values.
 */

import { describe, expect, test } from "vitest";

import { CORE_HAS_ACTION_POLICY } from "../../../fixtures/action-policy.js";
import {
  OVERLAY_NAMES,
  OVERLAYS,
  type OverlayName,
  PASSWORD_LINE,
  PRIVATE_KEY,
  TOKEN,
} from "../../../fixtures/policy-overlays.js";
import { createMcpBoundary, toCallToolResult } from "../src/index.js";

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
const BLOCKED_WIRE = {
  content: [
    {
      type: "text",
      text: "This MCP tool call was blocked by secret-redaction policy. No content, arguments, or error detail is included.",
    },
  ],
  isError: true,
};
const result = (text: string) => ({ content: [{ type: "text", text }] });
const TOKEN_TEXT = `t ${TOKEN}`;

type Wire = ReturnType<typeof result> | typeof BLOCKED_WIRE;
const BLOCK = "block" as const;
// [input, expected wire result, finding actions] per overlay.
const EXPECTED: Record<
  OverlayName,
  Record<"token" | "password" | "privateKey" | "benign", [Wire | typeof BLOCK, string[]]>
> = {
  default: {
    token: [result("t <SECRET_1>"), ["redact"]],
    password: [result(PASSWORD_LINE), ["warn"]],
    privateKey: [BLOCK, []],
    benign: [result("build ok"), []],
  },
  "rule-token-warn": {
    token: [result(TOKEN_TEXT), ["warn"]],
    password: [result(PASSWORD_LINE), ["warn"]],
    privateKey: [BLOCK, []],
    benign: [result("build ok"), []],
  },
  "rule-password-redact": {
    token: [result("t <SECRET_1>"), ["redact"]],
    password: [result("password=<SECRET_1>"), ["redact"]],
    privateKey: [BLOCK, []],
    benign: [result("build ok"), []],
  },
  "callback-redact-all": {
    token: [result("t <SECRET_1>"), ["redact"]],
    password: [result("password=<SECRET_1>"), ["redact"]],
    privateKey: [result("<SECRET_1>"), ["redact"]],
    benign: [result("build ok"), []],
  },
  "callback-token-only": {
    token: [result("t <SECRET_1>"), ["redact"]],
    password: [result(PASSWORD_LINE), ["allow"]],
    privateKey: [result(PRIVATE_KEY), ["allow"]],
    benign: [result("build ok"), []],
  },
};
const TEXTS = { token: TOKEN_TEXT, password: PASSWORD_LINE, privateKey: PRIVATE_KEY, benign: "build ok" };

describe.skipIf(!CORE_HAS_ACTION_POLICY)("MCP overlays, PII off", () => {
  test("exact outcome and wire result for every overlay and input", async () => {
    for (const name of OVERLAY_NAMES) {
      const boundary = await createMcpBoundary({ ...BASE, ...OVERLAYS[name]() } as never);
      for (const [key, text] of Object.entries(TEXTS) as [keyof typeof TEXTS, string][]) {
        const outcome = boundary.sanitizeToolResult(result(text));
        const [wire, actions] = EXPECTED[name][key];
        const label = `${name} / ${key}`;
        if (wire === BLOCK) {
          // A rejection: no value, no findings, and the wire result is the fixed message.
          expect(outcome, label).toEqual({ outcome: "blocked", reason: "policy" });
          expect(toCallToolResult(outcome), label).toEqual(BLOCKED_WIRE);
          expect(JSON.stringify(toCallToolResult(outcome)), label).not.toContain("PRIVATE KEY");
          continue;
        }
        if (outcome.outcome !== "ok") throw new Error(`${label}: expected ok`);
        expect(outcome.value, label).toEqual(wire);
        expect(
          outcome.findings.map((f) => f.action),
          label,
        ).toEqual(actions);
        expect(toCallToolResult(outcome), label).toEqual(wire);
      }
    }
  });
});
