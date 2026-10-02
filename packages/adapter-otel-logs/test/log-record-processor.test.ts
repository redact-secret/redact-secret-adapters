/**
 * The processor over plain objects shaped like the SDK's record, with the
 * deterministic fake scanner. `./otel-host.test.ts` and
 * `./exporter-bytes.test.ts` are the real-SDK counterparts; this file pins the
 * decisions that need a record the real SDK will not build for us: a record
 * that is read-only, cyclic, hostile or oddly typed.
 *
 * Every secret is the fake scanner's magic string, built at runtime.
 */

import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { afterEach, expect, test, vi } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { type OtelLogRecordOutcome, RedactingLogRecordProcessorWith } from "../src/index.js";

interface RecordLike {
  body?: unknown;
  severityText?: unknown;
  eventName?: unknown;
  attributes: Record<string, unknown>;
  setBody?: (body: unknown) => unknown;
  setSeverityText?: (text: unknown) => unknown;
  setEventName?: (name: unknown) => unknown;
}

/** A record with the SDK's writers. */
function recordLike(fields: Partial<RecordLike> = {}): RecordLike {
  const record: RecordLike = {
    attributes: {},
    ...fields,
    setBody(body) {
      record.body = body;
      return record;
    },
    setSeverityText(text) {
      record.severityText = text;
      return record;
    },
    setEventName(name) {
      record.eventName = name;
      return record;
    },
  };
  return record;
}

function harness(options: ConstructorParameters<typeof RedactingLogRecordProcessorWith>[2] = {}) {
  const forwarded: RecordLike[] = [];
  const outcomes: OtelLogRecordOutcome[] = [];
  const next = {
    onEmit: (record: RecordLike) => void forwarded.push(record),
    forceFlush: async () => {},
    shutdown: async () => {},
  } as unknown as LogRecordProcessor;
  const processor = new RedactingLogRecordProcessorWith(next, fakeScanAndRedact, {
    ...options,
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  const emit = (record: RecordLike) => processor.onEmit(record as never);
  return { processor, forwarded, outcomes, emit };
}

afterEach(() => {
  vi.restoreAllMocks();
});

test("a string body, severity text and attribute values are redacted before the next processor", () => {
  const { forwarded, emit } = harness();
  emit(
    recordLike({
      body: "deploy SECRET_TOKEN_1 now",
      severityText: "ERROR SECRET_TOKEN_2",
      attributes: { "http.url": "https://x.test/?t=SECRET_TOKEN_3", "retry.count": 3, ok: true },
    }),
  );

  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]?.body).toBe("deploy <SECRET_1> now");
  expect(forwarded[0]?.severityText).toBe("ERROR <SECRET_1>");
  expect(forwarded[0]?.attributes).toEqual({ "http.url": "https://x.test/?t=<SECRET_1>", "retry.count": 3, ok: true });
});

test("a structured body is walked: nested maps, arrays, and every string leaf", () => {
  const { forwarded, emit } = harness();
  emit(
    recordLike({
      body: {
        event: "login",
        credentials: { user: "alice", token: "SECRET_TOKEN_1" },
        history: ["ok", "SECRET_TOKEN_2", 7, null, { deeper: ["SECRET_TOKEN_3"] }],
      },
    }),
  );

  expect(forwarded[0]?.body).toEqual({
    event: "login",
    credentials: { user: "alice", token: "<SECRET_1>" },
    history: ["ok", "<SECRET_1>", 7, null, { deeper: ["<SECRET_1>"] }],
  });
});

test("an unchanged body and unchanged attributes are not rewritten", () => {
  const setBody = vi.fn();
  const body = { a: ["plain"], b: 1 };
  const attributes = { k: "plain", list: ["a", "b"] };
  const record = { body, attributes, setBody } as unknown as RecordLike;
  const { forwarded, emit } = harness();
  emit(record);

  expect(setBody).not.toHaveBeenCalled();
  expect(forwarded[0]?.body).toBe(body);
  expect(forwarded[0]?.attributes).toBe(attributes);
});

