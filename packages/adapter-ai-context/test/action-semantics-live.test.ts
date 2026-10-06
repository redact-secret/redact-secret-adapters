/**
 * The policy action truth table for the AI-context boundary
 * (redact-secret/redact-secret-adapters#214, `docs/action-semantics.md`): the
 * exact outcome of every operation for each of allow / warn / redact / block, for
 * a core failure, for every limit, for the stream lifecycle, and for object keys,
 * on the real installed core with the legacy callback `policy`. Every expected
 * outcome is spelled out. A non-ok outcome is asserted to be exactly its fixed
 * shape: no value, no findings, nothing derived from the input. Values are
 * synthetic and the credential is built at runtime.
 */

import { beforeAll, describe, expect, test } from "vitest";

import {
  INVALID_POLICY,
  policyFor,
  SYNTHETIC_CONTEXTUAL_VALUE,
  SYNTHETIC_TOKEN,
  THROWING_POLICY,
} from "../../../fixtures/action-semantics.js";
import {
  type AiContextBoundary,
  type AiContextBoundaryOptions,
  type AiContextOutcome,
  createAiContextBoundary,
  type FindingOccurrence,
  type SafeFinding,
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
  traversalLimits: { maxDepth: 4, maxNodes: 64 },
} satisfies AiContextBoundaryOptions;

const finding = (action: string, start = 2, end = 42) => ({
  id: "finding-1",
  type: "github_token",
  detector: "github-token",
  confidence: "high",
  action,
  obfuscation: "none",
  start,
  end,
});

const BLOCKED_POLICY = { outcome: "blocked", reason: "policy" } as const;

function open(options: Partial<AiContextBoundaryOptions> = {}): Promise<AiContextBoundary> {
  return createAiContextBoundary({ ...BASE, ...options });
}

/** A non-ok outcome is exactly a fixed shape, and nothing about the input is anywhere in it. */
function expectFixedNonOk(outcome: AiContextOutcome<unknown>, expected: object): void {
  expect(outcome).toEqual(expected);
  expect(Object.keys(outcome).sort()).toEqual(Object.keys(expected).sort());
  expect(JSON.stringify(outcome)).not.toContain(T);
}

describe("every operation: one finding, one policy action", () => {
  test.each([
    // allow and warn: ok, the value still carries the credential, the finding carries the action. Caller responsibility.
    ["allow", TEXT, finding("allow")],
    ["warn", TEXT, finding("warn")],
    ["redact", "x <SECRET_1> y", finding("redact")],
  ] as const)("%s: sanitizeText is ok with the finding's action", async (action, value, expectedFinding) => {
    const boundary = await open({ policy: policyFor(action) });
    expect(boundary.sanitizeText(TEXT)).toEqual({ outcome: "ok", value, findings: [expectedFinding] });
  });

  test("block: every operation is blocked / policy with no value", async () => {
    const boundary = await open({ policy: policyFor("block") });
    expectFixedNonOk(boundary.sanitizeText(TEXT), BLOCKED_POLICY);
    expectFixedNonOk(boundary.sanitizeValue({ a: TEXT, b: "clean" }), BLOCKED_POLICY);
    expectFixedNonOk(boundary.sanitizeToolResult(TEXT), BLOCKED_POLICY);
    expectFixedNonOk(boundary.sanitizeToolResult({ a: TEXT }), BLOCKED_POLICY);
    expectFixedNonOk(
      boundary.buildContext([
        { role: "user", text: "clean" },
        { role: "tool", value: { a: TEXT } },
      ]),
      BLOCKED_POLICY,
    );
    const stream = boundary.openStream();
    stream.append(`${TEXT} `);
    expectFixedNonOk(stream.finalize(), BLOCKED_POLICY);
    expect(stream.accepting).toBe(false);
  });

  test.each([
    ["allow", TEXT],
    ["warn", TEXT],
    ["redact", "x <SECRET_1> y"],
  ] as const)("%s: sanitizeValue, sanitizeToolResult and buildContext keep the structure", async (action, leaf) => {
    const boundary = await open({ policy: policyFor(action) });
    const findings = [finding(action)];
    expect(boundary.sanitizeValue({ a: TEXT, n: 1, ok: true, none: null, clean: "plain" })).toEqual({
      outcome: "ok",
      value: { a: leaf, n: 1, ok: true, none: null, clean: "plain" },
      findings,
    });
    expect(boundary.sanitizeToolResult({ a: TEXT })).toEqual({ outcome: "ok", value: { a: leaf }, findings });
    expect(boundary.sanitizeToolResult(TEXT)).toEqual({ outcome: "ok", value: leaf, findings });
    expect(
      boundary.buildContext([
        { role: "user", text: "clean" },
        { role: "tool", value: { a: TEXT } },
      ]),
    ).toEqual({
      outcome: "ok",
      value: [
        { role: "user", content: "clean" },
        { role: "tool", content: { a: leaf } },
      ],
      findings,
    });
  });

  test.each([
    ["allow", TEXT],
    ["warn", TEXT],
    ["redact", "x <SECRET_1> y"],
  ] as const)("%s: a stream releases the staged text once, at finalize", async (action, value) => {
    const boundary = await open({ policy: policyFor(action) });
    const stream = boundary.openStream();
    stream.append(`x ${T.slice(0, 10)}`);
    stream.append(`${T.slice(10)} y`);
    const outcome = stream.finalize();
    expect(outcome).toEqual({ outcome: "ok", value, findings: [finding(action)] });
    expect(stream.accepting).toBe(false);
  });
});

