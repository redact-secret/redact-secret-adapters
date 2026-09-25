/**
 * End to end, on the real installed core through the live factory
 * `createAiContextBoundary`: one agent turn across every boundary (user
 * input, tool result, nested value, constructed context, streamed tool
 * output), and every configured limit failing closed on the real core.
 * Tokens are synthetic and built at runtime; the PEM body is the core's own
 * synthetic conformance body.
 */

import { beforeAll, describe, expect, test } from "vitest";

import {
  type AiContextBoundary,
  type AiContextBoundaryOptions,
  type AiContextOutcome,
  createAiContextBoundary,
  type SafeFinding,
} from "../src/index.js";

const TOKEN = `ghp_${"SYNTHETICREVOKED"}${"0".repeat(20)}`;
const PEM_BODY = "U1lOVEhFVElDX1JFVk9LRURfQ09ORk9STUFOQ0U=";
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`;

const OPTIONS = {
  wholeInputLimits: { maxInputBytes: 4096, maxFindings: 16 },
  incrementalLimits: {
    maxInputCodeUnits: 16384,
    maxBufferedCodeUnits: 2176,
    maxTokenCodeUnits: 1024,
    maxMultilineCodeUnits: 2048,
  },
  traversalLimits: { maxDepth: 4, maxNodes: 64 },
} satisfies AiContextBoundaryOptions;

let boundary: AiContextBoundary;
const events: { finding: SafeFinding; boundary: string }[] = [];

beforeAll(async () => {
  boundary = await createAiContextBoundary({
    ...OPTIONS,
    onFinding: (finding, context) => events.push({ finding, boundary: context.boundary }),
  });
});

function expectNoSecret(outcome: AiContextOutcome<unknown>): void {
  const all = JSON.stringify(outcome) + JSON.stringify(events);
  expect(all.includes(TOKEN)).toBe(false);
  expect(all.includes(PEM_BODY)).toBe(false);
}

describe("one agent turn on the real core", () => {
  test("user input is redacted before anything else", () => {
    const outcome = boundary.sanitizeText(`deploy with API_KEY=${TOKEN}`, { boundary: "user-input" });
    expect(outcome).toMatchObject({ outcome: "ok", value: "deploy with API_KEY=<SECRET_1>" });
    if (outcome.outcome !== "ok") throw new Error("unreachable");
    expect(outcome.findings[0]).toMatchObject({ type: "github_token", action: "redact" });
    expectNoSecret(outcome);
  });

  test("a text tool result is redacted before it can join context", () => {
    const outcome = boundary.sanitizeToolResult(`build log\nAPI_KEY=${TOKEN}\n`);
    expect(outcome).toMatchObject({ outcome: "ok", value: "build log\nAPI_KEY=<SECRET_1>\n" });
    expectNoSecret(outcome);
  });

  test("a structured tool result is traversed and redacted leaf by leaf", () => {
    const outcome = boundary.sanitizeToolResult({
      content: [{ type: "text", text: `env: API_KEY=${TOKEN}` }],
      meta: { rows: 2, truncated: false, next: null },
    });
    expect(outcome).toMatchObject({
      outcome: "ok",
      value: {
        content: [{ type: "text", text: "env: API_KEY=<SECRET_1>" }],
        meta: { rows: 2, truncated: false, next: null },
      },
    });
    expectNoSecret(outcome);
  });

  test("a nested value holding a private key is blocked whole, and nothing of it is returned", () => {
    const outcome = boundary.sanitizeValue({ safe: "ordinary text", deep: { pem: PEM } }, { boundary: "tool-result" });
    expect(outcome).toEqual({ outcome: "blocked", reason: "policy" });
    expectNoSecret(outcome);
  });

  test("the context is built only from sanitized parts, and a blocked part blocks it all", () => {
    const built = boundary.buildContext([
      { role: "user", boundary: "user-input", text: `use API_KEY=${TOKEN}` },
      { role: "tool", boundary: "tool-result", value: { result: "ordinary text" } },
    ]);
    expect(built).toMatchObject({
      outcome: "ok",
      value: [
        { role: "user", content: "use API_KEY=<SECRET_1>" },
        { role: "tool", content: { result: "ordinary text" } },
      ],
    });
    const refused = boundary.buildContext([
      { role: "user", boundary: "user-input", text: "ordinary text" },
      { role: "tool", boundary: "tool-result", text: PEM },
    ]);
    expect(refused).toEqual({ outcome: "blocked", reason: "policy" });
    expectNoSecret(built);
    expectNoSecret(refused);
  });

  test("streamed tool output: a token split across chunks is redacted, and nothing is released early", () => {
    const stream = boundary.openStream({ boundary: "tool-result" });
    stream.append("progress 1\nAPI_KEY=ghp_SYNTHETIC");
    stream.append(`REVOKED${"0".repeat(20)}\nprogress 2\n`);
    const outcome = stream.finalize();
    expect(outcome).toMatchObject({ outcome: "ok", value: "progress 1\nAPI_KEY=<SECRET_1>\nprogress 2\n" });
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "lifecycle" });
    expectNoSecret(outcome);
  });

  test("streamed tool output cancelled by a real AbortSignal mid-stream is aborted", () => {
    const controller = new AbortController();
    const stream = boundary.openStream({ boundary: "tool-result", signal: controller.signal });
    stream.append("progress 1\nAPI_KEY=ghp_SYNTHETIC");
    controller.abort();
    stream.append(`REVOKED${"0".repeat(20)}\n`);
    expect(stream.finalize()).toEqual({ outcome: "aborted" });
  });

  test("telemetry carried only safe metadata and the boundary labels", () => {
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(Object.keys(event.finding).sort()).toEqual(
        ["action", "confidence", "detector", "end", "id", "obfuscation", "start", "type"].sort(),
      );
      expect(["user-input", "tool-result", "context"]).toContain(event.boundary);
    }
  });
});

describe("every configured limit fails closed on the real core", () => {
  test("wholeInputLimits.maxInputBytes", () => {
    expect(boundary.sanitizeText("ordinary text\n".repeat(400))).toEqual({
      outcome: "blocked",
      reason: "limit_exceeded",
      code: "INPUT_LIMIT_EXCEEDED",
    });
  });

  test("wholeInputLimits.maxFindings", () => {
    expect(boundary.sanitizeText("secret=SECRET01\n".repeat(17))).toEqual({
      outcome: "blocked",
      reason: "limit_exceeded",
      code: "FINDING_LIMIT_EXCEEDED",
    });
  });

  test("traversalLimits.maxDepth and maxNodes", () => {
    expect(boundary.sanitizeValue({ a: { b: { c: { d: { e: "ordinary text" } } } } })).toEqual({
      outcome: "blocked",
      reason: "limit_exceeded",
    });
    expect(boundary.sanitizeValue(Array.from({ length: 64 }, () => "ordinary text"))).toEqual({
      outcome: "blocked",
      reason: "limit_exceeded",
    });
  });

  test("incrementalLimits.maxInputCodeUnits", () => {
    const stream = boundary.openStream();
    for (let k = 0; k < 20; k += 1) stream.append("ordinary text\n".repeat(64));
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "limit_exceeded", code: "INPUT_LIMIT_EXCEEDED" });
  });

  test("incrementalLimits.maxTokenCodeUnits", () => {
    const stream = boundary.openStream();
    for (let k = 0; k < 30; k += 1) stream.append("x".repeat(50));
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "limit_exceeded", code: "TOKEN_LIMIT_EXCEEDED" });
  });

  test("incrementalLimits.maxMultilineCodeUnits", () => {
    const stream = boundary.openStream();
    stream.append("-----BEGIN PRIVATE KEY-----\n");
    for (let k = 0; k < 60; k += 1) stream.append(`${PEM_BODY}\n`);
    const outcome = stream.finalize();
    expect(outcome).toEqual({ outcome: "blocked", reason: "limit_exceeded", code: "MULTILINE_LIMIT_EXCEEDED" });
    expectNoSecret(outcome);
  });

  test("incrementalLimits.maxBufferedCodeUnits is validated by the core (unreachable as a runtime failure)", async () => {
    // The core refuses a buffered bound below what the token and multiline
    // bounds need, so an open construct's own limit always trips first
    // (core crates/secret-scan-core/tests/incremental.rs). The mapping of a
    // BUFFER_LIMIT_EXCEEDED itself is covered in boundary.test.ts.
    const tight = await createAiContextBoundary({
      ...OPTIONS,
      incrementalLimits: { ...OPTIONS.incrementalLimits, maxBufferedCodeUnits: 16 },
    });
    const stream = tight.openStream();
    stream.append("ordinary text");
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "core_error", code: "INVALID_LIMITS" });
  });
});
