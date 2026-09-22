/**
 * The real-host test. `ReadableSpan.attributes` is typed `readonly`; this
 * adapter mutates it in place. If an SDK version ever freezes that object
 * — or hands `onEnd` a copy — the adapter becomes a silent no-op and
 * plaintext reaches the exporter with no error anywhere. The structural
 * tests in `./span-processor.test.ts` cannot see that: only a real span
 * from a real `BasicTracerProvider`, read back from a real exporter, can.
 *
 * CI runs this at both ends of the declared
 * `@opentelemetry/sdk-trace-base` peer range. `adapter-otel` stays
 * `"private": true` until it does.
 */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { RedactingSpanProcessorWith } from "../src/index.js";

function realPipeline() {
  const exporter = new InMemorySpanExporter();
  const processor = new RedactingSpanProcessorWith(new SimpleSpanProcessor(exporter), fakeScanAndRedact);
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  return { exporter, provider, tracer: provider.getTracer("adapter-otel-host-test") };
}

test("a real span's attributes are actually mutated before the exporter sees them", async () => {
  const { exporter, provider, tracer } = realPipeline();

  const span = tracer.startSpan("llm-call");
  span.setAttribute("llm.input_messages", "call SECRET_TOKEN_1 now");
  span.setAttribute("llm.tags", ["ok", "BLOCK_ME here"]);
  span.setAttribute("retry.count", 3);
  span.setAttribute("retry.ok", true);
  span.setAttribute("boom", "trigger BOOM here");
  span.addEvent("tool_call", { "tool.args": "value SECRET_TOKEN_2 done" });
  span.end();
  await provider.forceFlush();

  const [exported] = exporter.getFinishedSpans();
  expect(exported).toBeDefined();
  expect(exported?.attributes).toEqual({
    "llm.input_messages": "call <SECRET_1> now",
    "llm.tags": ["ok", "[REDACTED:BLOCKED]"],
    "retry.count": 3,
    "retry.ok": true,
    boom: "[REDACTED:ERROR]",
  });
  expect(exported?.events.map((event) => event.attributes)).toEqual([{ "tool.args": "value <SECRET_1> done" }]);

  const serialized = JSON.stringify({ attributes: exported?.attributes, events: exported?.events });
  for (const plaintext of ["SECRET_TOKEN_1", "SECRET_TOKEN_2", "BLOCK_ME", "BOOM", "simulated core failure"]) {
    expect(serialized).not.toContain(plaintext);
  }

  await provider.shutdown();
});

test("a real span's name, event name, status message, and link attributes are redacted before export", async () => {
  const { exporter, provider, tracer } = realPipeline();

  const linked = tracer.startSpan("linked").spanContext();
  const span = tracer.startSpan("GET /reset?token=SECRET_TOKEN_1", {
    links: [{ context: linked, attributes: { "peer.auth": "Bearer SECRET_TOKEN_2" } }],
  });
  span.setAttribute("tags", ["SECRET_TOKEN_3", null, "plain"] as unknown as string[]);
  span.addEvent("retry with SECRET_TOKEN_4");
  span.setStatus({ code: 2 /* SpanStatusCode.ERROR */, message: "denied for SECRET_TOKEN_5" });
  span.end();
  await provider.forceFlush();

  const [exported] = exporter.getFinishedSpans();
  expect(exported?.name).toBe("GET /reset?token=<SECRET_1>");
  expect(exported?.attributes.tags).toEqual(["<SECRET_1>", null, "plain"]);
  expect(exported?.events.map((event) => event.name)).toEqual(["retry with <SECRET_1>"]);
  expect(exported?.status.message).toBe("denied for <SECRET_1>");
  expect(exported?.links[0]?.attributes).toEqual({ "peer.auth": "Bearer <SECRET_1>" });
  const { name, attributes, events, status, links } = exported ?? {};
  expect(JSON.stringify({ name, attributes, events, status, links })).not.toMatch(/SECRET_TOKEN_\d/);

  await provider.shutdown();
});

test("the SDK hands onEnd mutable attribute bags — the assumption this adapter rests on", async () => {
  const frozen: boolean[] = [];
  const probe = new RedactingSpanProcessorWith(
    {
      onStart() {},
      onEnd(span) {
        frozen.push(Object.isFrozen(span.attributes), ...span.events.map((event) => Object.isFrozen(event.attributes)));
      },
      shutdown: () => Promise.resolve(),
      forceFlush: () => Promise.resolve(),
    },
    fakeScanAndRedact,
  );
  const provider = new BasicTracerProvider({ spanProcessors: [probe] });

  const span = provider.getTracer("adapter-otel-host-test").startSpan("probe");
  span.setAttribute("key", "SECRET_TOKEN_1");
  span.addEvent("event", { key: "SECRET_TOKEN_2" });
  span.end();

  expect(frozen).toEqual([false, false]);
  await provider.shutdown();
});