describe("failure is blocked / core_error with a fixed code and no value", () => {
  test.each([
    ["a throwing policy", THROWING_POLICY, "POLICY_FAILURE"],
    ["a policy that returns a non-action", INVALID_POLICY, "INVALID_POLICY_ACTION"],
  ] as const)("%s", async (_name, policy, code) => {
    const boundary = await open({ policy });
    const failure = { outcome: "blocked", reason: "core_error", code } as const;
    expectFixedNonOk(boundary.sanitizeText(TEXT), failure);
    expectFixedNonOk(boundary.sanitizeValue({ a: TEXT }), failure);
    const stream = boundary.openStream();
    stream.append(TEXT);
    expectFixedNonOk(stream.finalize(), failure);
  });

  test("a value the boundary cannot represent is blocked / unsupported_value", async () => {
    const boundary = await open();
    const unsupported = { outcome: "blocked", reason: "unsupported_value" } as const;
    expectFixedNonOk(boundary.sanitizeValue({ a: () => 1 }), unsupported);
    expectFixedNonOk(boundary.sanitizeValue({ a: undefined }), unsupported);
    expectFixedNonOk(boundary.sanitizeValue({ a: 1n, b: TEXT }), unsupported);
    const cyclic: Record<string, unknown> = { token: TEXT };
    cyclic.self = cyclic;
    expectFixedNonOk(boundary.sanitizeValue(cyclic), unsupported);
  });
});

describe("limits: blocked / limit_exceeded, nothing partly approved", () => {
  const LIMIT = { outcome: "blocked", reason: "limit_exceeded" } as const;

  test("wholeInputLimits come from the core and carry its fixed code", async () => {
    const bytes = await open({ wholeInputLimits: { maxInputBytes: 16, maxFindings: 16 } });
    expectFixedNonOk(bytes.sanitizeText(TEXT), { ...LIMIT, code: "INPUT_LIMIT_EXCEEDED" });
    const findings = await open({ wholeInputLimits: { maxInputBytes: 4096, maxFindings: 1 } });
    expectFixedNonOk(findings.sanitizeText(`${T} ${T}`), { ...LIMIT, code: "FINDING_LIMIT_EXCEEDED" });
  });

  test("traversalLimits are the boundary's own and carry no code", async () => {
    const depth = await open({ traversalLimits: { maxDepth: 2, maxNodes: 64 } });
    expectFixedNonOk(depth.sanitizeValue({ a: { b: { c: T } } }), LIMIT);
    const nodes = await open({ traversalLimits: { maxDepth: 4, maxNodes: 3 } });
    expectFixedNonOk(nodes.sanitizeValue({ a: "1", b: "2", c: T }), LIMIT);
  });

  test("the per-operation budget blocks the whole context, including parts already scanned", async () => {
    const boundary = await open({ operationLimits: { maxScans: 1 } });
    expectFixedNonOk(
      boundary.buildContext([
        { role: "user", text: "first" },
        { role: "user", text: `second ${T}` },
      ]),
      LIMIT,
    );
  });

  test("incrementalLimits stop a stream: it stops accepting and finalize is the fixed outcome", async () => {
    const boundary = await open({ incrementalLimits: { ...BASE.incrementalLimits, maxInputCodeUnits: 3000 } });
    const stream = boundary.openStream();
    stream.append("a ".repeat(1600));
    expect(stream.accepting).toBe(false);
    stream.append(`${T} more`);
    expectFixedNonOk(stream.finalize(), { ...LIMIT, code: "INPUT_LIMIT_EXCEEDED" });
  });
});

