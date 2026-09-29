/**
 * Coexistence with `@redact-secret/vault`
 * (redact-secret/redact-secret-adapters#52), on the **real installed core**
 * and a real OpenTelemetry pipeline.
 *
 * A span carries the same text a host captured on the way to a model. If the
 * span processor rewrote a `<rsv_…>` token, the exported span would disagree
 * with what the application still holds a mapping for, and nothing would
 * report it. The vault is not a dependency of this repository; the shape of
 * its token is what is pinned. Every byte of the shared fixture's adversarial
 * contexts must reach the exporter unchanged.
 */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { expect, test } from "vitest";

import { VAULT_TOKEN, VAULT_TOKEN_CONTEXTS } from "../../../fixtures/vault-token.js";
import { createRedactingSpanProcessor } from "../src/index.js";

test("every adversarial context reaches the exporter byte for byte", async () => {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [await createRedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
  });
  const tracer = provider.getTracer("adapter-otel-vault-token-test");

  for (const { name, text } of VAULT_TOKEN_CONTEXTS) {
    const span = tracer.startSpan(text);
    span.setAttribute("input.value", text);
    span.setAttribute("input.values", [text, text]);
    span.addEvent(name, { "tool.args": text });
    span.end();
  }
  await provider.forceFlush();

  const exported = exporter.getFinishedSpans();
  expect(exported.map((span) => span.name)).toEqual(VAULT_TOKEN_CONTEXTS.map((context) => context.text));
  for (const [index, span] of exported.entries()) {
    const { text } = VAULT_TOKEN_CONTEXTS[index] as { text: string };
    expect(span.attributes).toEqual({ "input.value": text, "input.values": [text, text] });
    expect(span.events[0]?.attributes).toEqual({ "tool.args": text });
  }
  await provider.shutdown();
});

test("a token is left alone even under a policy that blocks every finding", async () => {
  // A `block` policy replaces the whole field, so a token the core did report
  // on would be exported as a marker. It does not report on one.
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [
      await createRedactingSpanProcessor(new SimpleSpanProcessor(exporter), {
        policy: { evaluate: () => "block" },
      }),
    ],
  });
  const span = provider.getTracer("adapter-otel-vault-token-test").startSpan(`call ${VAULT_TOKEN}`);
  span.setAttribute("input.value", `Authorization: Bearer ${VAULT_TOKEN}`);
  span.end();
  await provider.forceFlush();

  const [exported] = exporter.getFinishedSpans();
  expect(exported?.name).toBe(`call ${VAULT_TOKEN}`);
  expect(exported?.attributes).toEqual({ "input.value": `Authorization: Bearer ${VAULT_TOKEN}` });
  await provider.shutdown();
});
