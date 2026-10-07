/**
 * The policy action truth table for the OpenTelemetry span processor
 * (redact-secret/redact-secret-adapters#214, `docs/action-semantics.md`): the
 * exact name, attributes and event attributes a real exporter receives for each
 * of allow / warn / redact / block, for a core failure, and for a limit, on the
 * real installed core and a real tracer provider with the legacy callback
 * `policy`. Every expected value is spelled out. Values are synthetic and the
 * credential is built at runtime.
 */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { describe, expect, test } from "vitest";

import { INVALID_POLICY, policyFor, SYNTHETIC_TOKEN, THROWING_POLICY } from "../../../fixtures/action-semantics.js";
import { createRedactingSpanProcessor, type OtelSpanOutcome } from "../src/index.js";

type Options = NonNullable<Parameters<typeof createRedactingSpanProcessor>[1]>;

const T = SYNTHETIC_TOKEN;

async function exportSpan(options: Options): Promise<{
  name: string;
  attributes: unknown;
  eventAttributes: unknown;
  outcome: OtelSpanOutcome | undefined;
}> {
  const exporter = new InMemorySpanExporter();
  let outcome: OtelSpanOutcome | undefined;
  const processor = await createRedactingSpanProcessor(new SimpleSpanProcessor(exporter), {
    ...options,
    onOutcome: (o) => {
      outcome = o;
    },
  });
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const span = provider.getTracer("action-semantics").startSpan(`call ${T}`);
  span.setAttribute("input.value", `x ${T} y`);
  span.setAttribute("clean", "plain");
  span.addEvent("tool", { "tool.args": `token ${T}` });
  span.end();
  await provider.forceFlush();
  const [exported] = exporter.getFinishedSpans();
  if (exported === undefined) throw new Error("no span exported");
  await provider.shutdown();
  return {
    name: exported.name,
    attributes: exported.attributes,
    eventAttributes: exported.events[0]?.attributes,
    outcome,
  };
}

describe("span processor: one finding per string, one policy action", () => {
  test.each([
    // allow and warn leave every string in the exported span.
    ["allow", `call ${T}`, { "input.value": `x ${T} y`, clean: "plain" }, { "tool.args": `token ${T}` }],
    ["warn", `call ${T}`, { "input.value": `x ${T} y`, clean: "plain" }, { "tool.args": `token ${T}` }],
    [
      "redact",
      "call <SECRET_1>",
      { "input.value": "x <SECRET_1> y", clean: "plain" },
      { "tool.args": "token <SECRET_1>" },
    ],
    // block replaces each WHOLE string, not just the matched part.
    [
      "block",
      "[REDACTED:BLOCKED]",
      { "input.value": "[REDACTED:BLOCKED]", clean: "plain" },
      { "tool.args": "[REDACTED:BLOCKED]" },
    ],
  ] as const)("%s", async (action, name, attributes, eventAttributes) => {
    const exported = await exportSpan({ policy: policyFor(action) });
    expect(exported.name).toBe(name);
    expect(exported.attributes).toEqual(attributes);
    expect(exported.eventAttributes).toEqual(eventAttributes);
  });

  test("the outcome counts what each action did; allow and warn are findings with no redaction", async () => {
    const values = async (action: Parameters<typeof policyFor>[0]) =>
      (await exportSpan({ policy: policyFor(action) })).outcome?.values;
    expect(await values("allow")).toEqual({
      scanned: 5,
      findings: 3,
      redacted: 0,
      blocked: 0,
      limited: 0,
      failed: 0,
    });
    expect(await values("warn")).toEqual({ scanned: 5, findings: 3, redacted: 0, blocked: 0, limited: 0, failed: 0 });
    expect(await values("redact")).toEqual({ scanned: 5, findings: 3, redacted: 3, blocked: 0, limited: 0, failed: 0 });
    expect(await values("block")).toEqual({ scanned: 5, findings: 3, redacted: 0, blocked: 3, limited: 0, failed: 0 });
  });
});

describe("span processor: failure and limits never fall back to plaintext", () => {
  test.each([
    ["a throwing policy", THROWING_POLICY],
    ["a policy that returns a non-action", INVALID_POLICY],
  ] as const)("%s is the fixed error marker; the span is still forwarded", async (_name, policy) => {
    const exported = await exportSpan({ policy });
    expect(exported.name).toBe("[REDACTED:ERROR]");
    expect(exported.attributes).toEqual({ "input.value": "[REDACTED:ERROR]", clean: "plain" });
    expect(exported.eventAttributes).toEqual({ "tool.args": "[REDACTED:ERROR]" });
    expect(exported.outcome?.values.failed).toBe(3);
    expect(exported.outcome?.dropped).toBe(false);
  });

  test("a string past maxStringLength is the limit marker and is not scanned", async () => {
    const exported = await exportSpan({ maxStringLength: 12 });
    expect(exported.name).toBe("[REDACTED:LIMIT_EXCEEDED]");
    expect(exported.attributes).toEqual({ "input.value": "[REDACTED:LIMIT_EXCEEDED]", clean: "plain" });
    expect(exported.outcome?.values).toMatchObject({ limited: 3, scanned: 2 });
  });

  test("the per-span budget: strings it did not allow to be inspected are the limit marker", async () => {
    const exported = await exportSpan({ operationLimits: { maxScans: 1 } });
    expect(JSON.stringify(exported)).not.toContain(T);
    expect(exported.outcome?.values.limited).toBeGreaterThan(0);
  });
});

describe("span processor: observation mode", () => {
  test("warn everywhere changes nothing in the exported span and counts every finding", async () => {
    const exported = await exportSpan({ policy: policyFor("warn") });
    expect(exported.outcome?.values).toEqual({
      scanned: 5,
      findings: 3,
      redacted: 0,
      blocked: 0,
      limited: 0,
      failed: 0,
    });
    expect(exported.name).toBe(`call ${T}`);
  });
});
