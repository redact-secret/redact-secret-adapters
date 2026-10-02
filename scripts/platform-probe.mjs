/**
 * The probe `scripts/smoke-test-platform.mjs` copies into a clean consumer
 * project and runs there (redact-secret/redact-secret-adapters#179). It is
 * never imported by the repository and imports only what a consumer installs.
 *
 * It prints one JSON document: which core artifact loaded (`addon` or `wasm`)
 * and what the adapters made of a fixed set of synthetic cases. The smoke
 * script runs it once per artifact lane and per PII state and compares the
 * documents, so the cases here are the equivalence contract: Unicode ranges,
 * key-aware structured values, every incremental boundary, whole-input and
 * traversal limits, block, error, and PII off or on.
 *
 * PII is process-wide and one-shot in the core, so the PII state is an
 * environment variable read here and each state is its own process.
 *
 * Every value is synthetic. `ghp_` + `SYNTHETICREVOKED` + zeros is the shape
 * of a GitHub token, not a token.
 */

import { readFileSync } from "node:fs";
import { LoggerProvider } from "@opentelemetry/sdk-logs";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createMaskSecrets } from "@redact-secret/adapter";
import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";
import { createMcpBoundary, toCallToolResult } from "@redact-secret/adapter-mcp";
import { createRedactingLogRecordProcessor } from "@redact-secret/adapter-otel-logs";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";
import { createRedactingHooks } from "@redact-secret/adapter-pino";
import * as core from "@redact-secret/core";
import pino from "pino";

const keyContextCases = JSON.parse(readFileSync(new URL("./key-context-cases.json", import.meta.url), "utf-8")).cases;
const pii = process.env.PII === "1" ? ["pii:global"] : undefined;
const activation = pii === undefined ? {} : { pii };

const TOKEN = `ghp_SYNTHETICREVOKED${"0".repeat(20)}`;
const EMAIL = "jane.doe@acme-corp.io";
const PEM_BODY = "U1lOVEhFVElDX1JFVk9LRURfQ09ORk9STUFOQ0U=";
const PEM = `-----BEGIN PRIVATE KEY-----\n${PEM_BODY}\n-----END PRIVATE KEY-----`;

const LIMITS = {
  wholeInputLimits: { maxInputBytes: 4096, maxFindings: 16 },
  incrementalLimits: {
    maxInputCodeUnits: 16384,
    maxBufferedCodeUnits: 2176,
    maxTokenCodeUnits: 1024,
    maxMultilineCodeUnits: 2048,
  },
  traversalLimits: { maxDepth: 4, maxNodes: 64 },
};

const boundary = await createAiContextBoundary({ ...LIMITS, ...activation });
const maskSecrets = await createMaskSecrets(activation);

const out = {
  artifact: core.artifact(),
  pii: pii === undefined ? "off" : "on",
  piiActivation: typeof core.piiActivation === "function" ? core.piiActivation() : null,
};

// Unicode ranges: Korean, astral emoji, combining marks, right-to-left, a NUL, and a zero-width
// character inside a token (the core's invisible-character obfuscation).
const unicodeTexts = [
  `토큰 ${TOKEN} 끝`,
  `\u{1F680}\u{1F680} deploy ${TOKEN} \u{1F44D}`,
  `é café naïve ${TOKEN}`,
  `שלום ${TOKEN} مرحبا`,
  `nul\u0000byte ${TOKEN}`,
  `ghp_SYNTHETIC​REVOKED${"0".repeat(20)}`,
  "plain ordinary text with nothing to find 한국어 \u{1F600}",
  `customer email: ${EMAIL} please`,
  `iban GB82WEST12345698765432 end`,
];
out.unicode = unicodeTexts.map((text) => boundary.sanitizeText(text));

// Key-aware structured values: the shared fixture, plus a nested and an array shape.
out.keyContext = keyContextCases.map((c) => boundary.sanitizeValue({ [c.key]: c.value }));
out.structured = [
  boundary.sanitizeValue({ user: "alice", credentials: { password: "synthetic example passphrase 1", note: "ok" } }),
  boundary.sanitizeValue({
    rows: [{ api_key: "synthetic-example-value-0001" }, { name: "synthetic-example-value-0001" }],
  }),
  boundary.buildContext([
    { role: "user", text: "synthetic-example-value-0001" },
    { role: "tool", value: { api_key: "synthetic-example-value-0001" } },
  ]),
];

