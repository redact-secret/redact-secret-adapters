/**
 * Exercises the live wrapper against the real installed core and a real
 * SDK pipeline: `initialize()` order, and that a secret the real core
 * detects is actually masked before export, so a processor that passed the
 * span through would fail. The token is synthetic and built at runtime.
 */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { expect, test } from "vitest";

import { createRedactingSpanProcessor } from "../src/index.js";

const SYNTHETIC_GITHUB_TOKEN = `ghp_${"x".repeat(36)}`;

test("createRedactingSpanProcessor masks a synthetic token with the real core before export", async () => {
  const exporter = new InMemorySpanExporter();
  const processor = await createRedactingSpanProcessor(new SimpleSpanProcessor(exporter), {
    policy: { evaluate: (finding) => (finding.type === "github_token" ? "block" : "redact") },
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });

  const span = provider.getTracer("adapter-otel-live-test").startSpan(`call ${SYNTHETIC_GITHUB_TOKEN}`);
  span.setAttribute("input.value", "plain text");
  span.addEvent("tool", { "tool.args": `token ${SYNTHETIC_GITHUB_TOKEN}` });
  span.end();
  await provider.forceFlush();

  const [exported] = exporter.getFinishedSpans();
  // The custom policy reached the real core: its "block" replaces the whole field.
  expect(exported?.name).toBe("[REDACTED:BLOCKED]");
  expect(exported?.attributes).toEqual({ "input.value": "plain text" });
  expect(exported?.events[0]?.attributes).toEqual({ "tool.args": "[REDACTED:BLOCKED]" });
  await provider.shutdown();
});
