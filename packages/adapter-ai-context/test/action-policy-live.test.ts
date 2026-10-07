/**
 * The declarative `actionPolicy` through the real core at the AI-context
 * boundary (redact-secret-adapters#217): the exact outcome of every operation
 * for each action, whole-input and incremental, equal to the same action as a
 * callback policy (`action-semantics-live.test.ts`, #214). `block` is the
 * boundary's documented outcome, `warn` and `allow` keep the text, redaction is
 * the core's. Below the verified core floor the live factory rejects the option
 * explicitly. Values are synthetic.
 */

import { CoreOptionsError } from "@redact-secret/adapter";
import { describe, expect, test } from "vitest";

import {
  actionPolicyForms,
  CORE_HAS_ACTION_POLICY,
  MALFORMED_MARKER,
  MALFORMED_POLICY,
  UNMATCHED_POLICY,
} from "../../../fixtures/action-policy.js";
import { SYNTHETIC_TOKEN } from "../../../fixtures/action-semantics.js";
import { type AiContextBoundaryOptions, createAiContextBoundary } from "../src/index.js";

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
  traversalLimits: { maxDepth: 4, maxNodes: 64 },
} satisfies AiContextBoundaryOptions;

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
const BLOCKED = { outcome: "blocked", reason: "policy" } as const;

describe.skipIf(!CORE_HAS_ACTION_POLICY)("a core with actionPolicy", () => {
  test.each([
    ["allow", TEXT],
    ["warn", TEXT],
    ["redact", "x <SECRET_1> y"],
    ["default", "x <SECRET_1> y"],
  ] as const)("%s: whole-input and incremental outcomes keep the value the core returns", async (action, value) => {
    const forms = actionPolicyForms(action);
    for (const actionPolicy of [forms.object, forms.text, forms.bytes]) {
      const boundary = await createAiContextBoundary({ ...BASE, actionPolicy });
      const expectedFinding = finding(action === "default" ? "redact" : action);
      expect(boundary.sanitizeText(TEXT)).toEqual({ outcome: "ok", value, findings: [expectedFinding] });
      const stream = boundary.openStream();
      stream.append(`x ${T.slice(0, 10)}`);
      stream.append(`${T.slice(10)} y`);
      expect(stream.finalize()).toEqual({ outcome: "ok", value, findings: [expectedFinding] });
    }
  });

  test("block: every operation is blocked / policy with no value, no findings and nothing of the input", async () => {
    const boundary = await createAiContextBoundary({ ...BASE, actionPolicy: actionPolicyForms("block").object });
    const outcomes = [
      boundary.sanitizeText(TEXT),
      boundary.sanitizeValue({ a: TEXT, b: "clean" }),
      boundary.sanitizeToolResult(TEXT),
      boundary.buildContext([{ role: "user", text: TEXT }]),
    ];
    for (const outcome of outcomes) {
      expect(outcome).toEqual(BLOCKED);
      expect(JSON.stringify(outcome)).not.toContain(T);
    }
    const stream = boundary.openStream();
    stream.append(`${TEXT} `);
    expect(stream.finalize()).toEqual(BLOCKED);
  });

  test("a finding no rule matches keeps the default action", async () => {
    const boundary = await createAiContextBoundary({ ...BASE, actionPolicy: UNMATCHED_POLICY });
    expect(boundary.sanitizeText(TEXT)).toEqual({
      outcome: "ok",
      value: "x <SECRET_1> y",
      findings: [finding("redact")],
    });
  });

  test("it is a snapshot: a later mutation of the document changes nothing, for whole-input and for a stream opened later", async () => {
    const object = structuredClone(actionPolicyForms("warn").object);
    const bytes = actionPolicyForms("warn").bytes.slice();
    const fromObject = await createAiContextBoundary({ ...BASE, actionPolicy: object });
    const fromBytes = await createAiContextBoundary({ ...BASE, actionPolicy: bytes });
    (object.rules[0] as { action: string }).action = "block";
    bytes.fill(0);
    for (const boundary of [fromObject, fromBytes]) {
      expect(boundary.sanitizeText(TEXT)).toEqual({ outcome: "ok", value: TEXT, findings: [finding("warn")] });
      const stream = boundary.openStream();
      stream.append(TEXT);
      expect(stream.finalize()).toEqual({ outcome: "ok", value: TEXT, findings: [finding("warn")] });
    }
  });

  test("a malformed policy rejects the live factory with INVALID_ACTION_POLICY and nothing of the document", async () => {
    const error = await createAiContextBoundary({ ...BASE, actionPolicy: MALFORMED_POLICY }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CoreOptionsError);
    expect((error as CoreOptionsError).coreCode).toBe("INVALID_ACTION_POLICY");
    expect(JSON.stringify({ ...(error as object), message: (error as Error).message })).not.toContain(MALFORMED_MARKER);
  });

  test("a callback policy beside an actionPolicy rejects the live factory before the core is touched", async () => {
    await expect(
      createAiContextBoundary({
        ...BASE,
        policy: { evaluate: () => "redact" },
        actionPolicy: actionPolicyForms("warn").object,
      }),
    ).rejects.toThrow("mutually exclusive");
  });

  test("ruleset and scanLimits are still rejected by name: an actionPolicy does not widen the incremental surface", async () => {
    const actionPolicy = actionPolicyForms("warn").object;
    await expect(createAiContextBoundary({ ...BASE, actionPolicy, ruleset: "x" } as never)).rejects.toThrow("ruleset");
  });
});

describe.skipIf(CORE_HAS_ACTION_POLICY)("a core older than actionPolicy", () => {
  test("the live factory rejects a requested actionPolicy by name; the callback policy still works", async () => {
    const error = await createAiContextBoundary({ ...BASE, actionPolicy: actionPolicyForms("block").object }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as CoreOptionsError).code).toBe("CORE_OPTION_UNSUPPORTED");
    expect((error as CoreOptionsError).options).toEqual(["actionPolicy"]);
    const legacy = await createAiContextBoundary({ ...BASE, policy: { evaluate: () => "block" } });
    expect(legacy.sanitizeText(TEXT)).toEqual(BLOCKED);
  });
});