test("array attribute values keep non-string elements in place", () => {
  const { forwarded, emit } = harness();
  emit(recordLike({ attributes: { tags: ["SECRET_TOKEN_1", null, 4, true, "x"] } }));
  expect(forwarded[0]?.attributes.tags).toEqual(["<SECRET_1>", null, 4, true, "x"]);
});

test("a byte body is scanned as UTF-8 text, and unchanged bytes keep their identity", () => {
  const { forwarded, emit } = harness();
  const clean = new TextEncoder().encode("nothing to see");
  emit(recordLike({ body: new TextEncoder().encode("token SECRET_TOKEN_1 here") }));
  emit(recordLike({ body: clean }));

  expect(new TextDecoder().decode(forwarded[0]?.body as Uint8Array)).toBe("token <SECRET_1> here");
  expect(forwarded[1]?.body).toBe(clean);
});

test("bytes that are not UTF-8 text cannot be scanned, so they are replaced, not exported opaque", () => {
  const { forwarded, outcomes, emit } = harness();
  emit(recordLike({ body: new Uint8Array([0xff, 0xfe, 0xfd]) }));

  expect(new TextDecoder().decode(forwarded[0]?.body as Uint8Array)).toBe("[REDACTED:ERROR]");
  expect(outcomes[0]?.values.failed).toBe(1);
});

test("bytes nested in a map or array are scanned too", () => {
  const { forwarded, emit } = harness();
  emit(recordLike({ body: { raw: [new TextEncoder().encode("SECRET_TOKEN_9")] } }));
  const body = forwarded[0]?.body as { raw: Uint8Array[] } | undefined;
  expect(new TextDecoder().decode(body?.raw[0])).toBe("<SECRET_1>");
});

test("Unicode survives, and a secret inside it is still found", () => {
  const { forwarded, emit } = harness();
  emit(
    recordLike({
      body: "배포 완료 \u{1F680} SECRET_TOKEN_1 — naïve café",
      attributes: { 메모: "비밀 SECRET_TOKEN_2 \u0000" },
    }),
  );
  expect(forwarded[0]?.body).toBe("배포 완료 \u{1F680} <SECRET_1> — naïve café");
  expect(forwarded[0]?.attributes).toEqual({ 메모: "비밀 <SECRET_1> \u0000" });
});

test("an Error in the body is walked as { type, message, stack }", () => {
  const { forwarded, emit } = harness();
  const error = new Error("failed with SECRET_TOKEN_1");
  error.stack = "Error: failed\n    at SECRET_TOKEN_2";
  emit(recordLike({ body: error }));

  expect(forwarded[0]?.body).toEqual({
    type: "Error",
    message: "failed with <SECRET_1>",
    stack: "Error: failed\n    at <SECRET_1>",
  });
});

test("a toJSON is applied rather than left to run at serialization time", () => {
  const { forwarded, emit } = harness();
  emit(recordLike({ body: { toJSON: () => ({ leaked: "SECRET_TOKEN_1" }) } }));
  expect(forwarded[0]?.body).toEqual({ leaked: "<SECRET_1>" });
});

test("a block finding replaces the whole value, and a scanner error is the error marker", () => {
  const { forwarded, outcomes, emit } = harness();
  emit(recordLike({ body: "line one BLOCK_ME line two", attributes: { a: "BOOM", b: ["BOOM"] } }));

  expect(forwarded[0]?.body).toBe("[REDACTED:BLOCKED]");
  expect(forwarded[0]?.attributes).toEqual({ a: "[REDACTED:ERROR]", b: ["[REDACTED:ERROR]"] });
  expect(outcomes[0]?.values).toMatchObject({ blocked: 1, failed: 2, redacted: 0 });
  // The error text the fake scanner throws never reaches the record.
  expect(JSON.stringify(forwarded)).not.toContain("simulated core failure");
});

test("a malformed scanner result fails closed", () => {
  const forwarded: RecordLike[] = [];
  const next = { onEmit: (r: RecordLike) => forwarded.push(r), forceFlush: async () => {}, shutdown: async () => {} };
  const processor = new RedactingLogRecordProcessorWith(
    next as unknown as LogRecordProcessor,
    (() => ({ nope: true })) as never,
  );
  processor.onEmit(recordLike({ body: "SECRET_TOKEN_1" }) as never);
  expect(forwarded[0]?.body).toBe("[REDACTED:ERROR]");
});

