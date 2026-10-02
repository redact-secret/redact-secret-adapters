#!/usr/bin/env node
/**
 * A small, local overhead measurement for `@redact-secret/adapter-otel-logs`
 * (redact-secret/redact-secret-adapters#178). It is not part of the shared
 * `measure-overhead.mjs` harness and carries no threshold or verdict: the
 * numbers describe this machine only, and judgement belongs to
 * redact-secret-benchmarks.
 *
 *   npm run build && node scripts/measure-otel-logs-overhead.mjs [--records 20000] [--repetitions 7]
 *
 * One real `LoggerProvider` and a no-op downstream processor, four modes over
 * the same typical record (a body of about 190 characters and eight short attributes,
 * one of them carrying a synthetic token shape):
 *
 *   host            the SDK alone, no wrapper
 *   adapter         the wrapper over a scanner that finds nothing (its own traversal)
 *   adapter-core    the wrapper over the real core
 *   core-direct     the real core scanning the same leaves, no SDK and no wrapper
 *
 * Each repetition emits `--records` records; the report is the median
 * microseconds per record across repetitions.
 */

import { LoggerProvider } from "@opentelemetry/sdk-logs";
import * as core from "@redact-secret/core";

const arg = (name, fallback) => {
  const at = process.argv.indexOf(name);
  return at === -1 ? fallback : Number(process.argv[at + 1]);
};
const RECORDS = arg("--records", 20000);
const REPETITIONS = arg("--repetitions", 7);

const { RedactingLogRecordProcessorWith } = await import("../packages/adapter-otel-logs/dist/index.js");
await core.initialize();

const token = "ghp_SYNTHETICREVOKED00000000000000000000";
const body = `${"request handled normally for the checkout service ".repeat(3)}token=${token}`;
const attributes = {
  "http.method": "POST",
  "http.route": "/api/v1/checkout",
  "http.status_code": 200,
  "net.peer.name": "api.example.test",
  "user.agent": "synthetic-agent/1.0",
  "request.id": "req-0123456789",
  "auth.header": `Bearer ${token}`,
  "retry.count": 0,
};
const nothing = (text) => ({ text, findings: [] });
const noop = { onEmit() {}, forceFlush: async () => {}, shutdown: async () => {} };

function providerOver(processor) {
  const legacy = new LoggerProvider();
  if (typeof legacy.addLogRecordProcessor === "function") {
    legacy.addLogRecordProcessor(processor);
    return legacy;
  }
  return new LoggerProvider({ processors: [processor] });
}

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

function measure(emit) {
  emit(); // warm-up
  const samples = [];
  for (let rep = 0; rep < REPETITIONS; rep += 1) {
    const start = process.hrtime.bigint();
    for (let i = 0; i < RECORDS; i += 1) emit();
    samples.push(Number(process.hrtime.bigint() - start) / 1000 / RECORDS);
  }
  return median(samples);
}

const logger = (processor) => providerOver(processor).getLogger("overhead");
const emitVia = (log) => () => log.emit({ body, attributes: { ...attributes }, severityText: "INFO" });

const results = {
  host: measure(emitVia(logger(noop))),
  adapter: measure(emitVia(logger(new RedactingLogRecordProcessorWith(noop, nothing)))),
  "adapter-core": measure(emitVia(logger(new RedactingLogRecordProcessorWith(noop, core.scanAndRedact)))),
  "core-direct": measure(() => {
    core.scanAndRedact(body);
    for (const value of Object.values(attributes)) if (typeof value === "string") core.scanAndRedact(value);
    core.scanAndRedact("INFO");
  }),
};

console.log(
  JSON.stringify(
    {
      schema: "redact-secret-adapters/otel-logs-overhead-local",
      records: RECORDS,
      repetitions: REPETITIONS,
      unit: "microseconds per record (median)",
      node: process.versions.node,
      sdkLogs: JSON.parse(
        (await import("node:fs")).readFileSync(
          new URL("../node_modules/@opentelemetry/sdk-logs/package.json", import.meta.url),
          "utf-8",
        ),
      ).version,
      core: JSON.parse(
        (await import("node:fs")).readFileSync(
          new URL("../node_modules/@redact-secret/core/package.json", import.meta.url),
          "utf-8",
        ),
      ).version,
      results: Object.fromEntries(Object.entries(results).map(([mode, us]) => [mode, Math.round(us * 100) / 100])),
      limitations: [
        "One machine, one runtime, one synthetic record shape; not a budget and not a verdict.",
        "The wrapper's modes include the SDK's own record construction, which is why host is not zero.",
      ],
    },
    null,
    2,
  ),
);
