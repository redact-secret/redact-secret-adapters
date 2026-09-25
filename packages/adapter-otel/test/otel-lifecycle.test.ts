/**
 * Real-host lifecycle qualification for OpenTelemetry JS (#11): the simple
 * and batch span processors, span events, string and string-array
 * attributes, concurrent spans, exporter failure, and provider shutdown. CI
 * runs this at both ends of the declared `@opentelemetry/sdk-trace-base`
 * peer range, like `otel-host.test.ts`.
 *
 * Every span carries its own id and its own synthetic secret, so an
 * exported span holding another span's id, a block marker it did not ask
 * for, or any `SECRET_TOKEN_` text is cross-span leakage.
 */

import { setImmediate as yieldToLoop } from "node:timers/promises";
import { type DiagLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  InMemorySpanExporter,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { afterEach, expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { RedactingSpanProcessorWith } from "../src/index.js";

const EXPORT_FAILED = 1;
const TASKS = 16;
const SPANS_PER_TASK = 20;

afterEach(() => {
  diag.disable();
});

/** Captures every diagnostic the SDK emits, which is where exporter failures go. */
function captureDiagnostics(): string[] {
  const messages: string[] = [];
  const record = (...args: unknown[]) => {
    messages.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
  };
  const logger: DiagLogger = { error: record, warn: record, info: record, debug: record, verbose: record };
  diag.setLogger(logger, DiagLogLevel.ALL);
  return messages;
}

function snapshot(span: ReadableSpan) {
  const { name, attributes, events, status, links } = span;
  return JSON.stringify({ name, attributes, events, status, links });
}

async function emitConcurrently(provider: BasicTracerProvider): Promise<number> {
  const tracer = provider.getTracer("adapter-otel-lifecycle-test");
  let emitted = 0;
  await Promise.all(
    Array.from({ length: TASKS }, async (_, task) => {
      for (let index = 0; index < SPANS_PER_TASK; index += 1) {
        const id = `${task}-${index}`;
        const span = tracer.startSpan(`op ${id}`);
        span.setAttribute("span.id", id);
        span.setAttribute("input.value", `prompt ${id} with SECRET_TOKEN_${task}${index}`);
        span.setAttribute("llm.tags", [`tag ${id}`, "SECRET_TOKEN_7"]);
        span.setAttribute("retries", index);
        if ((task * SPANS_PER_TASK + index) % 5 === 0) span.setAttribute("guard", "BLOCK_ME");
        await yieldToLoop();
        span.addEvent(`tool ${id}`, { "tool.args": `args ${id} SECRET_TOKEN_3`, "tool.list": ["SECRET_TOKEN_4", id] });
        span.end();
        emitted += 1;
      }
    }),
  );
  return emitted;
}

function assertNoCrossSpanLeak(spans: readonly ReadableSpan[], emitted: number): void {
  expect(spans).toHaveLength(emitted);
  const ids = new Set<string>();
  for (const span of spans) {
    const id = span.attributes["span.id"] as string;
    ids.add(id);
    const [task, index] = id.split("-").map(Number) as [number, number];
    const blocked = (task * SPANS_PER_TASK + index) % 5 === 0;
    expect(span.name).toBe(`op ${id}`);
    expect(span.attributes).toEqual({
      "span.id": id,
      "input.value": `prompt ${id} with <SECRET_1>`,
      "llm.tags": [`tag ${id}`, "<SECRET_1>"],
      retries: index,
      ...(blocked ? { guard: "[REDACTED:BLOCKED]" } : {}),
    });
    expect(span.events.map((event) => [event.name, event.attributes])).toEqual([
      [`tool ${id}`, { "tool.args": `args ${id} <SECRET_1>`, "tool.list": ["<SECRET_1>", id] }],
    ]);
    expect(snapshot(span)).not.toMatch(/SECRET_TOKEN_\d|BLOCK_ME/);
  }
  expect(ids.size).toBe(emitted);
}

test("the batch span processor exports every concurrent span redacted, with no cross-span leakage", async () => {
  const exporter = new InMemorySpanExporter();
  const batch = new BatchSpanProcessor(exporter, {
    maxQueueSize: 4096,
    maxExportBatchSize: 64,
    scheduledDelayMillis: 5,
  });
  const provider = new BasicTracerProvider({
    spanProcessors: [new RedactingSpanProcessorWith(batch, fakeScanAndRedact)],
  });
  const emitted = await emitConcurrently(provider);
  await provider.forceFlush();
  assertNoCrossSpanLeak(exporter.getFinishedSpans(), emitted);
  await provider.shutdown();
});

test("the simple span processor exports every concurrent span redacted, with no cross-span leakage", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new RedactingSpanProcessorWith(new SimpleSpanProcessor(exporter), fakeScanAndRedact)],
  });
  const emitted = await emitConcurrently(provider);
  await provider.forceFlush();
  assertNoCrossSpanLeak(exporter.getFinishedSpans(), emitted);
  await provider.shutdown();
});

