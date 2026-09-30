/**
 * The migration path from `@redact-secret/adapter-otel` to
 * `@redact-secret/adapter-otel-trace` (redact-secret/redact-secret-adapters#49).
 *
 * An existing consumer keeps importing `@redact-secret/adapter-otel`. These
 * tests import both names the way a consumer does — by package name, which
 * the workspace resolves to each package's built `dist/` — and check that
 * the old name is not silently a different or weaker processor: the same
 * export list, the very same objects, and the same OTLP JSON bytes out of a
 * real `BasicTracerProvider` for the same span. CI runs this at both ends of
 * the declared `@opentelemetry/sdk-trace-base` and `@redact-secret/core`
 * ranges.
 *
 * Every value is synthetic: `ghp_` + 36 characters is the shape of a GitHub
 * token, not a token.
 */

import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import {
  BasicTracerProvider,
  BatchSpanProcessor,
  type ReadableSpan,
  type SpanExporter,
  type SpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import * as published from "@redact-secret/adapter-otel";
import * as candidate from "@redact-secret/adapter-otel-trace";
import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import * as source from "../src/index.js";

const SYNTHETIC_GITHUB_TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000";

test("the old name exports exactly what the new one does, as the same objects", () => {
  const exported = (namespace: object) => new Map(Object.entries(namespace));
  const expected = exported(candidate);
  expect(exported(published)).toEqual(expected);
  expect(exported(source)).toEqual(expected);
  for (const [name, value] of expected) {
    expect(exported(published).get(name), name).toBe(value);
    expect(exported(source).get(name), name).toBe(value);
  }
  expect([...expected.keys()].sort()).toEqual([
    "RedactingSpanProcessorWith",
    "createRedactingSpanProcessor",
    "redactAttributesWith",
  ]);
});

test("a processor built through one name is an instance of the other's class", () => {
  const next: SpanProcessor = {
    onStart() {},
    onEnd() {},
    shutdown: () => Promise.resolve(),
    forceFlush: () => Promise.resolve(),
  };
  expect(new published.RedactingSpanProcessorWith(next, fakeScanAndRedact)).toBeInstanceOf(
    candidate.RedactingSpanProcessorWith,
  );
  expect(new candidate.RedactingSpanProcessorWith(next, fakeScanAndRedact)).toBeInstanceOf(
    published.RedactingSpanProcessorWith,
  );
});

/** The OTLP/JSON request body for every batch, with the per-run ids and timestamps removed. */
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

const VARYING = new Set(["traceId", "spanId", "parentSpanId", "startTimeUnixNano", "endTimeUnixNano", "timeUnixNano"]);

function normalized(bytes: Uint8Array[]): string {
  return JSON.stringify(
    bytes.map((chunk) => JSON.parse(new TextDecoder().decode(chunk))),
    (key, value) => (VARYING.has(key) ? undefined : value),
  );
}

async function exported(wrap: (next: SpanProcessor) => SpanProcessor | Promise<SpanProcessor>, secret: string) {
  const exporter = otlpJsonExporter();
  const provider = new BasicTracerProvider({ spanProcessors: [await wrap(new BatchSpanProcessor(exporter))] });
  const tracer = provider.getTracer("adapter-otel-compat-test");
  const span = tracer.startSpan(`deploy ${secret}`);
  span.setAttribute("llm.input_messages", `deploy with token ${secret}`);
  span.setAttribute("llm.tags", ["ok", `tag ${secret}`]);
  span.addEvent("tool_call", { "tool.args": `Bearer ${secret}` });
  span.setStatus({ code: 2, message: `denied for ${secret}` });
  span.end();
  await provider.shutdown();
  return exporter.bytes;
}

test("the injected processor exports the same OTLP bytes through either name", async () => {
  const old = await exported(
    (next) => new published.RedactingSpanProcessorWith(next, fakeScanAndRedact),
    "SECRET_TOKEN_1",
  );
  const current = await exported(
    (next) => new candidate.RedactingSpanProcessorWith(next, fakeScanAndRedact),
    "SECRET_TOKEN_1",
  );

  expect(old.length).toBeGreaterThan(0);
  expect(normalized(old)).toBe(normalized(current));
  expect(normalized(old)).not.toContain("SECRET_TOKEN_1");
  expect(normalized(old)).toContain("deploy with token <SECRET_1>");
});

test("the live factory on the real core exports the same OTLP bytes through either name", async () => {
  const old = await exported((next) => published.createRedactingSpanProcessor(next), SYNTHETIC_GITHUB_TOKEN);
  const current = await exported((next) => candidate.createRedactingSpanProcessor(next), SYNTHETIC_GITHUB_TOKEN);

  expect(old.length).toBeGreaterThan(0);
  expect(normalized(old)).toBe(normalized(current));
  expect(normalized(old)).not.toContain("ghp_SYNTHETIC");
  expect(normalized(old)).toMatch(/deploy with token <SECRET_\d+>/);
});
