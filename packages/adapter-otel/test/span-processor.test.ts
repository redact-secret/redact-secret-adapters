/**
 * Structural tests: plain objects stand in for the SDK's span and
 * processor types, proving the adapter needs nothing but the shape.
 * `./otel-host.test.ts` is the real-host counterpart.
 */

import type { ReadableSpan, Span, SpanProcessor } from "@opentelemetry/sdk-trace-base";
import type { ScanAndRedact } from "@redact-secret/adapter";
import { expect, test, vi } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import {
  type MaskLeafOptions,
  type RedactAttributesOptions,
  RedactingSpanProcessorWith,
  redactAttributesWith,
} from "../src/index.js";

interface PlainSpan {
  name?: string;
  attributes: Record<string, unknown>;
  events: { name?: string; attributes: Record<string, unknown> }[];
  status?: { code: number; message?: string };
  links?: { context: object; attributes?: Record<string, unknown> }[];
}

function fakeNextProcessor(exported: PlainSpan[]) {
  const started: { span: unknown; parentContext: unknown }[] = [];
  const next = {
    onStart(span: unknown, parentContext: unknown) {
      started.push({ span, parentContext });
    },
    onEnd(span: unknown) {
      exported.push(span as PlainSpan);
    },
    shutdown() {
      return Promise.resolve("shutdown");
    },
    forceFlush() {
      return Promise.resolve("flushed");
    },
  };
  return { started, next: next as unknown as SpanProcessor };
}

const asSpan = (span: PlainSpan) => span as unknown as ReadableSpan;

test("redacts string and string-array span and event attributes; no plaintext reaches the exporter", () => {
  const exported: PlainSpan[] = [];
  const processor = new RedactingSpanProcessorWith(fakeNextProcessor(exported).next, fakeScanAndRedact);

  const span: PlainSpan = {
    attributes: {
      "llm.input_messages": "call SECRET_TOKEN_1 now",
      "llm.tags": ["ok", "BLOCK_ME here"],
      "retry.count": 3,
      "retry.ok": true,
    },
    events: [{ name: "tool_call", attributes: { "tool.args": "value SECRET_TOKEN_2 done" } }],
  };

  processor.onEnd(asSpan(span));

  expect(exported.length).toBe(1);
  expect(exported[0]?.attributes["llm.input_messages"]).toBe("call <SECRET_1> now");
  expect(exported[0]?.attributes["llm.tags"]).toEqual(["ok", "[REDACTED:BLOCKED]"]);
  expect(exported[0]?.attributes["retry.count"]).toBe(3);
  expect(exported[0]?.attributes["retry.ok"]).toBe(true);
  expect(exported[0]?.events[0]?.attributes["tool.args"]).toBe("value <SECRET_1> done");

  const serialized = JSON.stringify(exported);
  expect(serialized).not.toContain("SECRET_TOKEN_1");
  expect(serialized).not.toContain("SECRET_TOKEN_2");
  expect(serialized).not.toContain("BLOCK_ME");
});

test("a string array with null or undefined holes has every string masked and the holes kept", () => {
  const attributes = { tags: ["SECRET_TOKEN_1", null, "plain", undefined, "BLOCK_ME"] };
  redactAttributesWith(fakeScanAndRedact, attributes);
  expect(attributes.tags).toEqual(["<SECRET_1>", null, "plain", undefined, "[REDACTED:BLOCKED]"]);
});

test("span name, event names, status message, and link attributes are redacted", () => {
  const exported: PlainSpan[] = [];
  const processor = new RedactingSpanProcessorWith(fakeNextProcessor(exported).next, fakeScanAndRedact);

  processor.onEnd(
    asSpan({
      name: "GET /reset?token=SECRET_TOKEN_1",
      attributes: {},
      events: [{ name: "retry with SECRET_TOKEN_2", attributes: {} }],
      status: { code: 2, message: "denied for SECRET_TOKEN_3" },
      links: [{ context: {}, attributes: { "peer.auth": "Bearer SECRET_TOKEN_4" } }, { context: {} }],
    }),
  );

  const [span] = exported;
  expect(span?.name).toBe("GET /reset?token=<SECRET_1>");
  expect(span?.events[0]?.name).toBe("retry with <SECRET_1>");
  expect(span?.status).toEqual({ code: 2, message: "denied for <SECRET_1>" });
  expect(span?.links).toEqual([{ context: {}, attributes: { "peer.auth": "Bearer <SECRET_1>" } }, { context: {} }]);
  expect(JSON.stringify(exported)).not.toMatch(/SECRET_TOKEN_\d/);
});

test("a core failure on one attribute fails closed without throwing into the SDK", () => {
  const exported: PlainSpan[] = [];
  const processor = new RedactingSpanProcessorWith(fakeNextProcessor(exported).next, fakeScanAndRedact);

  processor.onEnd(asSpan({ attributes: { boom: "trigger BOOM here" }, events: [] }));

  expect(exported[0]?.attributes.boom).toBe("[REDACTED:ERROR]");
  expect(JSON.stringify(exported)).not.toContain("BOOM");
});

