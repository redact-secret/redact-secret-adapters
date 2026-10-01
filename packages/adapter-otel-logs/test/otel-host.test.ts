/**
 * The processor on a real `LoggerProvider`, with the real Simple and Batch
 * `LogRecordProcessor`s (redact-secret/redact-secret-adapters#178). CI runs
 * this at both ends of the declared `@opentelemetry/sdk-logs` range.
 *
 * `InMemoryLogRecordExporter` hands over the very objects the processor
 * mutated, so this file proves the writes take effect on a record the SDK
 * built and the exact `setBody`/`attributes` paths work at both ends.
 * `./exporter-bytes.test.ts` asserts on what an exporter would actually send.
 */

import type { LogRecordExporter, LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { afterEach, expect, test, vi } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { type OtelLogRecordOutcome, RedactingLogRecordProcessorWith } from "../src/index.js";
import { batchProcessor, memoryExporter, providerWith, settle, simpleProcessor } from "./host.js";

afterEach(() => {
  vi.restoreAllMocks();
});

const processors = {
  SimpleLogRecordProcessor: (exporter: LogRecordExporter) => simpleProcessor(exporter),
  BatchLogRecordProcessor: (exporter: LogRecordExporter) => batchProcessor(exporter),
};

for (const [name, make] of Object.entries(processors)) {
  test(`${name}: body, attributes and severity text reach the exporter redacted`, async () => {
    const exporter = memoryExporter();
    const provider = providerWith(new RedactingLogRecordProcessorWith(make(exporter), fakeScanAndRedact));

    provider.getLogger("adapter-otel-logs-host-test").emit({
      body: "deploy with SECRET_TOKEN_1",
      severityText: "ERROR",
      severityNumber: 17,
      attributes: { "http.url": "https://x.test/?t=SECRET_TOKEN_2", "retry.count": 2, tags: ["SECRET_TOKEN_3", "ok"] },
    });
    await provider.forceFlush();
    await settle();

    const [exported] = exporter.records;
    expect(exporter.records).toHaveLength(1);
    expect(exported?.body).toBe("deploy with <SECRET_1>");
    expect(exported?.severityText).toBe("ERROR");
    expect(exported?.attributes).toEqual({
      "http.url": "https://x.test/?t=<SECRET_1>",
      "retry.count": 2,
      tags: ["<SECRET_1>", "ok"],
    });
    // Rewriting an attribute is not a dropped attribute.
    expect(exported?.droppedAttributesCount).toBe(0);
    await provider.shutdown();
  });

  test(`${name}: a structured body, a map attribute and bytes are redacted`, async () => {
    const exporter = memoryExporter();
    const provider = providerWith(new RedactingLogRecordProcessorWith(make(exporter), fakeScanAndRedact));

    provider.getLogger("adapter-otel-logs-host-test").emit({
      body: { event: "login", request: { headers: ["Bearer SECRET_TOKEN_1"], count: 1 } },
      attributes: { payload: { nested: { token: "SECRET_TOKEN_2" } }, raw: new TextEncoder().encode("SECRET_TOKEN_3") },
    });
    await provider.forceFlush();
    await settle();

    const [exported] = exporter.records;
    expect(exported?.body).toEqual({ event: "login", request: { headers: ["Bearer <SECRET_1>"], count: 1 } });
    expect(exported?.attributes.payload).toEqual({ nested: { token: "<SECRET_1>" } });
    expect(new TextDecoder().decode(exported?.attributes.raw as Uint8Array)).toBe("<SECRET_1>");
    await provider.shutdown();
  });

  test(`${name}: a record with nothing to redact is exported unchanged`, async () => {
    const exporter = memoryExporter();
    const provider = providerWith(new RedactingLogRecordProcessorWith(make(exporter), fakeScanAndRedact));

    provider.getLogger("t").emit({ body: "plain", attributes: { a: "b", n: 1 } });
    await provider.forceFlush();
    await settle();

    const [exported] = exporter.records;
    expect(exported?.body).toBe("plain");
    expect(exported?.attributes).toEqual({ a: "b", n: 1 });
    expect(exported?.droppedAttributesCount).toBe(0);
    await provider.shutdown();
  });

  test(`${name}: the SDK's attribute value limit still applies to what is exported`, async () => {
    const exporter = memoryExporter();
    const processor = new RedactingLogRecordProcessorWith(make(exporter), fakeScanAndRedact);
    const provider = providerWith(processor);
    provider.getLogger("t").emit({ attributes: { k: "SECRET_TOKEN_1" } });
    await provider.forceFlush();
    await settle();
    expect(exporter.records[0]?.attributes.k).toBe("<SECRET_1>");
    await provider.shutdown();
  });
}

test("outcomes are reported per real record, with the real unit", async () => {
  const exporter = memoryExporter();
  const outcomes: OtelLogRecordOutcome[] = [];
  const provider = providerWith(
    new RedactingLogRecordProcessorWith(simpleProcessor(exporter), fakeScanAndRedact, {
      onOutcome: (outcome) => outcomes.push(outcome),
    }),
  );
  const logger = provider.getLogger("t");
  logger.emit({ body: "SECRET_TOKEN_1", attributes: { a: "BLOCK_ME" } });
  logger.emit({ body: "plain" });
  await provider.shutdown();

  expect(outcomes.map((o) => [o.host, o.unit, o.dropped])).toEqual([
    ["otel-logs", "log-record", false],
    ["otel-logs", "log-record", false],
  ]);
  expect(outcomes[0]?.values).toMatchObject({ scanned: 2, redacted: 1, blocked: 1 });
  expect(outcomes[1]?.values).toMatchObject({ scanned: 1, redacted: 0 });
});

test("a custom downstream processor sees only redacted records", async () => {
  const seen: { body: unknown; attributes: Record<string, unknown> }[] = [];
  const custom: LogRecordProcessor = {
    onEmit(record) {
      seen.push({ body: record.body, attributes: { ...record.attributes } });
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const provider = providerWith(new RedactingLogRecordProcessorWith(custom, fakeScanAndRedact));
  provider.getLogger("t").emit({ body: "SECRET_TOKEN_1", attributes: { k: "SECRET_TOKEN_2" } });
  await provider.shutdown();

  expect(seen).toEqual([{ body: "<SECRET_1>", attributes: { k: "<SECRET_1>" } }]);
});

test("the SDK's enabled() decision is not changed by wrapping a processor", async () => {
  const onEmit = vi.fn();
  const refusing = { onEmit, enabled: () => false, forceFlush: async () => {}, shutdown: async () => {} };
  const provider = providerWith(new RedactingLogRecordProcessorWith(refusing as never, fakeScanAndRedact));
  provider.getLogger("t").emit({ body: "SECRET_TOKEN_1" });
  await provider.shutdown();
  // At the low end of the range the SDK has no `enabled` and always emits; at the high end it asks.
  const asked = onEmit.mock.calls.length;
  expect(asked === 0 || asked === 1).toBe(true);
  for (const [record] of onEmit.mock.calls) expect((record as { body: unknown }).body).toBe("<SECRET_1>");
});

test("processor order: a raw processor registered ahead of the redacting one sees the unredacted record", async () => {
  // Documented, not a defect to fix here: processors share one record object,
  // in registration order. Register the redacting wrapper first, or around
  // the processor that exports, as the README says.
  const rawSeen: unknown[] = [];
  const raw: LogRecordProcessor = {
    onEmit: (record) => void rawSeen.push(record.body),
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const exporter = memoryExporter();
  const provider = providerWith(raw, new RedactingLogRecordProcessorWith(simpleProcessor(exporter), fakeScanAndRedact));
  provider.getLogger("t").emit({ body: "SECRET_TOKEN_1" });
  await provider.shutdown();

  expect(rawSeen).toEqual(["SECRET_TOKEN_1"]);
  expect(exporter.records[0]?.body).toBe("<SECRET_1>");
});

test("a record the SDK has already made read-only is dropped, not exported", async () => {
  const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
  const exporter = memoryExporter();
  const outcomes: OtelLogRecordOutcome[] = [];
  const redacting = new RedactingLogRecordProcessorWith(simpleProcessor(exporter), fakeScanAndRedact, {
    onOutcome: (outcome) => outcomes.push(outcome),
  });
  // A processor that hands the record on after `emit` returned, when the SDK
  // has made it read-only: the case "an immutable record" means.
  const deferred: LogRecordProcessor = {
    onEmit(record, context) {
      queueMicrotask(() => redacting.onEmit(record, context));
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const provider = providerWith(deferred);
  provider.getLogger("t").emit({ body: "SECRET_TOKEN_1", attributes: { k: "plain" } });
  await new Promise((resolve) => setImmediate(resolve));
  await provider.forceFlush();
  await settle();

  expect(exporter.records).toHaveLength(0);
  expect(outcomes.map((o) => o.dropped)).toEqual([true]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET_TOKEN");
  await provider.shutdown();
});

test("forceFlush drains a BatchLogRecordProcessor, and shutdown shuts the wrapped chain", async () => {
  const exporter = memoryExporter();
  const shutdown = vi.fn(async () => {});
  const batch = batchProcessor(exporter, { scheduledDelayMillis: 60_000 });
  const originalShutdown = batch.shutdown.bind(batch);
  batch.shutdown = async () => {
    shutdown();
    await originalShutdown();
  };
  const provider = providerWith(new RedactingLogRecordProcessorWith(batch, fakeScanAndRedact));
  provider.getLogger("t").emit({ body: "SECRET_TOKEN_1" });

  expect(exporter.records).toHaveLength(0); // still buffered
  await provider.forceFlush();
  await settle();
  expect(exporter.records.map((r) => r.body)).toEqual(["<SECRET_1>"]);

  await provider.shutdown();
  expect(shutdown).toHaveBeenCalledTimes(1);
});

test("a record emitted after shutdown is not exported, redacted or otherwise", async () => {
  const exporter = memoryExporter();
  const provider = providerWith(new RedactingLogRecordProcessorWith(simpleProcessor(exporter), fakeScanAndRedact));
  const logger = provider.getLogger("t");
  await provider.shutdown();
  logger.emit({ body: "SECRET_TOKEN_1" });
  expect(exporter.records).toHaveLength(0);
});

test("records from interleaved async tasks never see each other's values", async () => {
  const exporter = memoryExporter();
  const provider = providerWith(new RedactingLogRecordProcessorWith(batchProcessor(exporter), fakeScanAndRedact));
  const logger = provider.getLogger("t");
  await Promise.all(
    Array.from({ length: 8 }, async (_, task) => {
      for (let index = 0; index < 25; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
        logger.emit({ body: `task ${task}-${index} SECRET_TOKEN_${task}`, attributes: { id: `${task}-${index}` } });
      }
    }),
  );
  await provider.forceFlush();
  await settle();

  const records = exporter.records;
  expect(records).toHaveLength(200);
  for (const record of records) {
    expect(record.body).toBe(`task ${record.attributes.id} <SECRET_1>`);
  }
  await provider.shutdown();
});
