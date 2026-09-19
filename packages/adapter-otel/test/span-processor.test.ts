/**
 * Structural tests: plain objects stand in for the SDK's span and
 * processor types, proving the adapter needs nothing but the shape.
 * `./otel-host.test.ts` is the real-host counterpart.
 */

import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ScanAndRedact } from "@redact-secret/adapter";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { RedactingSpanProcessorWith, redactAttributesWith } from "../src/index.js";

interface PlainSpan {
  attributes: Record<string, unknown>;
  events: { name?: string; attributes: Record<string, unknown> }[];
}

function fakeNextProcessor(exported: PlainSpan[]) {
  const started: { span: unknown; parentContext: unknown }[] = [];
  const next = {
    onStart(span: unknown, parentContext: unknown) {
      started.push({ span, parentContext });
    },
    onEnd(span: unknown) {
      exported.push(span as PlainSpan);
    },
    shutdown() {
      return Promise.resolve("shutdown");
    },
    forceFlush() {
      return Promise.resolve("flushed");
    },
  };
  return { started, next: next as unknown as SpanProcessor };
}

const asSpan = (span: PlainSpan) => span as unknown as ReadableSpan;

test("redacts string and string-array span and event attributes; no plaintext reaches the exporter", () => {
  const exported: PlainSpan[] = [];
  const processor = new RedactingSpanProcessorWith(fakeNextProcessor(exported).next, fakeScanAndRedact);

  const span: PlainSpan = {
    attributes: {
      "llm.input_messages": "call SECRET_TOKEN_1 now",
      "llm.tags": ["ok", "BLOCK_ME here"],
      "retry.count": 3,
      "retry.ok": true,
    },
    events: [{ name: "tool_call", attributes: { "tool.args": "value SECRET_TOKEN_2 done" } }],
  };

  processor.onEnd(asSpan(span));

  expect(exported.length).toBe(1);
  expect(exported[0]?.attributes["llm.input_messages"]).toBe("call <SECRET_1> now");
  expect(exported[0]?.attributes["llm.tags"]).toEqual(["ok", "[REDACTED:BLOCKED]"]);
  expect(exported[0]?.attributes["retry.count"]).toBe(3);
  expect(exported[0]?.attributes["retry.ok"]).toBe(true);
  expect(exported[0]?.events[0]?.attributes["tool.args"]).toBe("value <SECRET_1> done");

  const serialized = JSON.stringify(exported);
  expect(serialized).not.toContain("SECRET_TOKEN_1");
  expect(serialized).not.toContain("SECRET_TOKEN_2");
  expect(serialized).not.toContain("BLOCK_ME");
});

test("a core failure on one attribute fails closed without throwing into the SDK", () => {
  const exported: PlainSpan[] = [];
  const processor = new RedactingSpanProcessorWith(fakeNextProcessor(exported).next, fakeScanAndRedact);

  processor.onEnd(asSpan({ attributes: { boom: "trigger BOOM here" }, events: [] }));

  expect(exported[0]?.attributes.boom).toBe("[REDACTED:ERROR]");
  expect(JSON.stringify(exported)).not.toContain("BOOM");
});

test("onStart, shutdown, and forceFlush delegate to the wrapped processor", async () => {
  const { started, next } = fakeNextProcessor([]);
  const processor = new RedactingSpanProcessorWith(next, fakeScanAndRedact);

  processor.onStart("span-1" as unknown as Span, "ctx-1" as unknown as Parameters<SpanProcessor["onStart"]>[1]);
  expect(started).toEqual([{ span: "span-1", parentContext: "ctx-1" }]);
  expect(await processor.shutdown()).toBe("shutdown");
  expect(await processor.forceFlush()).toBe("flushed");
});

test("redactAttributesWith is a no-op for undefined or null attributes", () => {
  expect(() => redactAttributesWith(fakeScanAndRedact, undefined)).not.toThrow();
  expect(() => redactAttributesWith(fakeScanAndRedact, null)).not.toThrow();
});

test("rejects a next processor without onEnd, or a non-function scanAndRedact", () => {
  expect(() => new RedactingSpanProcessorWith({} as SpanProcessor, fakeScanAndRedact)).toThrow(TypeError);
  expect(() => new RedactingSpanProcessorWith(fakeNextProcessor([]).next, null as unknown as ScanAndRedact)).toThrow(
    TypeError,
  );
});
