/**
 * The final bytes, not the in-memory record (redact-secret/redact-secret-adapters#178).
 * `otel-host.test.ts` reads records back from an exporter that hands over the
 * very objects the processor mutated. What leaves the process is an
 * exporter's serialization of them, so these tests put a real
 * `LoggerProvider` and a real Simple or Batch `LogRecordProcessor` in front of
 * an exporter that serializes each batch with `@opentelemetry/otlp-transformer`'s
 * `JsonLogsSerializer` — the OTLP http/json request body `OTLPLogExporter`
 * sends — and assert on those bytes. CI runs this at both ends of the declared
 * `@opentelemetry/sdk-logs` and `@redact-secret/core` ranges.
 *
 * Every value is synthetic: `ghp_` + 36 characters is the shape of a GitHub
 * token, not a token.
 */

import { type DiagLogger, DiagLogLevel, diag } from "@opentelemetry/api";
import type { LogRecordProcessor } from "@opentelemetry/sdk-logs";
import { afterEach, expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { createRedactingLogRecordProcessor, RedactingLogRecordProcessorWith } from "../src/index.js";
import {
  attribute,
  batchProcessor,
  decode,
  type OtlpValue,
  otlpJsonExporter,
  providerWith,
  recordsIn,
  settle,
  simpleProcessor,
} from "./host.js";

const SYNTHETIC_GITHUB_TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000";

afterEach(() => {
  diag.disable();
});

type Wrap = (next: LogRecordProcessor) => LogRecordProcessor | Promise<LogRecordProcessor>;

async function emitSample(wrap: Wrap, batch: boolean, secret: string) {
  const exporter = otlpJsonExporter();
  const next = batch ? batchProcessor(exporter) : simpleProcessor(exporter);
  const provider = providerWith(await wrap(next));
  provider.getLogger("adapter-otel-logs-bytes-test").emit({
    body: `deploy with token ${secret}`,
    severityText: "ERROR",
    severityNumber: 17,
    attributes: {
      "http.url": `https://example.test/reset?token=${secret}`,
      "llm.tags": ["ok", `tag ${secret}`],
      "retry.count": 3,
      "exception.message": `denied for ${secret}`,
      "exception.stacktrace": `Error: denied\n    at call (${secret})`,
    },
  });
  await provider.forceFlush();
  await settle();
  await provider.shutdown();
  return exporter;
}

for (const batch of [false, true]) {
  const processor = batch ? "BatchLogRecordProcessor" : "SimpleLogRecordProcessor";

  test(`the injected processor: no plaintext in the OTLP bytes through ${processor}`, async () => {
    const exporter = await emitSample(
      (next) => new RedactingLogRecordProcessorWith(next, fakeScanAndRedact),
      batch,
      "SECRET_TOKEN_1",
    );

    expect(exporter.bytes.length).toBeGreaterThan(0);
    expect(decode(exporter.bytes)).not.toContain("SECRET_TOKEN_1");
    const [record] = recordsIn(exporter.bytes);
    expect(record?.body?.stringValue).toBe("deploy with token <SECRET_1>");
    expect(record?.severityText).toBe("ERROR");
    expect(attribute(record?.attributes ?? [], "http.url")?.stringValue).toBe(
      "https://example.test/reset?token=<SECRET_1>",
    );
    expect(attribute(record?.attributes ?? [], "llm.tags")?.arrayValue?.values.map((v) => v.stringValue)).toEqual([
      "ok",
      "tag <SECRET_1>",
    ]);
    expect(attribute(record?.attributes ?? [], "exception.message")?.stringValue).toBe("denied for <SECRET_1>");
    expect(attribute(record?.attributes ?? [], "exception.stacktrace")?.stringValue).toBe(
      "Error: denied\n    at call (<SECRET_1>)",
    );
    expect(attribute(record?.attributes ?? [], "retry.count")).toBeDefined();
    // Rewriting values must not be reported as dropped attributes.
    expect(record?.droppedAttributesCount ?? 0).toBe(0);
  });

  test(`the live factory on the real core: no plaintext in the OTLP bytes through ${processor}`, async () => {
    const exporter = await emitSample((next) => createRedactingLogRecordProcessor(next), batch, SYNTHETIC_GITHUB_TOKEN);

    expect(exporter.bytes.length).toBeGreaterThan(0);
    const text = decode(exporter.bytes);
    expect(text).not.toContain(SYNTHETIC_GITHUB_TOKEN);
    expect(text).not.toContain("ghp_SYNTHETIC");
    const [record] = recordsIn(exporter.bytes);
    expect(record?.body?.stringValue).toMatch(/^deploy with token <SECRET_\d+>$/);
    expect(attribute(record?.attributes ?? [], "retry.count")).toBeDefined();
  });
}

function asRecord(value: OtlpValue | undefined) {
  return Object.fromEntries((value?.kvlistValue?.values ?? []).map((entry) => [entry.key, entry.value]));
}

test("a structured body: map, nested array, mixed scalars, and bytes are redacted in the serialized kvlist", async () => {
  const exporter = otlpJsonExporter();
  const provider = providerWith(new RedactingLogRecordProcessorWith(simpleProcessor(exporter), fakeScanAndRedact));
  provider.getLogger("t").emit({
    body: {
      event: "login",
      request: { headers: ["Bearer SECRET_TOKEN_1", "x"], retries: 2, secure: true },
      raw: new TextEncoder().encode("SECRET_TOKEN_2"),
    },
    attributes: { payload: { nested: ["SECRET_TOKEN_3"] }, blob: new TextEncoder().encode("SECRET_TOKEN_4") },
  });
  await settle();
  await provider.shutdown();

  expect(decode(exporter.bytes)).not.toContain("SECRET_TOKEN");
  const [record] = recordsIn(exporter.bytes);
  const body = asRecord(record?.body);
  expect(body.event?.stringValue).toBe("login");
  expect(asRecord(body.request).headers?.arrayValue?.values.map((v) => v.stringValue)).toEqual([
    "Bearer <SECRET_1>",
    "x",
  ]);
  expect(asRecord(body.request).retries).toBeDefined();
  expect(Buffer.from(body.raw?.bytesValue ?? "", "base64").toString()).toBe("<SECRET_1>");
  expect(Buffer.from(attribute(record?.attributes ?? [], "blob")?.bytesValue ?? "", "base64").toString()).toBe(
    "<SECRET_1>",
  );
});

test("an Error passed as the body is serialized without its message or stack in plaintext", async () => {
  const exporter = otlpJsonExporter();
  const provider = providerWith(new RedactingLogRecordProcessorWith(simpleProcessor(exporter), fakeScanAndRedact));
  const error = new Error("failed with SECRET_TOKEN_1");
  provider.getLogger("t").emit({ body: error as never });
  await settle();
  await provider.shutdown();

  expect(decode(exporter.bytes)).not.toContain("SECRET_TOKEN_1");
  expect(asRecord(recordsIn(exporter.bytes)[0]?.body).message?.stringValue).toBe("failed with <SECRET_1>");
});

test("the SDK's own exception handling: whatever exception attributes it produces are redacted", async () => {
  const exporter = otlpJsonExporter();
  const provider = providerWith(new RedactingLogRecordProcessorWith(simpleProcessor(exporter), fakeScanAndRedact));
  const error = new TypeError("bad value SECRET_TOKEN_1");
  provider.getLogger("t").emit({ body: "failed", exception: error } as never);
  await settle();
  await provider.shutdown();

  expect(decode(exporter.bytes)).not.toContain("SECRET_TOKEN_1");
  const attributes = recordsIn(exporter.bytes)[0]?.attributes ?? [];
  // `exception` is accepted by `emit` at the high end of the range only; where it is,
  // the SDK turned it into attributes before this processor ran.
  const message = attribute(attributes, "exception.message")?.stringValue;
  if (message !== undefined) expect(message).toBe("bad value <SECRET_1>");
});

test("Unicode: Korean, emoji, combining marks and NUL survive, and a secret among them is redacted", async () => {
  const exporter = otlpJsonExporter();
  const provider = providerWith(new RedactingLogRecordProcessorWith(simpleProcessor(exporter), fakeScanAndRedact));
  provider.getLogger("t").emit({
    body: "배포 \u{1F680} é \u0000 SECRET_TOKEN_1 완료",
    attributes: { 메모: "비밀 SECRET_TOKEN_2", ok: "순수한 텍스트 \u{1F44D}" },
  });
  await settle();
  await provider.shutdown();

  expect(decode(exporter.bytes)).not.toContain("SECRET_TOKEN");
  const [record] = recordsIn(exporter.bytes);
  expect(record?.body?.stringValue).toBe("배포 \u{1F680} é \u0000 <SECRET_1> 완료");
  expect(attribute(record?.attributes ?? [], "메모")?.stringValue).toBe("비밀 <SECRET_1>");
  expect(attribute(record?.attributes ?? [], "ok")?.stringValue).toBe("순수한 텍스트 \u{1F44D}");
});

test("injected scanner failures: markers replace the values, nothing throws, and the error text never reaches the bytes", async () => {
  const exporter = otlpJsonExporter();
  const provider = providerWith(new RedactingLogRecordProcessorWith(simpleProcessor(exporter), fakeScanAndRedact));
  const logger = provider.getLogger("t");
  expect(() =>
    logger.emit({ body: "BOOM", attributes: { a: "BOOM", b: ["fine", "BOOM"], c: { d: "BOOM" } } }),
  ).not.toThrow();
  logger.emit({ body: "line BLOCK_ME line", attributes: { e: "ok" } });
  await settle();
  await provider.shutdown();

  const text = decode(exporter.bytes);
  expect(text).not.toContain("BOOM");
  expect(text).not.toContain("simulated core failure");
  const [failed, blocked] = recordsIn(exporter.bytes);
  expect(failed?.body?.stringValue).toBe("[REDACTED:ERROR]");
  expect(attribute(failed?.attributes ?? [], "a")?.stringValue).toBe("[REDACTED:ERROR]");
  expect(blocked?.body?.stringValue).toBe("[REDACTED:BLOCKED]");
});

test("a scanner that fails on every call still exports a record, with every string replaced", async () => {
  const exporter = otlpJsonExporter();
  const alwaysFails = () => {
    throw new Error("core unavailable");
  };
  const provider = providerWith(new RedactingLogRecordProcessorWith(simpleProcessor(exporter), alwaysFails));
  provider.getLogger("t").emit({ body: "SECRET_TOKEN_1", attributes: { k: "SECRET_TOKEN_2" } });
  await settle();
  await provider.shutdown();

  expect(decode(exporter.bytes)).not.toContain("SECRET_TOKEN");
  expect(recordsIn(exporter.bytes)[0]?.body?.stringValue).toBe("[REDACTED:ERROR]");
});

/** Captures every diagnostic the SDK emits, which is where exporter failures go. */
function captureDiagnostics(): string[] {
  const messages: string[] = [];
  const record = (...args: unknown[]) => {
    messages.push(args.map((arg) => (arg instanceof Error ? `${arg.message} ${arg.stack}` : String(arg))).join(" "));
  };
  const logger: DiagLogger = { error: record, warn: record, info: record, debug: record, verbose: record };
  diag.setLogger(logger, DiagLogLevel.ALL);
  return messages;
}

for (const failure of ["fail-result", "throw"] as const) {
  test(`failed writes: an exporter that ${failure === "throw" ? "throws" : "reports failure"} leaves the pipeline working, and no diagnostic carries plaintext`, async () => {
    const diagnostics = captureDiagnostics();
    const errors: unknown[] = [];
    const exporter = otlpJsonExporter((batch) => (batch === 1 ? failure : "ok"));
    const processor = new RedactingLogRecordProcessorWith(batchProcessor(exporter), fakeScanAndRedact);
    const provider = providerWith(processor);
    const logger = provider.getLogger("t");

    logger.emit({ body: "first SECRET_TOKEN_1", attributes: { k: "SECRET_TOKEN_2" } });
    try {
      await provider.forceFlush();
    } catch (error) {
      errors.push(error);
    }
    logger.emit({ body: "second SECRET_TOKEN_3" });
    await provider.forceFlush();
    await settle();
    await provider.shutdown();

    // The bytes the failing exporter was given were already redacted.
    expect(exporter.bytes.length).toBeGreaterThanOrEqual(2);
    expect(decode(exporter.bytes)).not.toContain("SECRET_TOKEN");
    expect(recordsIn(exporter.bytes).map((r) => r.body?.stringValue)).toEqual([
      "first <SECRET_1>",
      "second <SECRET_1>",
    ]);
    // The SDK's reports of the failure (and anything thrown at us) never carry the secrets.
    expect(diagnostics.join("\n")).not.toContain("SECRET_TOKEN");
    expect(JSON.stringify(errors)).not.toContain("SECRET_TOKEN");
  });
}

test("flush and shutdown reach the exporter through the redacting processor", async () => {
  const exporter = otlpJsonExporter();
  const provider = providerWith(
    new RedactingLogRecordProcessorWith(batchProcessor(exporter, { scheduledDelayMillis: 60_000 }), fakeScanAndRedact),
  );
  provider.getLogger("t").emit({ body: "SECRET_TOKEN_1" });
  expect(exporter.bytes).toHaveLength(0);
  await provider.forceFlush();
  expect(exporter.bytes).toHaveLength(1);
  await provider.shutdown();
  expect(exporter.shutdownCalls).toBe(1);
  expect(decode(exporter.bytes)).not.toContain("SECRET_TOKEN_1");
});

test("a custom downstream processor that serializes the record itself sees only redacted bytes", async () => {
  const exporter = otlpJsonExporter();
  const custom: LogRecordProcessor = {
    onEmit(record) {
      exporter.export([record as never], () => {});
    },
    forceFlush: async () => {},
    shutdown: async () => {},
  };
  const provider = providerWith(new RedactingLogRecordProcessorWith(custom, fakeScanAndRedact));
  provider.getLogger("t").emit({ body: { token: "SECRET_TOKEN_1" }, attributes: { k: "SECRET_TOKEN_2" } });
  await provider.shutdown();

  expect(decode(exporter.bytes)).not.toContain("SECRET_TOKEN");
  expect(asRecord(recordsIn(exporter.bytes)[0]?.body).token?.stringValue).toBe("<SECRET_1>");
});
