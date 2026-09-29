/**
 * The shared outcome contract (redact-secret/redact-secret-adapters#45): what
 * the six numbers mean, and that nothing derived from the input can reach an
 * observer through them.
 *
 * The scanner is the deterministic fake: `SECRET_TOKEN_n` is redacted,
 * `BLOCK_ME` blocks, `WARN_ME` gives a finding that changes no text, `BOOM`
 * throws.
 */

import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import {
  createOutcomeCounter,
  ERROR_MARKER,
  LIMIT_MARKER,
  maskLeafOutcomeWith,
  maskLeafWith,
  maskLogValueWith,
  notify,
  toValueCounts,
} from "../src/index.js";

function countsFor(data: unknown, limits?: Partial<Record<string, number>>) {
  const counter = createOutcomeCounter();
  const value = maskLogValueWith(fakeScanAndRedact, data, { counter, limits: limits as never });
  return { counter, value };
}

test("a value with no finding is scanned and nothing else", () => {
  const { counter, value } = countsFor({ user: "alice", count: 3, ok: true, missing: null });
  expect(value).toEqual({ user: "alice", count: 3, ok: true, missing: null });
  expect(toValueCounts(counter)).toEqual({
    scanned: 1,
    findings: 0,
    redacted: 0,
    blocked: 0,
    limited: 0,
    failed: 0,
  });
});

test("findings count findings, not distinct credentials: one value repeated in five leaves is five", () => {
  const repeated = Array.from({ length: 5 }, () => "SECRET_TOKEN_1");
  const { counter } = countsFor(repeated);
  expect(counter.scanned).toBe(5);
  expect(counter.findings).toBe(5);
  expect(counter.redacted).toBe(5);
});

test("a finding that changes no text is counted as a finding but not as redacted", () => {
  // The core leaves `warn` text alone; `findings` and `redacted` are exactly
  // the pair that tells a host this happened.
  const { counter, value } = countsFor({ note: "WARN_ME please" });
  expect(value).toEqual({ note: "WARN_ME please" });
  expect(counter.findings).toBe(1);
  expect(counter.redacted).toBe(0);
  expect(counter.scanned).toBe(1);
});

test("a block finding counts as blocked, not as redacted", () => {
  const { counter, value } = countsFor({ note: "BLOCK_ME now" });
  expect(value).toEqual({ note: "[REDACTED:BLOCKED]" });
  expect(counter.blocked).toBe(1);
  expect(counter.redacted).toBe(0);
  expect(counter.findings).toBe(1);
});

test("a scanner failure counts as failed, and as scanned because the core was called", () => {
  const { counter, value } = countsFor({ note: "BOOM" });
  expect(value).toEqual({ note: ERROR_MARKER });
  expect(counter.failed).toBe(1);
  expect(counter.scanned).toBe(1);
  expect(counter.findings).toBe(0);
});

test("a leaf refused by a bound counts as limited and never as scanned", () => {
  const { counter, value } = countsFor({ long: "x".repeat(20) }, { maxStringLength: 5 });
  expect(value).toEqual({ long: LIMIT_MARKER });
  expect(counter.limited).toBe(1);
  expect(counter.scanned).toBe(0);
});

test("a leaf budget spent mid-walk counts each refused leaf as limited", () => {
  const { counter } = countsFor(["SECRET_TOKEN_1", "SECRET_TOKEN_2", "SECRET_TOKEN_3"], { maxTotalLeaves: 1 });
  expect(counter.scanned).toBe(1);
  expect(counter.redacted).toBe(1);
  expect(counter.limited).toBe(2);
});

test("a container past maxDepth counts as limited, and a cycle as failed", () => {
  const deep = { a: { b: { c: "SECRET_TOKEN_1" } } };
  const { counter: deepCounter } = countsFor(deep, { maxDepth: 2 });
  expect(deepCounter.limited).toBe(1);
  expect(deepCounter.scanned).toBe(0);

  const cyclic: Record<string, unknown> = {};
  cyclic.self = cyclic;
  const { counter: cycleCounter } = countsFor(cyclic);
  expect(cycleCounter.failed).toBe(1);
});

test("a throwing getter counts as failed for that key alone", () => {
  const { counter } = countsFor({
    get boom() {
      throw new Error("unreadable");
    },
    fine: "SECRET_TOKEN_1",
  });
  expect(counter.failed).toBe(1);
  expect(counter.redacted).toBe(1);
});

test("a counter only ever grows, so a host can accumulate several passes into one unit", () => {
  const counter = createOutcomeCounter();
  maskLogValueWith(fakeScanAndRedact, "SECRET_TOKEN_1", { counter });
  maskLogValueWith(fakeScanAndRedact, "SECRET_TOKEN_2", { counter });
  expect(counter.scanned).toBe(2);
  expect(counter.redacted).toBe(2);
});

test("the counter holds six numbers and nothing else, so nothing input-derived can ride along", () => {
  const { counter } = countsFor({ token: "SECRET_TOKEN_1", note: "BLOCK_ME" });
  expect(Object.keys(counter).sort()).toEqual(["blocked", "failed", "findings", "limited", "redacted", "scanned"]);
  for (const value of Object.values(counter)) {
    expect(Number.isInteger(value)).toBe(true);
    expect(value).toBeGreaterThanOrEqual(0);
  }
  // Nothing anywhere in the serialized counter resembles the input.
  const serialized = JSON.stringify(toValueCounts(counter));
  expect(serialized).not.toContain("SECRET_TOKEN_1");
  expect(serialized).not.toContain("BLOCK_ME");
  expect(serialized).not.toContain("token");
});

test("a frozen snapshot cannot be written back into the live counter", () => {
  const counter = createOutcomeCounter();
  const snapshot = toValueCounts(counter);
  counter.scanned = 7;
  expect(snapshot.scanned).toBe(0);
  expect(Object.isFrozen(snapshot)).toBe(true);
});

test("maskLeafWith still returns just the masked string, and agrees with the outcome variant", () => {
  for (const text of ["plain", "SECRET_TOKEN_1", "BLOCK_ME", "BOOM", "WARN_ME"]) {
    expect(maskLeafWith(fakeScanAndRedact, text)).toBe(maskLeafOutcomeWith(fakeScanAndRedact, text).text);
  }
  expect(maskLeafOutcomeWith(fakeScanAndRedact, "plain")).toEqual({
    text: "plain",
    outcome: "unchanged",
    findings: 0,
  });
});

test("without a counter nothing is counted and the masked value is unchanged", () => {
  expect(maskLogValueWith(fakeScanAndRedact, { token: "SECRET_TOKEN_1" })).toEqual({ token: "<SECRET_1>" });
});

test("notify swallows an observer's exception and never rethrows it", () => {
  expect(() =>
    notify(() => {
      throw new Error("observer failed");
    }, 1),
  ).not.toThrow();
  let seen: number | undefined;
  notify((value: number) => {
    seen = value;
  }, 42);
  expect(seen).toBe(42);
  expect(() => notify(undefined, 1)).not.toThrow();
});
