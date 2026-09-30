/**
 * The final bytes, not the in-memory span (redact-secret/redact-secret-adapters#49).
 * `otel-host.test.ts` reads spans back from `InMemorySpanExporter`, which
 * hands over the very objects the processor mutated. What leaves the process
 * is an exporter's serialization of them, so these tests put a real
 * `BasicTracerProvider` in front of an exporter that serializes each batch
 * with `@opentelemetry/otlp-transformer`'s `JsonTraceSerializer` — the OTLP
 * http/json request body `OTLPTraceExporter` sends — and assert on those
 * bytes. CI runs this at both ends of the declared
 * `@opentelemetry/sdk-trace-base` and `@redact-secret/core` ranges.
 *
 * Every value is synthetic: `ghp_` + 36 characters is the shape of a GitHub
 * token, not a token.
 */

import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  SimpleSpanProcessor,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { createRedactingSpanProcessor, RedactingSpanProcessorWith } from "../src/index.js";

const SYNTHETIC_GITHUB_TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000";

/** An exporter whose only output is the OTLP/JSON bytes it would send. */
function otlpJsonExporter(): SpanExporter & { bytes: Uint8Array[] } {
  const bytes: Uint8Array[] = [];
  return {
    bytes,
    export(spans: ReadableSpan[], done) {
      const body = JsonTraceSerializer.serializeRequest(spans);
      if (body !== undefined) bytes.push(body);
      done({ code: 0 });
    },
    shutdown: () => Promise.resolve(),
  };
}

const decode = (chunks: Uint8Array[]) => chunks.map((chunk) => new TextDecoder().decode(chunk)).join("\n");

interface OtlpAttribute {
  key: string;
  value: { stringValue?: string; arrayValue?: { values: { stringValue?: string }[] } };
}
interface OtlpSpan {
  name: string;
  attributes: OtlpAttribute[];
  events: { name: string; attributes: OtlpAttribute[] }[];
  links: { attributes: OtlpAttribute[] }[];
  status: { message?: string };
}

function spansIn(chunks: Uint8Array[]): OtlpSpan[] {
  return chunks.flatMap((chunk) => {
    const body = JSON.parse(new TextDecoder().decode(chunk)) as {
      resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[];
    };
    return body.resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans));
  });
}

const attribute = (attributes: OtlpAttribute[], key: string) => attributes.find((a) => a.key === key)?.value;

async function emit(
  wrap: (next: SpanProcessor) => SpanProcessor | Promise<SpanProcessor>,
  batch: boolean,
  secret: string,
) {
  const exporter = otlpJsonExporter();
  const next = batch ? new BatchSpanProcessor(exporter) : new SimpleSpanProcessor(exporter);
  const provider = new BasicTracerProvider({ spanProcessors: [await wrap(next)] });
  const tracer = provider.getTracer("adapter-otel-trace-bytes-test");
  const linked = tracer.startSpan("linked").spanContext();
  const span = tracer.startSpan(`GET /reset?token=${secret}`, {
    links: [{ context: linked, attributes: { "peer.auth": `Bearer ${secret}` } }],
  });
  span.setAttribute("llm.input_messages", `deploy with token ${secret}`);
  span.setAttribute("llm.tags", ["ok", `tag ${secret}`]);
  span.setAttribute("retry.count", 3);
  span.addEvent("tool_call", { "tool.args": `value ${secret} done` });
  span.setStatus({ code: 2, message: `denied for ${secret}` });
  span.end();
  await provider.forceFlush();
  await provider.shutdown();
  return exporter.bytes;
}

for (const batch of [false, true]) {
  const processor = batch ? "BatchSpanProcessor" : "SimpleSpanProcessor";

  test(`the injected processor: no plaintext in the OTLP bytes through ${processor}`, async () => {
    const bytes = await emit(
      (next) => new RedactingSpanProcessorWith(next, fakeScanAndRedact),
      batch,
      "SECRET_TOKEN_1",
    );

    expect(bytes.length).toBeGreaterThan(0);
    expect(decode(bytes)).not.toContain("SECRET_TOKEN_1");
    const redacted = spansIn(bytes).find((s) => s.name !== "linked");
    expect(redacted?.name).toBe("GET /reset?token=<SECRET_1>");
    expect(attribute(redacted?.attributes ?? [], "llm.input_messages")?.stringValue).toBe(
      "deploy with token <SECRET_1>",
    );
    expect(attribute(redacted?.attributes ?? [], "llm.tags")?.arrayValue?.values.map((v) => v.stringValue)).toEqual([
      "ok",
      "tag <SECRET_1>",
    ]);
    expect(attribute(redacted?.events[0]?.attributes ?? [], "tool.args")?.stringValue).toBe("value <SECRET_1> done");
    expect(attribute(redacted?.links[0]?.attributes ?? [], "peer.auth")?.stringValue).toBe("Bearer <SECRET_1>");
    expect(redacted?.status.message).toBe("denied for <SECRET_1>");
  });

  test(`the live factory on the real core: no plaintext in the OTLP bytes through ${processor}`, async () => {
    const bytes = await emit((next) => createRedactingSpanProcessor(next), batch, SYNTHETIC_GITHUB_TOKEN);

    expect(bytes.length).toBeGreaterThan(0);
    const text = decode(bytes);
    expect(text).not.toContain(SYNTHETIC_GITHUB_TOKEN);
    expect(text).not.toContain("ghp_SYNTHETIC");
    const redacted = spansIn(bytes).find((s) => s.name !== "linked");
    expect(attribute(redacted?.attributes ?? [], "llm.input_messages")?.stringValue).toMatch(
      /^deploy with token <SECRET_\d+>$/,
    );
    expect(attribute(redacted?.attributes ?? [], "retry.count")).toBeDefined();
  });
}
