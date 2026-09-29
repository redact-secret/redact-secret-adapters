/**
 * Per-crossing scan memoization (#107): identical texts inside one
 * `sanitizeValue` / `buildContext` call are scanned once, and nothing else
 * changes. Every value is synthetic.
 */

import { describe, expect, test } from "vitest";

import { type AiContextBoundaryOptions, createAiContextBoundaryWith, type SafeFinding } from "../src/index.js";
import { createFakeCore, LIMITS } from "./fake-core.js";

const SECRET = "SECRET_TOKEN_7";
const TRAVERSAL = { maxDepth: 6, maxNodes: 200 };

function setup(overrides: Partial<AiContextBoundaryOptions> = {}) {
  const fake = createFakeCore();
  const events: { finding: SafeFinding; context: object }[] = [];
  const boundary = createAiContextBoundaryWith(fake.core, {
    ...LIMITS,
    traversalLimits: TRAVERSAL,
    onFinding: (finding, context) => events.push({ finding, context }),
    ...overrides,
  });
  return { boundary, events, calls: fake.calls };
}

const blocks = Array.from({ length: 4 }, (_, i) => ({ type: "text", text: `note ${i} ${SECRET}` }));

describe("per-crossing scan memoization", () => {
  test("sanitizeValue scans each distinct text once and matches the per-block results", () => {
    const { boundary, calls, events } = setup();
    const outcome = boundary.sanitizeValue({ content: blocks });
    expect(new Set(calls.scans).size).toBe(calls.scans.length);

    const reference = setup();
    const expected = blocks.map((block) => reference.boundary.sanitizeValue(block));
    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    const merged = (outcome.value as { content: unknown[] }).content;
    expected.forEach((one, i) => {
      expect(one.outcome).toBe("ok");
      if (one.outcome === "ok") expect(merged[i]).toEqual(one.value);
    });
    // Without memoization the same call scans far more texts than are distinct.
    expect(calls.scans.length).toBeLessThan(reference.calls.scans.length);
    // onFinding fires once per leaf occurrence, not once per distinct text.
    expect(events.filter((e) => e.finding.action === "redact")).toHaveLength(4);
  });

  test("scanner calls equal the distinct texts, not the visits", () => {
    const { boundary, calls } = setup();
    boundary.sanitizeValue({ content: Array.from({ length: 10 }, () => ({ type: "text", text: "plain" })) });
    // keys content/type/text, leaf "text", leaf "plain", and their key views.
    expect(calls.scans).toHaveLength(new Set(calls.scans).size);
    expect(calls.scans.length).toBeLessThanOrEqual(9);
  });

  test("the cache does not outlive one operation", () => {
    const { boundary, calls } = setup();
    boundary.sanitizeValue({ a: "x" });
    const first = calls.scans.length;
    boundary.sanitizeValue({ a: "x" });
    expect(calls.scans).toHaveLength(first * 2);
  });

  test("buildContext shares scans across parts and keeps per-part findings and order", () => {
    const { boundary, calls, events } = setup();
    const parts = [0, 1, 2].map((i) => ({ role: "user", value: { text: `m${i} ${SECRET}`, kind: "same" } }));
    const outcome = boundary.buildContext(parts);
    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.findings).toHaveLength(3);
    expect(events).toHaveLength(3);
    expect(new Set(calls.scans).size).toBe(calls.scans.length);
    parts.forEach((part, i) => {
      const alone = setup().boundary.buildContext([part]);
      expect(alone.outcome === "ok" && alone.value[0]).toEqual(outcome.value[i]);
    });
  });

  test("maxNodes still counts every occurrence", () => {
    const { boundary } = setup({ traversalLimits: { maxDepth: 6, maxNodes: 4 } });
    expect(boundary.sanitizeValue(["same", "same", "same", "same", "same"]).outcome).toBe("blocked");
  });

  test("a failure is never cached", () => {
    const { boundary } = setup();
    expect(boundary.sanitizeValue({ k: "BOOM" }).outcome).toBe("blocked");
    expect(boundary.sanitizeValue({ k: "BOOM" }).outcome).toBe("blocked");
  });
});
