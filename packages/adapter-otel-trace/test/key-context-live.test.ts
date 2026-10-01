/**
 * Key-aware detection for span attributes with the real core and a real SDK
 * span (redact-secret-adapters#172). An attribute name is the direct string
 * key of its value; the span name, event names, the status message and the
 * elements of an array attribute have none. CI runs this at both ends of the
 * declared core and SDK ranges.
 */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { expect, test } from "vitest";

import { expectedLeaf, loadKeyContextCases } from "../../../fixtures/key-context.js";
import { createRedactingSpanProcessor } from "../src/index.js";

const cases = loadKeyContextCases();
const LEAF = "synthetic-example-value-0001";

async function exportOne(
  fill: (span: ReturnType<ReturnType<BasicTracerProvider["getTracer"]>["startSpan"]>) => void,
  options: Parameters<typeof createRedactingSpanProcessor>[1] = {},
) {
  const exporter = new InMemorySpanExporter();
  const processor = await createRedactingSpanProcessor(new SimpleSpanProcessor(exporter), options);
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const span = provider.getTracer("key-context-test").startSpan("operation");
  fill(span);
  span.end();
  await provider.forceFlush();
  const [exported] = exporter.getFinishedSpans();
  await provider.shutdown();
  if (exported === undefined) throw new Error("no span exported");
  return exported;
}

test.each(cases)("$id: span, event and link attributes agree with the other adapters", async (testCase) => {
  const { key, value } = testCase;
  const exported = await exportOne((span) => {
    span.setAttribute(key, value);
    span.addEvent("e", { [key]: value });
    span.addLink({
      context: { traceId: `${"0".repeat(31)}1`, spanId: `${"0".repeat(15)}1`, traceFlags: 1 },
      attributes: { [key]: value },
    });
  });
  const expected = expectedLeaf(testCase);
  expect(exported.attributes[key]).toBe(expected);
  expect(exported.events[0]?.attributes?.[key]).toBe(expected);
  expect(exported.links[0]?.attributes?.[key]).toBe(expected);
});

test("a benign sibling attribute is untouched and string-array elements get no key context", async () => {
  const exported = await exportOne((span) => {
    span.setAttribute("api_key", LEAF);
    span.setAttribute("name", LEAF);
    span.setAttribute("password", [LEAF, LEAF]);
    span.setAttribute("count", 3);
  });
  expect(exported.attributes).toEqual({ api_key: "<SECRET_1>", name: LEAF, password: [LEAF, LEAF], count: 3 });
});

test("the span name and the status message are not under a key", async () => {
  const exported = await exportOne((span) => {
    span.updateName(LEAF);
    span.setStatus({ code: 2, message: LEAF });
  });
  expect(exported.name).toBe(LEAF);
  expect(exported.status.message).toBe(LEAF);
});

test.each([
  ["block", "[REDACTED:BLOCKED]"],
  ["warn", LEAF],
  ["allow", LEAF],
] as const)("policy %s applies to a key-context finding", async (action, expected) => {
  const exported = await exportOne((span) => span.setAttribute("api_key", LEAF), {
    policy: { evaluate: () => action },
  });
  expect(exported.attributes.api_key).toBe(expected);
});

test("a throwing policy never leaks the value or the error's message", async () => {
  const exported = await exportOne((span) => span.setAttribute("api_key", LEAF), {
    policy: {
      evaluate: () => {
        throw new Error(LEAF);
      },
    },
  });
  expect(exported.attributes.api_key).toBe("[REDACTED:ERROR]");
});
