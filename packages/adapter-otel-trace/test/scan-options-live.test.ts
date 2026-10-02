/**
 * The verified scan options through a real SDK span and the real core
 * (redact-secret-adapters#175). CI runs this at both ends of the declared core
 * and SDK ranges.
 */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { CoreOptionsError } from "@redact-secret/adapter";
import { expect, test } from "vitest";

import { BROKEN_RULESET, SYNTHETIC_RULESET, SYNTHETIC_TOKEN } from "../../../fixtures/scan-options.js";
import { createRedactingSpanProcessor } from "../src/index.js";

async function exportOne(
  options: Parameters<typeof createRedactingSpanProcessor>[1],
  fill: (span: ReturnType<ReturnType<BasicTracerProvider["getTracer"]>["startSpan"]>) => void,
) {
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [await createRedactingSpanProcessor(new SimpleSpanProcessor(exporter), options)],
  });
  const span = provider.getTracer("scan-options-test").startSpan("operation");
  fill(span);
  span.end();
  await provider.forceFlush();
  const [exported] = exporter.getFinishedSpans();
  await provider.shutdown();
  if (exported === undefined) throw new Error("no span exported");
  return exported;
}

test("a ruleset, a formatter and a policy apply to attributes and events", async () => {
  const exported = await exportOne(
    {
      ruleset: SYNTHETIC_RULESET,
      policy: { evaluate: () => "redact" },
      placeholderFormatter: (finding, context) => `[${finding.type}#${context.placeholderIndex}]`,
    },
    (span) => {
      span.setAttribute("note", `value ${SYNTHETIC_TOKEN}`);
      span.addEvent("e", { detail: SYNTHETIC_TOKEN });
    },
  );
  expect(exported.attributes.note).toMatch(/^value \[[a-z_-]+#1\]$/);
  expect(exported.events[0]?.attributes?.detail).toMatch(/^\[[a-z_-]+#1\]$/);
});

test("by default a ruleset finding is only warned on; the policy decides otherwise", async () => {
  const byDefault = await exportOne({ ruleset: SYNTHETIC_RULESET }, (span) =>
    span.setAttribute("note", SYNTHETIC_TOKEN),
  );
  expect(byDefault.attributes.note).toBe(SYNTHETIC_TOKEN);
  const blocked = await exportOne({ ruleset: SYNTHETIC_RULESET, policy: { evaluate: () => "block" } }, (span) =>
    span.setAttribute("note", SYNTHETIC_TOKEN),
  );
  expect(blocked.attributes.note).toBe("[REDACTED:BLOCKED]");
});

test("scanLimits are the core's per-scan ceilings: a value past them is the error marker", async () => {
  const exported = await exportOne({ scanLimits: { maxInputBytes: 64, maxFindings: 2 } }, (span) =>
    span.setAttribute("big", "z".repeat(200)),
  );
  expect(exported.attributes.big).toBe("[REDACTED:ERROR]");
});

test("a rejected ruleset fails construction with a fixed error", async () => {
  const error = await createRedactingSpanProcessor({ onEnd() {}, shutdown: () => Promise.resolve() } as never, {
    ruleset: BROKEN_RULESET,
  }).then(
    () => undefined,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(CoreOptionsError);
  expect((error as CoreOptionsError).coreCode).toBe("INVALID_RULESET");
});
