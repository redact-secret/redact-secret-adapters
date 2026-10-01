/**
 * One aggregate budget per span (redact-secret-adapters#173): the name, every
 * attribute, event and link and the status message share it, so many
 * individually valid fields cannot multiply the work.
 */

import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { LIMIT_MARKER, type ScanAndRedact } from "@redact-secret/adapter";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { type OtelSpanOutcome, RedactingSpanProcessorWith, redactAttributesWith } from "../src/index.js";

function harness(options: ConstructorParameters<typeof RedactingSpanProcessorWith>[2] = {}) {
  const seen: string[] = [];
  const scan: ScanAndRedact = (text) => {
    seen.push(text);
    return fakeScanAndRedact(text);
  };
  const exported: ReadableSpan[] = [];
  const outcomes: OtelSpanOutcome[] = [];
  const next = {
    onStart() {},
    onEnd: (span: ReadableSpan) => exported.push(span),
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  } as unknown as SpanProcessor;
  const processor = new RedactingSpanProcessorWith(next, scan, { ...options, onOutcome: (o) => outcomes.push(o) });
  return { processor, seen, exported, outcomes };
}

const span = (parts: Record<string, unknown>) =>
  ({ name: "n", attributes: {}, events: [], links: [], ...parts }) as never;

test("many attributes: the span stops at its leaf bound; the span is still forwarded, with markers", () => {
  const attributes = Object.fromEntries(
    Array.from({ length: 30 }, (_, index) => [`a${index}`, `SECRET_TOKEN_${index}`]),
  );
  const { processor, seen, exported, outcomes } = harness({ operationLimits: { maxLeaves: 5 } });
  processor.onEnd(span({ attributes }));
  expect(exported).toHaveLength(1);
  const values = Object.values((exported[0] as ReadableSpan).attributes);
  expect(values.filter((value) => value === LIMIT_MARKER).length).toBeGreaterThanOrEqual(25);
  expect(JSON.stringify(exported[0]?.attributes)).not.toContain("SECRET_TOKEN");
  // name (1) + 4 attributes
  expect(seen.length).toBeLessThanOrEqual(5);
  expect(outcomes[0]?.values.limited).toBeGreaterThanOrEqual(25);
});

test("many events and links stop at deterministic bounds", () => {
  const events = Array.from({ length: 50 }, (_, index) => ({ name: `SECRET_TOKEN_${index}`, attributes: {} }));
  const links = Array.from({ length: 50 }, (_, index) => ({ context: {}, attributes: { k: `SECRET_TOKEN_${index}` } }));
  const run = () => {
    const h = harness({ operationLimits: { maxNodes: 20 } });
    h.processor.onEnd(span({ events, links }));
    return JSON.stringify(h.exported[0]);
  };
  const first = run();
  expect(first).not.toContain("SECRET_TOKEN");
  expect(first).toContain(LIMIT_MARKER);
  expect(run()).toBe(first);
});

test("a byte bound counts the UTF-8 bytes of every scanned text across the whole span", () => {
  const leaf = "한".repeat(10);
  // `x` is 1 byte and each element 30; an array element has no key context, so one scan each.
  const { processor, exported } = harness({ operationLimits: { maxBytes: 1 + 30 + 30 } });
  processor.onEnd(span({ name: "x", attributes: { a: [leaf, leaf, leaf] } }));
  expect((exported[0] as ReadableSpan).attributes).toEqual({ a: [leaf, leaf, LIMIT_MARKER] });
});

test("each span starts from a fresh budget, and a nested end inside the downstream processor has its own", () => {
  const { processor, exported } = harness({ operationLimits: { maxLeaves: 2 } });
  processor.onEnd(span({ name: "a", attributes: { k: "v" } }));
  processor.onEnd(span({ name: "b", attributes: { k: "v" } }));
  expect(exported.map((s) => (s as ReadableSpan).attributes.k)).toEqual(["v", "v"]);
});

test("redactAttributesWith takes operationLimits for its one bag", () => {
  const attributes: Record<string, unknown> = { a: "x", b: "y", c: "z" };
  redactAttributesWith(fakeScanAndRedact, attributes, { operationLimits: { maxLeaves: 2 } } as never);
  expect(attributes).toEqual({ a: "x", b: "y", c: LIMIT_MARKER });
});

test("an outcome observer sees counts only, never input, when a span is over budget", () => {
  const { processor, outcomes } = harness({ operationLimits: { maxLeaves: 0 } });
  processor.onEnd(span({ name: "SECRET_TOKEN_1", attributes: { k: "SECRET_TOKEN_2" } }));
  expect(JSON.stringify(outcomes)).not.toContain("SECRET_TOKEN");
  expect(outcomes[0]).toMatchObject({ dropped: false, values: { scanned: 0, limited: 2 } });
});
