/**
 * The declarative `actionPolicy` through a real tracer provider and the real
 * core (redact-secret-adapters#217): the exact name, attributes and event
 * attributes a real exporter receives for each action, equal to the same
 * action as a callback policy (`action-semantics-live.test.ts`, #214), and
 * unchanged by a later mutation of the caller's document. Below the verified
 * core floor the option is rejected explicitly. Values are synthetic.
 */

import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { CoreOptionsError } from "@redact-secret/adapter";
import { describe, expect, test } from "vitest";

import {
  actionPolicyForms,
  CORE_HAS_ACTION_POLICY,
  MALFORMED_MARKER,
  MALFORMED_POLICY,
  UNMATCHED_POLICY,
} from "../../../fixtures/action-policy.js";
import { SYNTHETIC_TOKEN } from "../../../fixtures/action-semantics.js";
import { createRedactingSpanProcessor } from "../src/index.js";

type Options = NonNullable<Parameters<typeof createRedactingSpanProcessor>[1]>;

const T = SYNTHETIC_TOKEN;

async function exportSpan(options: Options) {
  const exporter = new InMemorySpanExporter();
  const processor = await createRedactingSpanProcessor(new SimpleSpanProcessor(exporter), options);
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const span = provider.getTracer("action-policy").startSpan(`call ${T}`);
  span.setAttribute("input.value", `x ${T} y`);
  span.setAttribute("clean", "plain");
  span.addEvent("tool", { "tool.args": `token ${T}` });
  span.end();
  await provider.forceFlush();
  const [exported] = exporter.getFinishedSpans();
  if (exported === undefined) throw new Error("no span exported");
  await provider.shutdown();
  return { name: exported.name, attributes: exported.attributes, eventAttributes: exported.events[0]?.attributes };
}

const KEPT = {
  name: `call ${T}`,
  attributes: { "input.value": `x ${T} y`, clean: "plain" },
  eventAttributes: { "tool.args": `token ${T}` },
};
const REDACTED = {
  name: "call <SECRET_1>",
  attributes: { "input.value": "x <SECRET_1> y", clean: "plain" },
  eventAttributes: { "tool.args": "token <SECRET_1>" },
};
const BLOCKED = {
  name: "[REDACTED:BLOCKED]",
  attributes: { "input.value": "[REDACTED:BLOCKED]", clean: "plain" },
  eventAttributes: { "tool.args": "[REDACTED:BLOCKED]" },
};

describe.skipIf(!CORE_HAS_ACTION_POLICY)("a core with actionPolicy", () => {
  test.each([
    ["allow", KEPT],
    ["warn", KEPT],
    ["redact", REDACTED],
    ["block", BLOCKED],
    ["default", REDACTED],
  ] as const)("%s: the exported span, from an object, text and bytes", async (action, expected) => {
    const forms = actionPolicyForms(action);
    for (const actionPolicy of [forms.object, forms.text, forms.bytes]) {
      expect(await exportSpan({ actionPolicy })).toEqual(expected);
    }
  });

  test("a finding no rule matches keeps the default action", async () => {
    expect(await exportSpan({ actionPolicy: UNMATCHED_POLICY })).toEqual(REDACTED);
  });

  test("it is a snapshot: a later mutation of the document changes nothing", async () => {
    const object = structuredClone(actionPolicyForms("warn").object);
    const exporter = new InMemorySpanExporter();
    const processor = await createRedactingSpanProcessor(new SimpleSpanProcessor(exporter), { actionPolicy: object });
    (object.rules[0] as { action: string }).action = "block";
    const provider = new BasicTracerProvider({ spanProcessors: [processor] });
    provider.getTracer("t").startSpan(`call ${T}`).end();
    await provider.forceFlush();
    expect(exporter.getFinishedSpans()[0]?.name).toBe(`call ${T}`);
  });

  test("a malformed policy rejects with INVALID_ACTION_POLICY and nothing of the document", async () => {
    const error = await createRedactingSpanProcessor(new SimpleSpanProcessor(new InMemorySpanExporter()), {
      actionPolicy: MALFORMED_POLICY,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CoreOptionsError);
    expect((error as CoreOptionsError).coreCode).toBe("INVALID_ACTION_POLICY");
    expect(JSON.stringify({ ...(error as object), message: (error as Error).message })).not.toContain(MALFORMED_MARKER);
  });

  test("a callback policy beside an actionPolicy rejects before the core is touched", async () => {
    await expect(
      createRedactingSpanProcessor(new SimpleSpanProcessor(new InMemorySpanExporter()), {
        policy: { evaluate: () => "redact" },
        actionPolicy: actionPolicyForms("warn").object,
      }),
    ).rejects.toThrow("mutually exclusive");
  });
});

describe.skipIf(CORE_HAS_ACTION_POLICY)("a core older than actionPolicy", () => {
  test("a requested actionPolicy is rejected by name; the callback policy still works", async () => {
    const error = await exportSpan({ actionPolicy: actionPolicyForms("block").object }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as CoreOptionsError).code).toBe("CORE_OPTION_UNSUPPORTED");
    expect((error as CoreOptionsError).options).toEqual(["actionPolicy"]);
    expect(await exportSpan({ policy: { evaluate: () => "block" } })).toEqual(BLOCKED);
  });
});
