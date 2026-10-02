/**
 * Shared helpers for the real-SDK tests. Written against both ends of the
 * declared `@opentelemetry/sdk-logs` range, so nothing here may use an API
 * that exists at only one of them: `LoggerProvider` takes `processors` in its
 * config at the high end and has `addLogRecordProcessor` at the low end, and
 * `ReadWriteLogRecord`/`LogRecord` differ in name and shape.
 */

import { JsonLogsSerializer } from "@opentelemetry/otlp-transformer";
import {
  BatchLogRecordProcessor,
  LoggerProvider,
  type LogRecordExporter,
  type LogRecordProcessor,
  type ReadableLogRecord,
  SimpleLogRecordProcessor,
} from "@opentelemetry/sdk-logs";

/**
 * A provider over `processors`, built the way the installed SDK takes them:
 * `addLogRecordProcessor` through 0.202, and the `processors` config option
 * from 0.201 on (the two overlap, so the option is used only where the method
 * is gone).
 */
export function providerWith(...processors: LogRecordProcessor[]): LoggerProvider {
  const legacy = new LoggerProvider() as unknown as {
    addLogRecordProcessor?: (processor: LogRecordProcessor) => void;
  };
  if (typeof legacy.addLogRecordProcessor === "function") {
    for (const processor of processors) legacy.addLogRecordProcessor(processor);
    return legacy as unknown as LoggerProvider;
  }
  return new LoggerProvider({ processors } as never);
}

/**
 * `SimpleLogRecordProcessor` and `BatchLogRecordProcessor` take `(exporter,
 * config?)` at the low end of the range and `({ exporter, ...config })` at
 * the high end. That is the host's own API, not this package's, so the tests
 * detect which one the installed SDK has instead of pinning a version.
 */
const takesOptions = (() => {
  const marker = { export() {}, shutdown: async () => {}, forceFlush: async () => {} };
  const probe = new (SimpleLogRecordProcessor as unknown as new (arg: unknown) => unknown)({ exporter: marker });
  return (probe as { _exporter?: unknown })._exporter === marker;
})();

export function simpleProcessor(exporter: LogRecordExporter): LogRecordProcessor {
  const Simple = SimpleLogRecordProcessor as unknown as new (...args: unknown[]) => LogRecordProcessor;
  return takesOptions ? new Simple({ exporter }) : new Simple(exporter);
}

export function batchProcessor(exporter: LogRecordExporter, config: Record<string, unknown> = {}): LogRecordProcessor {
  const Batch = BatchLogRecordProcessor as unknown as new (...args: unknown[]) => LogRecordProcessor;
  return takesOptions ? new Batch({ exporter, ...config }) : new Batch(exporter, config);
}

/** Lets a `SimpleLogRecordProcessor`'s un-awaited export (high end of the range) settle. */
export const settle = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

/** An in-memory exporter that does not clear what it holds on shutdown (the high end of the range does). */
export function memoryExporter(): LogRecordExporter & { records: ReadableLogRecord[] } {
  const exporter = {
    records: [] as ReadableLogRecord[],
    export(records: ReadableLogRecord[], done: (result: { code: number }) => void) {
      exporter.records.push(...records);
      done({ code: 0 });
    },
    async shutdown() {},
    async forceFlush() {},
  };
  return exporter;
}

export type OtlpValue = {
  stringValue?: string;
  intValue?: number | string;
  boolValue?: boolean;
  bytesValue?: string;
  arrayValue?: { values: OtlpValue[] };
  kvlistValue?: { values: OtlpAttribute[] };
};
export interface OtlpAttribute {
  key: string;
  value: OtlpValue;
}
export interface OtlpLogRecord {
  body?: OtlpValue;
  attributes: OtlpAttribute[];
  severityText?: string;
  severityNumber?: number;
  eventName?: string;
  droppedAttributesCount?: number;
}

/** An exporter whose only output is the OTLP/JSON request body it would send. */
export function otlpJsonExporter(
  behaviour: (batch: number) => "ok" | "fail-result" | "throw" = () => "ok",
): LogRecordExporter & { bytes: Uint8Array[]; shutdownCalls: number; flushCalls: number } {
  const exporter = {
    bytes: [] as Uint8Array[],
    shutdownCalls: 0,
    flushCalls: 0,
    export(records: ReadableLogRecord[], done: (result: ExportResult) => void) {
      const body = JsonLogsSerializer.serializeRequest(records);
      if (body !== undefined) exporter.bytes.push(body);
      const outcome = behaviour(exporter.bytes.length);
      if (outcome === "throw") throw new Error("exporter failed");
      done({ code: outcome === "ok" ? 0 : 1, error: outcome === "ok" ? undefined : new Error("export rejected") });
    },
    async shutdown() {
      exporter.shutdownCalls += 1;
    },
    async forceFlush() {
      exporter.flushCalls += 1;
    },
  };
  return exporter;
}

/** `ExportResult` from `@opentelemetry/core`, which this package does not depend on. */
type ExportResult = { code: number; error?: Error | undefined };

export const decode = (chunks: readonly Uint8Array[]) =>
  chunks.map((chunk) => new TextDecoder().decode(chunk)).join("\n");

export function recordsIn(chunks: readonly Uint8Array[]): OtlpLogRecord[] {
  return chunks.flatMap((chunk) => {
    const body = JSON.parse(new TextDecoder().decode(chunk)) as {
      resourceLogs: { scopeLogs: { logRecords: OtlpLogRecord[] }[] }[];
    };
    return body.resourceLogs.flatMap((r) => r.scopeLogs.flatMap((s) => s.logRecords));
  });
}

export const attribute = (attributes: OtlpAttribute[], key: string) => attributes.find((a) => a.key === key)?.value;