test("a string past maxStringLength is limited unscanned", () => {
  const scan = vi.fn(fakeScanAndRedact);
  const forwarded: RecordLike[] = [];
  const next = { onEmit: (r: RecordLike) => forwarded.push(r), forceFlush: async () => {}, shutdown: async () => {} };
  const processor = new RedactingLogRecordProcessorWith(next as unknown as LogRecordProcessor, scan, {
    maxStringLength: 8,
  });
  processor.onEmit(recordLike({ body: "SECRET_TOKEN_1 is long" }) as never);
  expect(forwarded[0]?.body).toBe("[REDACTED:LIMIT_EXCEEDED]");
  expect(scan).not.toHaveBeenCalled();
});

test("the leaf budget is shared across the body and every attribute of one record", () => {
  const { forwarded, outcomes, emit } = harness({ limits: { maxTotalLeaves: 3 } });
  emit(recordLike({ body: ["a", "b"], attributes: { x: "SECRET_TOKEN_1", y: "SECRET_TOKEN_2" } }));

  expect(forwarded[0]?.body).toEqual(["a", "b"]);
  expect(forwarded[0]?.attributes).toEqual({ x: "<SECRET_1>", y: "[REDACTED:LIMIT_EXCEEDED]" });
  expect(outcomes[0]?.values.limited).toBe(1);

  // A new record gets a new budget.
  emit(recordLike({ body: "SECRET_TOKEN_1" }));
  expect(forwarded[1]?.body).toBe("<SECRET_1>");
});

test("depth, array length, key count and node budgets replace, never pass through", () => {
  const { forwarded, emit } = harness({ limits: { maxDepth: 2, maxArrayLength: 2, maxObjectKeys: 2 } });
  emit(
    recordLike({
      body: {
        a: { b: { c: "SECRET_TOKEN_1" } },
        list: ["one", "two", "SECRET_TOKEN_2"],
        k3: "x",
      },
    }),
  );

  const body = forwarded[0]?.body as Record<string, unknown>;
  expect(JSON.stringify(body)).not.toContain("SECRET_TOKEN");
  expect(body.a).toEqual({ b: "[REDACTED:LIMIT_EXCEEDED]" });
  expect(body.list).toEqual(["one", "two"]);
  expect(Object.keys(body)).toEqual(["a", "list"]);
});

test("a cyclic body becomes a marker and does not recurse forever", () => {
  const { forwarded, outcomes, emit } = harness();
  const body: Record<string, unknown> = { name: "SECRET_TOKEN_1" };
  body.self = body;
  emit(recordLike({ body }));

  expect(forwarded[0]?.body).toEqual({ name: "<SECRET_1>", self: "[REDACTED:CYCLE]" });
  expect(outcomes[0]?.values.failed).toBe(1);
});

test("a throwing getter is the error marker for that value alone", () => {
  const { forwarded, emit } = harness();
  const body = {
    ok: "SECRET_TOKEN_1",
    get bad(): string {
      throw new Error("getter SECRET_TOKEN_2");
    },
  };
  emit(recordLike({ body }));
  expect(forwarded[0]?.body).toEqual({ ok: "<SECRET_1>", bad: "[REDACTED:ERROR]" });
});

test("a hostile attribute bag (a throwing getter) drops the record rather than exporting it", () => {
  const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const { forwarded, outcomes, emit } = harness();
  const attributes = {
    get boom(): string {
      throw new Error("no");
    },
  };
  expect(() => emit({ attributes } as RecordLike)).not.toThrow();
  expect(forwarded).toHaveLength(0);
  expect(outcomes[0]?.dropped).toBe(true);
  expect(warn).toHaveBeenCalledTimes(1);
});

test("a read-only record (writes ignored) is dropped, never forwarded unredacted, and warns once without the value", () => {
  const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const { forwarded, outcomes, emit } = harness();
  const readOnly = (): RecordLike => ({
    body: "SECRET_TOKEN_1",
    attributes: {},
    setBody: () => undefined, // the SDK's behaviour once a record is read-only
  });

  emit(readOnly());
  emit(readOnly());

  expect(forwarded).toHaveLength(0);
  expect(outcomes.map((o) => o.dropped)).toEqual([true, true]);
  expect(warn).toHaveBeenCalledTimes(1);
  const [message, options] = warn.mock.calls[0] as unknown as [string, { code: string }];
  expect(options.code).toBe("REDACT_SECRET_LOG_RECORD_DROPPED");
  expect(message).toContain("body");
  expect(message).not.toContain("SECRET_TOKEN");
});