test("a span whose fields cannot take the masked write is dropped with one warning, never exported or thrown", () => {
  const emit = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  try {
    const exported: PlainSpan[] = [];
    const processor = new RedactingSpanProcessorWith(fakeNextProcessor(exported).next, fakeScanAndRedact);
    const frozen = () =>
      asSpan({ attributes: Object.freeze({ key: "SECRET_TOKEN_1" }), events: [] } as unknown as PlainSpan);
    const ignoresWrites = asSpan({
      get name() {
        return "GET SECRET_TOKEN_2";
      },
      set name(_value: string) {},
      attributes: {},
      events: [],
    } as unknown as PlainSpan);

    expect(() => processor.onEnd(frozen())).not.toThrow();
    expect(() => processor.onEnd(ignoresWrites)).not.toThrow();
    expect(() => processor.onEnd(frozen())).not.toThrow();

    expect(exported).toEqual([]);
    expect(emit).toHaveBeenCalledTimes(1);
    const [message] = emit.mock.calls[0] ?? [];
    expect(String(message)).toContain("span.attributes");
    expect(String(message)).not.toMatch(/SECRET_TOKEN_\d/);
  } finally {
    emit.mockRestore();
  }
});

test("a frozen bag with nothing to mask is exported unchanged", () => {
  const exported: PlainSpan[] = [];
  const processor = new RedactingSpanProcessorWith(fakeNextProcessor(exported).next, fakeScanAndRedact);
  processor.onEnd(asSpan({ attributes: Object.freeze({ key: "plain" }), events: [] }));
  expect(exported).toHaveLength(1);
});

test("the status is replaced, not mutated, so a caller's status object keeps its text", () => {
  const exported: PlainSpan[] = [];
  const processor = new RedactingSpanProcessorWith(fakeNextProcessor(exported).next, fakeScanAndRedact);
  const status = Object.freeze({ code: 2, message: "denied for SECRET_TOKEN_1" });
  processor.onEnd(asSpan({ attributes: {}, events: [], status }));
  expect(exported[0]?.status).toEqual({ code: 2, message: "denied for <SECRET_1>" });
  expect(exported[0]?.status).not.toBe(status);
});

test("redactAttributesWith throws a TypeError naming no value when it cannot write back", () => {
  const frozen = Object.freeze({ key: "SECRET_TOKEN_1" });
  expect(() => redactAttributesWith(fakeScanAndRedact, frozen)).toThrow(TypeError);
  try {
    redactAttributesWith(fakeScanAndRedact, frozen);
  } catch (error) {
    expect(String(error)).not.toContain("SECRET_TOKEN_1");
  }
});

test("the policy option reaches scanAndRedact for every field", () => {
  const policy = { evaluate: () => "redact" as const };
  const seen: unknown[] = [];
  const spy: ScanAndRedact = (text, options) => {
    seen.push(options?.policy);
    return { text, findings: [] };
  };
  const processor = new RedactingSpanProcessorWith(fakeNextProcessor([]).next, spy, { policy });
  processor.onEnd(asSpan({ name: "n", attributes: { a: "x" }, events: [{ name: "e", attributes: { b: "y" } }] }));
  expect(seen).toEqual([policy, policy, policy, policy]);
});

test("onStart, shutdown, and forceFlush delegate to the wrapped processor", async () => {
  const { started, next } = fakeNextProcessor([]);
  const processor = new RedactingSpanProcessorWith(next, fakeScanAndRedact);

  processor.onStart("span-1" as unknown as Span, "ctx-1" as unknown as Parameters<SpanProcessor["onStart"]>[1]);
  expect(started).toEqual([{ span: "span-1", parentContext: "ctx-1" }]);
  expect(await processor.shutdown()).toBe("shutdown");
  expect(await processor.forceFlush()).toBe("flushed");
});

test("onEnding is forwarded when the wrapped processor has it, and a no-op when it does not", () => {
  const ending: unknown[] = [];
  const { next } = fakeNextProcessor([]);
  const withHook = Object.assign(next, { onEnding: (span: unknown) => ending.push(span) });
  new RedactingSpanProcessorWith(withHook, fakeScanAndRedact).onEnding("span-1" as unknown as Span);
  expect(ending).toEqual(["span-1"]);

  const without = new RedactingSpanProcessorWith(fakeNextProcessor([]).next, fakeScanAndRedact);
  expect(() => without.onEnding("span-2" as unknown as Span)).not.toThrow();
});

test("the deprecated RedactAttributesOptions alias still typechecks as MaskLeafOptions", () => {
  const options: RedactAttributesOptions = { maxStringLength: 5 };
  const same: MaskLeafOptions = options;
  const attributes = { long: "SECRET_TOKEN_1" };
  redactAttributesWith(fakeScanAndRedact, attributes, same);
  expect(attributes.long).toBe("[REDACTED:LIMIT_EXCEEDED]");
});

test("redactAttributesWith is a no-op for undefined or null attributes", () => {
  expect(() => redactAttributesWith(fakeScanAndRedact, undefined)).not.toThrow();
  expect(() => redactAttributesWith(fakeScanAndRedact, null)).not.toThrow();
});

test("rejects a next processor without onEnd, or a non-function scanAndRedact", () => {
  expect(() => new RedactingSpanProcessorWith({} as SpanProcessor, fakeScanAndRedact)).toThrow(TypeError);
  expect(() => new RedactingSpanProcessorWith(fakeNextProcessor([]).next, null as unknown as ScanAndRedact)).toThrow(
    TypeError,
  );
});