describe("stream lifecycle: append, finalize, abort", () => {
  test("finalize releases at most once; a second finalize is blocked / lifecycle", async () => {
    const boundary = await open();
    const stream = boundary.openStream();
    stream.append(`x ${T}`);
    expect(stream.accepting).toBe(true);
    expect(stream.finalize()).toEqual({ outcome: "ok", value: "x <SECRET_1>", findings: [finding("redact")] });
    expectFixedNonOk(stream.finalize(), { outcome: "blocked", reason: "lifecycle" });
    stream.append(T);
    stream.abort();
    expectFixedNonOk(stream.finalize(), { outcome: "blocked", reason: "lifecycle" });
  });

  test("abort discards what was staged: the next finalize is aborted, then lifecycle", async () => {
    const boundary = await open();
    const stream = boundary.openStream();
    stream.append(`x ${T}`);
    stream.abort();
    expect(stream.accepting).toBe(false);
    expectFixedNonOk(stream.finalize(), { outcome: "aborted" });
    expectFixedNonOk(stream.finalize(), { outcome: "blocked", reason: "lifecycle" });
  });

  test("nothing is released before finalize, and a block at the end releases nothing of what was appended", async () => {
    const boundary = await open({ policy: policyFor("block") });
    const stream = boundary.openStream();
    stream.append("clean text before ");
    stream.append(`${T} and clean text after`);
    expectFixedNonOk(stream.finalize(), BLOCKED_POLICY);
  });

  test("a cancelled signal is aborted for every operation, before anything is scanned", async () => {
    const boundary = await open();
    const controller = new AbortController();
    controller.abort();
    const options = { signal: controller.signal };
    expectFixedNonOk(boundary.sanitizeText(TEXT, options), { outcome: "aborted" });
    expectFixedNonOk(boundary.sanitizeValue({ a: TEXT }, options), { outcome: "aborted" });
    expectFixedNonOk(boundary.buildContext([{ role: "user", text: TEXT }], options), { outcome: "aborted" });
  });
});

describe("object keys: all or nothing", () => {
  test("a credential in a key that would be redacted blocks the whole value, never a rewritten key", async () => {
    const boundary = await open();
    expectFixedNonOk(boundary.sanitizeValue({ [T]: "value", clean: "plain" }), BLOCKED_POLICY);
    expectFixedNonOk(boundary.sanitizeValue({ [`key ${T}`]: "value" }), BLOCKED_POLICY);
    const redact = await open({ policy: policyFor("redact") });
    expectFixedNonOk(redact.sanitizeValue({ [T]: "value" }), BLOCKED_POLICY);
  });

  test("warn and allow leave the key in the output (caller responsibility) and ok.findings does not carry it", async () => {
    for (const action of ["warn", "allow"] as const) {
      const boundary = await open({ policy: policyFor(action) });
      expect(boundary.sanitizeValue({ [T]: "value" })).toEqual({
        outcome: "ok",
        value: { [T]: "value" },
        findings: [],
      });
    }
  });

  test("a key is context for its leaf: the leaf is redacted in place, the key is kept", async () => {
    const boundary = await open();
    expect(boundary.sanitizeValue({ api_key: SYNTHETIC_CONTEXTUAL_VALUE })).toMatchObject({
      outcome: "ok",
      value: { api_key: "<SECRET_1>" },
    });
    const block = await open({ policy: policyFor("block") });
    expectFixedNonOk(block.sanitizeValue({ api_key: SYNTHETIC_CONTEXTUAL_VALUE }), BLOCKED_POLICY);
    const warn = await open({ policy: policyFor("warn") });
    expect(warn.sanitizeValue({ api_key: SYNTHETIC_CONTEXTUAL_VALUE })).toMatchObject({
      outcome: "ok",
      value: { api_key: SYNTHETIC_CONTEXTUAL_VALUE },
    });
  });
});

describe("observation mode: warn everywhere plus onFinding", () => {
  let events: { finding: SafeFinding; occurrence: FindingOccurrence }[];
  let boundary: AiContextBoundary;

  beforeAll(async () => {
    events = [];
    boundary = await open({
      policy: policyFor("warn"),
      onFinding: (found, _context, occurrence) => events.push({ finding: found, occurrence }),
    });
  });

  test("onFinding sees every finding, key scans included; the value is returned unchanged", () => {
    const input = { [T]: "v", a: TEXT };
    expect(boundary.sanitizeValue(input)).toEqual({ outcome: "ok", value: input, findings: [finding("warn")] });
    expect(events.map((event) => [event.finding.action, event.occurrence.rangeScope])).toEqual([
      ["warn", "key"],
      ["warn", "leaf"],
    ]);
    expect(JSON.stringify(events)).not.toContain(T);
  });
});