test("a frozen attribute bag drops the record", () => {
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const { forwarded, emit } = harness();
  emit(recordLike({ attributes: Object.freeze({ k: "SECRET_TOKEN_1" }) as Record<string, unknown> }));
  expect(forwarded).toHaveLength(0);
});

test("a severity text or event name that will not take the write drops the record", () => {
  vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const { forwarded, emit } = harness();
  emit({ attributes: {}, severityText: "SECRET_TOKEN_1", setSeverityText: () => undefined } as RecordLike);
  emit({ attributes: {}, eventName: "SECRET_TOKEN_1", setEventName: () => undefined } as RecordLike);
  expect(forwarded).toHaveLength(0);
});

test("a record that exposes plain fields and no setters is written to directly", () => {
  const { forwarded, emit } = harness();
  emit({ body: "SECRET_TOKEN_1", severityText: "SECRET_TOKEN_2", eventName: "SECRET_TOKEN_3", attributes: {} });
  expect(forwarded[0]).toMatchObject({ body: "<SECRET_1>", severityText: "<SECRET_1>", eventName: "<SECRET_1>" });
});

test("an SDK that truncates a written string to its attribute limit is not mistaken for an unwritable record", () => {
  const { forwarded, emit } = harness();
  const attributes: Record<string, unknown> = {};
  Object.defineProperty(attributes, "k", {
    enumerable: true,
    get: () => "SECRET_TOKEN_1",
    set(value: string) {
      Object.defineProperty(attributes, "k", { enumerable: true, configurable: true, value: value.slice(0, 4) });
    },
    configurable: true,
  });
  emit({ attributes } as RecordLike);
  expect(forwarded).toHaveLength(1);
  expect(forwarded[0]?.attributes.k).toBe("<SEC");
});

test("a record with no body, no attributes, and absent optional fields passes through", () => {
  const { forwarded, outcomes, emit } = harness();
  emit({ attributes: {} } as RecordLike);
  emit({} as RecordLike);
  expect(forwarded).toHaveLength(2);
  expect(outcomes.every((o) => !o.dropped && o.values.scanned === 0)).toBe(true);
});

test("outcomes are per record, input-free, and report after the next processor has the record", () => {
  const order: string[] = [];
  const next = {
    onEmit: () => order.push("next"),
    forceFlush: async () => {},
    shutdown: async () => {},
  } as unknown as LogRecordProcessor;
  const processor = new RedactingLogRecordProcessorWith(next, fakeScanAndRedact, {
    onOutcome: (outcome) => order.push(`outcome:${JSON.stringify(outcome)}`),
  });
  processor.onEmit(recordLike({ body: "SECRET_TOKEN_1", attributes: { a: "plain" } }) as never);
  processor.onEmit(recordLike({ body: "plain" }) as never);

  expect(order[0]).toBe("next");
  expect(JSON.parse((order[1] as string).slice("outcome:".length))).toEqual({
    host: "otel-logs",
    unit: "log-record",
    values: { scanned: 2, findings: 1, redacted: 1, blocked: 0, limited: 0, failed: 0 },
    dropped: false,
  });
  expect(JSON.parse((order[3] as string).slice("outcome:".length)).values.scanned).toBe(1);
  expect(order.join("|")).not.toContain("SECRET_TOKEN");
});

