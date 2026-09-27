/**
 * One outcome per span (redact-secret/redact-secret-adapters#45): the counts
 * are per span and not a running total, a span this processor did not forward
 * says `dropped`, and an observer can neither leak input nor change what is
 * exported. `dropped` is never a claim about the exporter.
 *
 * Plain objects stand in for the SDK's span and processor types, as in
 * `./span-processor.test.ts`; `./otel-host.test.ts` is the real-host
 * counterpart.
 */

import type { ReadableSpan, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { type OtelSpanOutcome, RedactingSpanProcessorWith } from "../src/index.js";

function spanLike(attributes: Record<string, unknown>, name = "call"): ReadableSpan {
  return { name, attributes, events: [], links: [], status: { code: 0 } } as unknown as ReadableSpan;
}

function observedProcessor() {
  const outcomes: OtelSpanOutcome[] = [];
  const exported: ReadableSpan[] = [];
  const next = { onEnd: (span: ReadableSpan) => void exported.push(span) } as unknown as SpanProcessor;
  const processor = new RedactingSpanProcessorWith(next, fakeScanAndRedact, {
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  return { processor, outcomes, exported };
}

test("a span with no secret reports one outcome, scanned and nothing else", () => {
  const { processor, outcomes, exported } = observedProcessor();
  processor.onEnd(spanLike({ "http.route": "/users", "http.status_code": 200 }));

  expect(exported).toHaveLength(1);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]).toMatchObject({ host: "otel", unit: "span", dropped: false });
  // The span name and the one string attribute; the number is not a leaf.
  expect(outcomes[0]?.values).toEqual({
    scanned: 2,
    findings: 0,
    redacted: 0,
    blocked: 0,
    limited: 0,
    failed: 0,
  });
});

test("counts are per span, not a running total across spans", () => {
  const { processor, outcomes } = observedProcessor();
  processor.onEnd(spanLike({ "llm.input": "call SECRET_TOKEN_1 now" }));
  processor.onEnd(spanLike({ "llm.input": "nothing here" }));

  expect(outcomes).toHaveLength(2);
  expect(outcomes[0]?.values.redacted).toBe(1);
  expect(outcomes[1]?.values.redacted).toBe(0);
  expect(outcomes[1]?.values.scanned).toBe(2);
});

test("every string in an array attribute is its own counted leaf", () => {
  const { processor, outcomes } = observedProcessor();
  processor.onEnd(spanLike({ "gen_ai.prompt": ["SECRET_TOKEN_1", "plain", null] }));

  // The span name plus the two strings; the null hole is not a leaf.
  expect(outcomes[0]?.values.scanned).toBe(3);
  expect(outcomes[0]?.values.redacted).toBe(1);
});

test("a block finding counts as blocked, and a scanner error as failed", () => {
  const { processor, outcomes } = observedProcessor();
  processor.onEnd(spanLike({ a: "BLOCK_ME" }));
  processor.onEnd(spanLike({ a: "BOOM" }));

  expect(outcomes[0]?.values.blocked).toBe(1);
  expect(outcomes[1]?.values.failed).toBe(1);
});

test("a limit counts as limited and never as scanned", () => {
  const outcomes: OtelSpanOutcome[] = [];
  const processor = new RedactingSpanProcessorWith({ onEnd: () => {} } as unknown as SpanProcessor, fakeScanAndRedact, {
    maxStringLength: 3,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  processor.onEnd(spanLike({ a: "a long attribute value" }, "n"));

  expect(outcomes[0]?.values.limited).toBeGreaterThan(0);
});

test("a span this processor did not forward reports dropped, and is not exported", () => {
  const outcomes: OtelSpanOutcome[] = [];
  const exported: ReadableSpan[] = [];
  const processor = new RedactingSpanProcessorWith(
    { onEnd: (span: ReadableSpan) => void exported.push(span) } as unknown as SpanProcessor,
    fakeScanAndRedact,
    { onOutcome: (outcome) => outcomes.push(outcome) },
  );
  // A frozen attribute bag: the masked write cannot take, so the span is
  // dropped rather than exported unredacted.
  const span = spanLike(Object.freeze({ a: "SECRET_TOKEN_1" }) as Record<string, unknown>);
  processor.onEnd(span);

  expect(exported).toEqual([]);
  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.dropped).toBe(true);
});

test("dropped is false for a forwarded span even when the next processor throws", () => {
  // `dropped` is this processor's own decision. Whether the next processor or
  // an exporter kept the span is something this adapter never learns.
  const outcomes: OtelSpanOutcome[] = [];
  const processor = new RedactingSpanProcessorWith(
    {
      onEnd() {
        throw new Error("exporter unavailable");
      },
    } as unknown as SpanProcessor,
    fakeScanAndRedact,
    { onOutcome: (outcome) => outcomes.push(outcome) },
  );
  expect(() => processor.onEnd(spanLike({ a: "SECRET_TOKEN_1" }))).toThrow();

  expect(outcomes).toHaveLength(1);
  expect(outcomes[0]?.dropped).toBe(false);
  expect(outcomes[0]?.values.redacted).toBe(1);
});

test("an observer that throws changes neither the export nor the next span", () => {
  const exported: ReadableSpan[] = [];
  const processor = new RedactingSpanProcessorWith(
    { onEnd: (span: ReadableSpan) => void exported.push(span) } as unknown as SpanProcessor,
    fakeScanAndRedact,
    {
      onOutcome: () => {
        throw new Error("observer failed");
      },
    },
  );
  expect(() => processor.onEnd(spanLike({ a: "SECRET_TOKEN_1" }))).not.toThrow();
  expect(() => processor.onEnd(spanLike({ a: "plain" }))).not.toThrow();
  expect(exported).toHaveLength(2);
  expect(exported[0]?.attributes.a).toBe("<SECRET_1>");
});

test("an observer that ends another span does not recurse", () => {
  const outcomes: OtelSpanOutcome[] = [];
  let processor: RedactingSpanProcessorWith;
  processor = new RedactingSpanProcessorWith({ onEnd: () => {} } as unknown as SpanProcessor, fakeScanAndRedact, {
    onOutcome: (outcome) => {
      outcomes.push(outcome);
      processor.onEnd(spanLike({ a: "nested" }));
    },
  });
  processor.onEnd(spanLike({ a: "SECRET_TOKEN_1" }));

  expect(outcomes).toHaveLength(1);
});

test("an outcome carries no attribute name, value or error text", () => {
  const { processor, outcomes } = observedProcessor();
  processor.onEnd(spanLike({ apiKey: "SECRET_TOKEN_1" }, "BLOCK_ME"));

  const serialized = JSON.stringify(outcomes);
  for (const text of ["SECRET_TOKEN_1", "BLOCK_ME", "apiKey", "<SECRET_1>", "REDACTED"]) {
    expect(serialized).not.toContain(text);
  }
  expect(Object.keys(outcomes[0] ?? {}).sort()).toEqual(["dropped", "host", "unit", "values"]);
});

test("without onOutcome nothing is counted and the span is redacted as before", () => {
  const exported: ReadableSpan[] = [];
  const processor = new RedactingSpanProcessorWith(
    { onEnd: (span: ReadableSpan) => void exported.push(span) } as unknown as SpanProcessor,
    fakeScanAndRedact,
  );
  processor.onEnd(spanLike({ a: "SECRET_TOKEN_1" }));
  expect(exported[0]?.attributes.a).toBe("<SECRET_1>");
});

test("a non-function onOutcome is an explicit TypeError", () => {
  expect(
    () =>
      new RedactingSpanProcessorWith({ onEnd: () => {} } as unknown as SpanProcessor, fakeScanAndRedact, {
        onOutcome: "nope" as unknown as undefined,
      }),
  ).toThrow(TypeError);
});