/** An exporter that records what it was handed, then fails while echoing it. */
function failingExporter(mode: "callback" | "throw") {
  const received: string[] = [];
  const exporter: SpanExporter = {
    export(spans, resultCallback) {
      const echoed = spans.map(snapshot).join("\n");
      received.push(echoed);
      if (mode === "throw") throw new Error(`exporter crashed on ${echoed}`);
      resultCallback({ code: EXPORT_FAILED, error: new Error(`collector rejected ${echoed}`) });
    },
    shutdown: () => Promise.resolve(),
  };
  return { exporter, received };
}

for (const [label, wrap] of [
  ["batch", (exporter: SpanExporter) => new BatchSpanProcessor(exporter, { scheduledDelayMillis: 5 })],
  ["simple", (exporter: SpanExporter) => new SimpleSpanProcessor(exporter)],
] as const) {
  for (const mode of ["callback", "throw"] as const) {
    test(`a ${label} exporter that fails (${mode}) only ever saw, and only ever reports, redacted spans`, async () => {
      const diagnostics = captureDiagnostics();
      const { exporter, received } = failingExporter(mode);
      const provider = new BasicTracerProvider({
        spanProcessors: [new RedactingSpanProcessorWith(wrap(exporter), fakeScanAndRedact)],
      });
      const span = provider.getTracer("adapter-otel-lifecycle-test").startSpan("export SECRET_TOKEN_1");
      span.setAttribute("auth", "Bearer SECRET_TOKEN_2");
      span.addEvent("retry", { tokens: ["SECRET_TOKEN_3"] });
      expect(() => span.end()).not.toThrow();
      await provider.forceFlush().catch(() => undefined);
      await yieldToLoop();

      expect(received.join("")).toContain("<SECRET_1>");
      const surfaced = [...received, ...diagnostics].join("\n");
      expect(surfaced).not.toMatch(/SECRET_TOKEN_\d/);
      await provider.shutdown().catch(() => undefined);
    });
  }
}

test("shutdown and forceFlush reach the wrapped processor, and spans ended after shutdown are never exported", async () => {
  const calls: string[] = [];
  const exporter = new InMemorySpanExporter();
  const inner = new SimpleSpanProcessor(exporter);
  const recording: SpanProcessor = {
    onStart: (span, context) => inner.onStart(span, context),
    onEnd: (span) => inner.onEnd(span),
    forceFlush: () => {
      calls.push("forceFlush");
      return inner.forceFlush();
    },
    shutdown: () => {
      calls.push("shutdown");
      return inner.shutdown();
    },
  };
  const provider = new BasicTracerProvider({
    spanProcessors: [new RedactingSpanProcessorWith(recording, fakeScanAndRedact)],
  });
  const tracer = provider.getTracer("adapter-otel-lifecycle-test");
  tracer.startSpan("before SECRET_TOKEN_1").end();
  await provider.forceFlush();
  // InMemorySpanExporter.shutdown() clears what it holds, so read it first.
  const exported = exporter.getFinishedSpans().map((span) => span.name);
  await provider.shutdown();
  expect(() => tracer.startSpan("after SECRET_TOKEN_2").end()).not.toThrow();

  expect(calls).toEqual(["forceFlush", "shutdown"]);
  expect(exported).toEqual(["before <SECRET_1>"]);
  expect(exporter.getFinishedSpans()).toEqual([]);
});

test("a scanner that fails for one span never affects the next span's redaction", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [new RedactingSpanProcessorWith(new SimpleSpanProcessor(exporter), fakeScanAndRedact)],
  });
  const tracer = provider.getTracer("adapter-otel-lifecycle-test");
  const failing = tracer.startSpan("first");
  failing.setAttribute("payload", "BOOM SECRET_TOKEN_1");
  failing.end();
  const next = tracer.startSpan("second");
  next.setAttribute("payload", "ok SECRET_TOKEN_2");
  next.end();
  await provider.forceFlush();
  expect(exporter.getFinishedSpans().map((span) => span.attributes.payload)).toEqual([
    "[REDACTED:ERROR]",
    "ok <SECRET_1>",
  ]);
  await provider.shutdown();
});