test("an observer that throws or re-enters changes nothing", () => {
  const forwarded: RecordLike[] = [];
  let processor: RedactingLogRecordProcessorWith;
  let calls = 0;
  const next = { onEmit: (r: RecordLike) => forwarded.push(r), forceFlush: async () => {}, shutdown: async () => {} };
  processor = new RedactingLogRecordProcessorWith(next as unknown as LogRecordProcessor, fakeScanAndRedact, {
    onOutcome: () => {
      calls += 1;
      processor.onEmit(recordLike({ body: "inner" }) as never);
      throw new Error("observer failure SECRET_TOKEN_1");
    },
  });
  expect(() => processor.onEmit(recordLike({ body: "SECRET_TOKEN_1" }) as never)).not.toThrow();
  // The re-entrant emit was forwarded but not reported again.
  expect(calls).toBe(1);
  expect(forwarded.map((r) => r.body)).toEqual(["<SECRET_1>", "inner"]);
});

test("a re-entrant onEmit from the next processor keeps each record's own counts", () => {
  const outcomes: OtelLogRecordOutcome[] = [];
  let processor: RedactingLogRecordProcessorWith;
  let once = true;
  const next = {
    onEmit: () => {
      if (once) {
        once = false;
        processor.onEmit(recordLike({ body: "inner BLOCK_ME" }) as never);
      }
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  processor = new RedactingLogRecordProcessorWith(next as unknown as LogRecordProcessor, fakeScanAndRedact, {
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  processor.onEmit(recordLike({ body: "SECRET_TOKEN_1" }) as never);

  // The inner record reports first (it finishes first); each has its own counts.
  expect(outcomes.map((o) => [o.values.blocked, o.values.redacted])).toEqual([
    [1, 0],
    [0, 1],
  ]);
});

test("an exception from the next processor propagates; the outcome is still reported", () => {
  const outcomes: OtelLogRecordOutcome[] = [];
  const next = {
    onEmit: () => {
      throw new Error("downstream");
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const processor = new RedactingLogRecordProcessorWith(next as unknown as LogRecordProcessor, fakeScanAndRedact, {
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  expect(() => processor.onEmit(recordLike({ body: "x" }) as never)).toThrow("downstream");
  expect(outcomes).toHaveLength(1);
});

test("the context reaches the next processor, and enabled/forceFlush/shutdown are forwarded", async () => {
  const seen: unknown[] = [];
  const calls: string[] = [];
  const next = {
    onEmit: (_record: unknown, context: unknown) => void seen.push(context),
    enabled: (options: unknown) => {
      calls.push(`enabled:${JSON.stringify(options)}`);
      return false;
    },
    forceFlush: async (options: unknown) => void calls.push(`flush:${JSON.stringify(options)}`),
    shutdown: async () => void calls.push("shutdown"),
  };
  const processor = new RedactingLogRecordProcessorWith(next as unknown as LogRecordProcessor, fakeScanAndRedact);
  const context = { marker: true };
  processor.onEmit(recordLike() as never, context as never);
  expect(seen).toEqual([context]);
  expect(processor.enabled({ eventName: "e" })).toBe(false);
  await processor.forceFlush({ timeoutMillis: 5 });
  await processor.shutdown();
  expect(calls).toEqual(['enabled:{"eventName":"e"}', 'flush:{"timeoutMillis":5}', "shutdown"]);
});

test("a wrapped processor without enabled is enabled", () => {
  const next = { onEmit() {}, forceFlush: async () => {}, shutdown: async () => {} };
  const processor = new RedactingLogRecordProcessorWith(next as unknown as LogRecordProcessor, fakeScanAndRedact);
  expect(processor.enabled({})).toBe(true);
});

test("constructor arguments are validated", () => {
  const next = { onEmit() {}, forceFlush: async () => {}, shutdown: async () => {} } as unknown as LogRecordProcessor;
  expect(() => new RedactingLogRecordProcessorWith({} as never, fakeScanAndRedact)).toThrow(TypeError);
  expect(() => new RedactingLogRecordProcessorWith(next, "no" as never)).toThrow(TypeError);
  expect(() => new RedactingLogRecordProcessorWith(next, fakeScanAndRedact, { onOutcome: 1 as never })).toThrow(
    TypeError,
  );
});

test("invalid limit overrides fall back to the defaults instead of disabling a bound", () => {
  const { forwarded, emit } = harness({ limits: { maxTotalLeaves: Number.NaN, maxNodes: -1 } as never });
  emit(recordLike({ body: ["SECRET_TOKEN_1"] }));
  expect(forwarded[0]?.body).toEqual(["<SECRET_1>"]);
});