// Block, limit and error behavior.
const cyclic = {};
cyclic.self = cyclic;
out.block = [boundary.sanitizeValue({ safe: "ordinary text", deep: { pem: PEM } }), boundary.sanitizeText(PEM)];
out.limits = [
  boundary.sanitizeText("ordinary text\n".repeat(400)),
  boundary.sanitizeText("secret=SECRET01\n".repeat(17)),
  boundary.sanitizeValue({ a: { b: { c: { d: { e: "ordinary text" } } } } }),
  boundary.sanitizeValue(Array.from({ length: 64 }, () => "ordinary text")),
];
out.errors = [
  boundary.sanitizeValue(cyclic),
  boundary.sanitizeValue({ f: () => 1 }),
  boundary.sanitizeValue({ n: 10n }),
];

// Incremental boundaries: the same token and PEM split at every code-unit position.
function streamed(split) {
  const stream = boundary.openStream({ boundary: "tool-result" });
  for (const chunk of split) stream.append(chunk);
  return stream.finalize();
}
const streamText = `progress 1\nAPI_KEY=${TOKEN}\n배포 \u{1F680} done\n`;
out.incremental = [];
for (let i = 0; i <= streamText.length; i += 1) {
  out.incremental.push(streamed([streamText.slice(0, i), streamText.slice(i)]));
}
out.incrementalWhole = boundary.sanitizeText(streamText);
// A split inside a surrogate pair is the one boundary the core refuses; the smoke script expects exactly these.
out.surrogateSplits = [];
for (let i = 1; i < streamText.length; i += 1) {
  const high = streamText.charCodeAt(i - 1);
  const low = streamText.charCodeAt(i);
  if (high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff) out.surrogateSplits.push(i);
}
out.incrementalPem = [PEM.length >> 1, 10, 30].map((i) => streamed([PEM.slice(0, i), PEM.slice(i)]));
{
  const controller = new AbortController();
  const stream = boundary.openStream({ boundary: "tool-result", signal: controller.signal });
  stream.append("progress\nAPI_KEY=ghp_SYNTHETIC");
  controller.abort();
  out.incrementalAborted = stream.finalize();
}

// The shared walker over a value tree.
out.mask = maskSecrets({
  msg: `deploy ${TOKEN} 한국어`,
  nested: { list: ["ok", `Bearer ${TOKEN}`, 7, null], emoji: `\u{1F680} ${TOKEN}` },
  email: `customer email: ${EMAIL} please`,
});

// Real hosts, one result each, through the same core artifact.
{
  const lines = [];
  const logger = pino(
    { base: null, timestamp: false, hooks: await createRedactingHooks(activation) },
    { write: (line) => void lines.push(line) },
  );
  logger.info({ req: { auth: `Bearer ${TOKEN}` } }, "deploy with token %s", TOKEN);
  out.pino = lines.map((l) => JSON.parse(l));
}
{
  const exporter = new InMemorySpanExporter();
  const provider = new BasicTracerProvider({
    spanProcessors: [await createRedactingSpanProcessor(new SimpleSpanProcessor(exporter), activation)],
  });
  const span = provider.getTracer("platform-probe").startSpan(`deploy ${TOKEN}`);
  span.setAttribute("llm.input_messages", `deploy with token ${TOKEN} 한국어`);
  span.end();
  await provider.forceFlush();
  out.trace = exporter.getFinishedSpans().map((s) => ({ name: s.name, attributes: s.attributes }));
}
{
  const records = [];
  const exporter = {
    export(batch, done) {
      records.push(...batch.map((r) => ({ body: r.body, attributes: { ...r.attributes } })));
      done({ code: 0 });
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
  const { SimpleLogRecordProcessor } = await import("@opentelemetry/sdk-logs");
  const probe = new SimpleLogRecordProcessor({ exporter });
  const simple = probe._exporter === exporter ? probe : new SimpleLogRecordProcessor(exporter);
  const redacting = await createRedactingLogRecordProcessor(simple, activation);
  let provider = new LoggerProvider();
  if (typeof provider.addLogRecordProcessor === "function") provider.addLogRecordProcessor(redacting);
  else provider = new LoggerProvider({ processors: [redacting] });
  provider.getLogger("platform-probe").emit({
    body: { msg: `deploy ${TOKEN}`, list: [`Bearer ${TOKEN}`] },
    attributes: { note: `customer email: ${EMAIL} please`, "exception.message": `denied ${TOKEN} 한국어` },
  });
  await new Promise((resolve) => setImmediate(resolve));
  out.logs = records;
}
{
  const mcp = await createMcpBoundary(activation);
  out.mcp = toCallToolResult(
    await mcp.sanitizeToolCall(async () => ({
      content: [{ type: "text", text: `deploy ok\nAPI_KEY=${TOKEN}` }],
      structuredContent: { env: [`API_KEY=${TOKEN}`] },
    })),
  );
}

process.stdout.write(`${JSON.stringify(out)}\n`);
