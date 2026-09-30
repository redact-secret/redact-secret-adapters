#!/usr/bin/env node
/**
 * Packs every workspace, installs the tarballs into a throwaway project
 * OUTSIDE the checkout, then imports each package through its public entry
 * point, exercises it against a real host (`pino`,
 * `@opentelemetry/sdk-trace-base`, both MCP SDK lines), runs
 * `adapter-ai-context`'s and `adapter-mcp`'s documented README examples
 * verbatim on the real core, and typechecks a consumer file against the
 * installed `.d.ts` files, including a wrapped handler passed to each SDK
 * line's `registerTool`.
 *
 * Workspace resolution inside this monorepo papers over a wrong `exports`
 * entry, a missing `types` path, or a `dist` file that was never emitted —
 * none of that is visible to `npm test`. This script checks the package
 * shape the way an outside consumer would install it.
 *
 * Install order matters: `adapter` first, then `adapter-pino`,
 * `adapter-otel-trace` and `adapter-ai-context`, which depend on it, then
 * `adapter-otel`, which re-exports `adapter-otel-trace`, and `adapter-mcp`,
 * which depends on `adapter-ai-context`. If a sibling isn't already installed
 * from its tarball when its dependents are, npm resolves it from the
 * registry instead: a different build than the one under test, or a failed
 * install when the checkout declares a version that isn't published yet.
 *
 * OpenTelemetry traces are checked at the bytes an exporter sends (#49): the
 * `adapter-otel-trace` README example runs verbatim and prints the OTLP/JSON
 * request body, and one span through the live factory is serialized the same
 * way through three imports — the `adapter-otel-trace` tarball, the
 * `adapter-otel` compatibility tarball, and the `@redact-secret/adapter-otel`
 * release currently on npm, installed into its own project — which must all
 * send the same redacted spans.
 *
 *   node scripts/smoke-test-npm-packages.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_ORDER = [
  "adapter",
  "adapter-pino",
  "adapter-otel-trace",
  "adapter-otel",
  "adapter-ai-context",
  "adapter-mcp",
];

function manifestFor(pkgDir) {
  return JSON.parse(readFileSync(join(repoRoot, "packages", pkgDir, "package.json"), "utf-8"));
}

function npm(args, cwd) {
  console.log(`+ npm ${args.join(" ")}  (in ${cwd})`);
  execFileSync("npm", args, { cwd, stdio: "inherit" });
}

function npmPackJson(args, cwd) {
  console.log(`+ npm ${args.join(" ")}  (in ${cwd})`);
  return JSON.parse(execFileSync("npm", args, { cwd, encoding: "utf-8" }));
}

/** The fenced `js` block right after `<!-- smoke-test:example -->` in a package README. */
function readmeExample(pkgDir) {
  const readme = readFileSync(join(repoRoot, "packages", pkgDir, "README.md"), "utf-8");
  const match = /<!-- smoke-test:example -->\s*```js\n([\s\S]*?)```/.exec(readme);
  if (match === null) throw new Error(`${pkgDir}/README.md has no smoke-test:example block`);
  return match[1];
}

/** Every span in the OTLP/JSON request bodies printed one per line. */
function otlpSpans(printed) {
  return printed
    .trim()
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .flatMap((line) => JSON.parse(line).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
}

function main() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "redact-secret-pack-"));
  const packsDir = join(root, "packs");
  const projectDir = join(root, "project");
  mkdirSync(packsDir);
  mkdirSync(projectDir);
  console.log(`throwaway project: ${projectDir} (outside ${repoRoot})`);

  let ok = false;
  try {
    // 1. Pack every workspace into the throwaway packs dir.
    const tarballs = {};
    for (const pkgDir of PACKAGE_ORDER) {
      const manifest = manifestFor(pkgDir);
      const [{ filename }] = npmPackJson(
        ["pack", "--json", "--workspace", manifest.name, "--pack-destination", packsDir],
        repoRoot,
      );
      tarballs[pkgDir] = join(packsDir, filename);
    }

    // 2. A bare consumer project, outside the checkout.
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "redact-secret-adapters-smoke", private: true, type: "module" }, null, 2),
    );

    // 3. Install in dependency order: adapter, then its dependents.
    npm(["install", tarballs.adapter], projectDir);
    npm(
      ["install", tarballs["adapter-pino"], tarballs["adapter-otel-trace"], tarballs["adapter-ai-context"]],
      projectDir,
    );
    npm(["install", tarballs["adapter-otel"], tarballs["adapter-mcp"]], projectDir);

    // 4. The peer hosts and the type-only peer, at the ranges this repo declares,
    // and the OTLP serializer the OpenTelemetry checks read the exporter's bytes with.
    const adapterManifest = manifestFor("adapter");
    const pinoManifest = manifestFor("adapter-pino");
    const otelManifest = manifestFor("adapter-otel-trace");
    const sdkTraceBase = `@opentelemetry/sdk-trace-base@${otelManifest.peerDependencies["@opentelemetry/sdk-trace-base"]}`;
    const otlpTransformer = `@opentelemetry/otlp-transformer@${otelManifest.devDependencies["@opentelemetry/otlp-transformer"]}`;
    const mcpPeers = manifestFor("adapter-mcp").peerDependencies;
    const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    npm(
      [
        "install",
        `pino@${pinoManifest.peerDependencies.pino}`,
        sdkTraceBase,
        otlpTransformer,
        `@redact-secret/core@${adapterManifest.peerDependencies["@redact-secret/core"]}`,
        `@modelcontextprotocol/sdk@${mcpPeers["@modelcontextprotocol/sdk"]}`,
        `@modelcontextprotocol/client@${mcpPeers["@modelcontextprotocol/client"]}`,
        `@modelcontextprotocol/server@${mcpPeers["@modelcontextprotocol/server"]}`,
        `typescript@${rootManifest.devDependencies.typescript}`,
        `@types/node@${rootManifest.devDependencies["@types/node"]}`,
      ],
      projectDir,
    );

    // 5. Exercise each package's public entry point against a real host.
    writeFileSync(join(projectDir, "smoke-test.mjs"), SMOKE_TEST_MJS);
    console.log("+ node smoke-test.mjs");
    execFileSync(process.execPath, ["smoke-test.mjs"], { cwd: projectDir, stdio: "inherit" });

    // 5a. adapter-pino's README example, verbatim, on the real core and a
    // real pino logger: the complete documented boundary (both hooks), with
    // the secret in the message, an interpolation value, a merging object
    // behind a serializer, a child binding and `mixin()` output. The
    // assertions read the bytes that reached the destination.
    writeFileSync(join(projectDir, "pino-example.mjs"), readmeExample("adapter-pino"));
    console.log("+ node pino-example.mjs");
    const pinoPrinted = execFileSync(process.execPath, ["pino-example.mjs"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const pinoLine = JSON.parse(pinoPrinted.trim().split("\n").at(-1));
    if (pinoPrinted.includes("ghp_SYNTHETIC")) {
      throw new Error("adapter-pino: the synthetic token reached the destination in plaintext");
    }
    // msg and req.auth come from `logMethod`; session (a child binding) only
    // from `streamWrite`. Asserting both is what proves the pair is installed.
    if (
      pinoLine.msg !== "deploy with token <SECRET_1>" ||
      pinoLine.req?.auth !== "Bearer <SECRET_1>" ||
      pinoLine.session !== "<SECRET_1>" ||
      pinoLine.requestId !== "req-42"
    ) {
      throw new Error(`adapter-pino: unexpected destination line ${JSON.stringify(pinoLine)}`);
    }
    console.log("@redact-secret/adapter-pino: README example ok");

    // 5b. adapter-ai-context's README example, verbatim, on the real core.
    writeFileSync(join(projectDir, "ai-context-example.mjs"), readmeExample("adapter-ai-context"));
    console.log("+ node ai-context-example.mjs");
    const printed = execFileSync(process.execPath, ["ai-context-example.mjs"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const context = JSON.parse(printed.trim().split("\n").at(-1));
    if (context[0]?.content !== "deploy with API_KEY=<SECRET_1>" || printed.includes("ghp_SYNTHETIC")) {
      throw new Error("adapter-ai-context: the README example did not print the redacted context");
    }
    console.log("@redact-secret/adapter-ai-context: README example ok");

    // 5c. adapter-mcp's README example, verbatim, on the real core.
    writeFileSync(join(projectDir, "mcp-example.mjs"), readmeExample("adapter-mcp"));
    console.log("+ node mcp-example.mjs");
    const mcpPrinted = execFileSync(process.execPath, ["mcp-example.mjs"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const mcpResult = JSON.parse(mcpPrinted.trim().split("\n").at(-1));
    if (
      mcpResult.content?.[0]?.text !== "deploy ok\nAPI_KEY=<SECRET_1>" ||
      mcpResult.structuredContent?.env?.[0] !== "API_KEY=<SECRET_1>" ||
      mcpPrinted.includes("ghp_SYNTHETIC")
    ) {
      throw new Error("adapter-mcp: the README example did not print the redacted result");
    }
    console.log("@redact-secret/adapter-mcp: README example ok");

    // 5d. adapter-otel-trace's README example, verbatim, on the real core and
    // a real BasicTracerProvider. The assertions read the OTLP/JSON request
    // body the example's exporter wrote, not the in-memory span.
    writeFileSync(join(projectDir, "otel-trace-example.mjs"), readmeExample("adapter-otel-trace"));
    console.log("+ node otel-trace-example.mjs");
    const otelPrinted = execFileSync(process.execPath, ["otel-trace-example.mjs"], {
      cwd: projectDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    const [otelSpan] = otlpSpans(otelPrinted);
    const otelAttribute = (attributes, key) => attributes?.find((a) => a.key === key)?.value?.stringValue;
    if (
      otelPrinted.includes("ghp_SYNTHETIC") ||
      otelSpan?.name !== "deploy <SECRET_1>" ||
      otelAttribute(otelSpan.attributes, "llm.input_messages") !== "deploy with token <SECRET_1>" ||
      otelAttribute(otelSpan.events?.[0]?.attributes, "tool.args") !== "Bearer <SECRET_1>"
    ) {
      throw new Error(`adapter-otel-trace: unexpected exporter bytes ${otelPrinted}`);
    }
    console.log("@redact-secret/adapter-otel-trace: README example ok");

    // 5e. The same span through the live factory under every name a consumer
    // can import it by: this checkout's adapter-otel-trace and adapter-otel
    // tarballs, and the adapter-otel release on npm in a project of its own
    // (its own published adapter, nothing from this checkout). All three must
    // send the same redacted spans.
    writeFileSync(join(projectDir, "otel-bytes.mjs"), OTEL_BYTES_MJS);
    const publishedDir = join(root, "published-otel");
    mkdirSync(publishedDir);
    writeFileSync(
      join(publishedDir, "package.json"),
      JSON.stringify({ name: "redact-secret-adapters-published-otel", private: true, type: "module" }, null, 2),
    );
    const publishedOtel = execFileSync("npm", ["view", "@redact-secret/adapter-otel", "version"], {
      encoding: "utf-8",
    }).trim();
    npm(
      [
        "install",
        `@redact-secret/adapter-otel@${publishedOtel}`,
        sdkTraceBase,
        otlpTransformer,
        `@redact-secret/core@${adapterManifest.peerDependencies["@redact-secret/core"]}`,
      ],
      publishedDir,
    );
    writeFileSync(join(publishedDir, "otel-bytes.mjs"), OTEL_BYTES_MJS);
    const sent = (cwd, specifier) => {
      console.log(`+ node otel-bytes.mjs ${specifier}  (in ${cwd})`);
      return execFileSync(process.execPath, ["otel-bytes.mjs", specifier], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "inherit"],
      }).trim();
    };
    const candidateBytes = sent(projectDir, "@redact-secret/adapter-otel-trace");
    const shimBytes = sent(projectDir, "@redact-secret/adapter-otel");
    const publishedBytes = sent(publishedDir, "@redact-secret/adapter-otel");
    if (candidateBytes.includes("ghp_SYNTHETIC") || !/deploy with token <SECRET_\d+>/.test(candidateBytes)) {
      throw new Error(`adapter-otel-trace: unexpected exporter bytes ${candidateBytes}`);
    }
    if (shimBytes !== candidateBytes) {
      throw new Error(`adapter-otel (this checkout) sent different spans:\n${shimBytes}\n${candidateBytes}`);
    }
    if (publishedBytes !== candidateBytes) {
      throw new Error(
        `adapter-otel@${publishedOtel} (npm) sent different spans:\n${publishedBytes}\n${candidateBytes}`,
      );
    }
    console.log(
      `@redact-secret/adapter-otel-trace, adapter-otel (tarball) and adapter-otel@${publishedOtel} (npm): same exporter bytes`,
    );

    // 6. Types resolve for a consumer, typechecked against the installed `.d.ts`.
    writeFileSync(join(projectDir, "smoke-test.ts"), SMOKE_TEST_TS);
    writeFileSync(join(projectDir, "tsconfig.json"), TSCONFIG_JSON);
    const tsc = join(projectDir, "node_modules", ".bin", "tsc");
    console.log("+ tsc -p tsconfig.json");
    execFileSync(tsc, ["-p", "tsconfig.json"], { cwd: projectDir, stdio: "inherit" });

    console.log("\nsmoke test passed: every package imports, runs, and typechecks from outside the workspace.");
    ok = true;
  } finally {
    if (ok) {
      rmSync(root, { recursive: true, force: true });
    } else {
      console.error(`\nsmoke test failed — throwaway project left at ${root} for inspection`);
    }
  }
}

// A deterministic stand-in for `@redact-secret/core`'s `scanAndRedact`, kept
// in sync by hand with `fixtures/fake-scanner.ts`: BOOM throws, BLOCK_ME
// gets a `block` finding, SECRET_TOKEN_\d+ gets a `redact` finding over
// that span, anything else is untouched. Not imported from the repo — this
// project is deliberately outside it.
const FAKE_SCANNER = `
function finding(action) {
  return { id: "finding-1", type: "generic_token", detector: "fake", confidence: "high", action, start: 0, end: 0 };
}
export function fakeScanAndRedact(text) {
  if (text.includes("BOOM")) throw new Error("simulated core failure");
  if (text.includes("BLOCK_ME")) {
    return { text: text.replace("BLOCK_ME", "<SECRET_1>"), findings: [finding("block")] };
  }
  const match = /SECRET_TOKEN_\\d+/.exec(text);
  if (match) {
    const redacted = text.slice(0, match.index) + "<SECRET_1>" + text.slice(match.index + match[0].length);
    return { text: redacted, findings: [finding("redact")] };
  }
  return { text, findings: [] };
}
`;

// One span through `createRedactingSpanProcessor` imported from argv[2], a
// real BatchSpanProcessor and an exporter that serializes with the OTLP/JSON
// serializer. Prints the exported spans with the per-run ids and timestamps
// removed, so two runs compare byte for byte. Synthetic values only.
const OTEL_BYTES_MJS = `import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
const { createRedactingSpanProcessor } = await import(process.argv[2]);
const token = "ghp_SYNTHETICREVOKED00000000000000000000";
const bodies = [];
const exporter = {
  export(spans, done) { bodies.push(new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans))); done({ code: 0 }); },
  shutdown: async () => {},
};
const provider = new BasicTracerProvider({
  spanProcessors: [await createRedactingSpanProcessor(new BatchSpanProcessor(exporter))],
});
const span = provider.getTracer("smoke-test").startSpan(\`deploy \${token}\`);
span.setAttribute("llm.input_messages", \`deploy with token \${token}\`);
span.setAttribute("llm.tags", ["ok", \`tag \${token}\`]);
span.addEvent("tool_call", { "tool.args": \`Bearer \${token}\` });
span.setStatus({ code: 2, message: \`denied for \${token}\` });
span.end();
await provider.shutdown();
const VARYING = new Set(["traceId", "spanId", "parentSpanId", "startTimeUnixNano", "endTimeUnixNano", "timeUnixNano"]);
const spans = bodies.flatMap((body) => JSON.parse(body).resourceSpans.flatMap((r) => r.scopeSpans.flatMap((s) => s.spans)));
console.log(JSON.stringify(spans, (key, value) => (VARYING.has(key) ? undefined : value)));
`;

const SMOKE_TEST_MJS = `import assert from "node:assert/strict";
import pino from "pino";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BLOCK_MARKER, ERROR_MARKER, maskSecretsWith } from "@redact-secret/adapter";
import { createRedactingHooksWith, createRedactingLogMethodWith } from "@redact-secret/adapter-pino";
import { RedactingSpanProcessorWith as TraceRedactingSpanProcessorWith } from "@redact-secret/adapter-otel-trace";
import { RedactingSpanProcessorWith } from "@redact-secret/adapter-otel";
import { createAiContextBoundaryWith } from "@redact-secret/adapter-ai-context";
import { createMcpBoundaryWith, mcpBlockedResult, toCallToolResult } from "@redact-secret/adapter-mcp";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerV2 } from "@modelcontextprotocol/server";
${FAKE_SCANNER}
// @redact-secret/adapter: mask a value through maskSecretsWith with an injected scanner.
assert.equal(typeof BLOCK_MARKER, "string");
assert.equal(typeof ERROR_MARKER, "string");
const masked = maskSecretsWith(fakeScanAndRedact, { note: "token SECRET_TOKEN_1 here" });
assert.deepEqual(masked, { note: "token <SECRET_1> here" });
console.log("@redact-secret/adapter: ok");

// @redact-secret/adapter-pino: a real pino logger, a secret must not reach the transport.
const chunks = [];
const destination = { write(chunk) { chunks.push(chunk); return true; } };
const logMethod = createRedactingLogMethodWith(fakeScanAndRedact);
const logger = pino({ base: null, timestamp: false, hooks: { logMethod } }, destination);
logger.info("token is %s", "SECRET_TOKEN_1");
const raw = chunks.join("");
assert.ok(raw.includes("<SECRET_1>"), "expected the masked marker in the pino output");
assert.ok(!raw.includes("SECRET_TOKEN_1"), "the plaintext secret reached the pino transport");

// The paired factory, composing a host hook, over a child binding that only
// the streamWrite half of the pair can see.
const pairChunks = [];
const paired = pino(
  {
    base: null,
    timestamp: false,
    hooks: createRedactingHooksWith(fakeScanAndRedact, {
      hooks: { logMethod(args, method) { method.apply(this, args); } },
    }),
  },
  { write(chunk) { pairChunks.push(chunk); return true; } },
);
paired.child({ session: "SECRET_TOKEN_2" }).info("plain");
const pairedLine = JSON.parse(pairChunks.join(""));
assert.equal(pairedLine.session, "<SECRET_1>", "a child binding reached the destination unmasked");
assert.equal(pairedLine.msg, "plain");
console.log("@redact-secret/adapter-pino: ok");

// @redact-secret/adapter-otel-trace, and adapter-otel, which re-exports it: a real span through each packed name.
assert.equal(RedactingSpanProcessorWith, TraceRedactingSpanProcessorWith, "adapter-otel is not re-exporting adapter-otel-trace");
for (const [name, Processor] of [
  ["@redact-secret/adapter-otel-trace", TraceRedactingSpanProcessorWith],
  ["@redact-secret/adapter-otel", RedactingSpanProcessorWith],
]) {
  const exporter = new InMemorySpanExporter();
  const processor = new Processor(new SimpleSpanProcessor(exporter), fakeScanAndRedact);
  const provider = new BasicTracerProvider({ spanProcessors: [processor] });
  const span = provider.getTracer("smoke-test").startSpan("call");
  span.setAttribute("llm.input", "call SECRET_TOKEN_1 now");
  span.end();
  await provider.forceFlush();
  const [exported] = exporter.getFinishedSpans();
  assert.equal(exported?.attributes["llm.input"], "call <SECRET_1> now");
  await provider.shutdown();
  console.log(\`\${name}: ok\`);
}

// @redact-secret/adapter-ai-context: the injected API over the fake scanner.
const boundary = createAiContextBoundaryWith(
  { scanAndRedact: fakeScanAndRedact, createIncrementalSanitizer: () => { throw new Error("unused"); } },
  {
    wholeInputLimits: { maxInputBytes: 1024, maxFindings: 8 },
    incrementalLimits: { maxInputCodeUnits: 1024, maxBufferedCodeUnits: 512, maxTokenCodeUnits: 128, maxMultilineCodeUnits: 256 },
    traversalLimits: { maxDepth: 4, maxNodes: 32 },
  },
);
assert.deepEqual(boundary.sanitizeValue({ note: "token SECRET_TOKEN_1 here" }).value, { note: "token <SECRET_1> here" });
assert.deepEqual(boundary.sanitizeText("BLOCK_ME"), { outcome: "blocked", reason: "policy" });
assert.deepEqual(boundary.sanitizeText("BOOM"), { outcome: "blocked", reason: "core_error" });
console.log("@redact-secret/adapter-ai-context: ok");

// @redact-secret/adapter-mcp: the injected API over the same boundary, and a wrapped handler registered on both SDK lines.
const mcp = createMcpBoundaryWith(boundary);
const sanitized = mcp.sanitizeToolResult({ content: [{ type: "text", text: "token SECRET_TOKEN_1 here" }] });
assert.deepEqual(toCallToolResult(sanitized), { content: [{ type: "text", text: "token <SECRET_1> here" }] });
assert.deepEqual(toCallToolResult(mcp.sanitizeToolResult({ content: [{ type: "text", text: "BLOCK_ME" }] })), mcpBlockedResult());
const wrapped = mcp.wrapToolHandler(() => { throw new Error("SECRET_TOKEN_1"); });
new McpServerV1({ name: "smoke", version: "0.0.0" }).registerTool("t", { description: "d" }, wrapped);
new McpServerV2({ name: "smoke", version: "0.0.0" }).registerTool("t", { description: "d" }, wrapped);
assert.equal(JSON.stringify(await wrapped({})).includes("SECRET_TOKEN_1"), false);
console.log("@redact-secret/adapter-mcp: ok");
`;

const SMOKE_TEST_TS = `import pino from "pino";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import {
  BLOCK_MARKER,
  CYCLE_MARKER,
  DEFAULT_LIMITS,
  ERROR_MARKER,
  LIMIT_MARKER,
  createMaskSecrets,
  createOutcomeCounter,
  maskLeafOutcomeWith,
  maskLeafWith,
  maskLogValueWith,
  maskSecretsWith,
  toValueCounts,
  type MaskOptions,
  type OutcomeCounter,
  type ScanAndRedact,
  type ValueCounts,
} from "@redact-secret/adapter";
import {
  createRedactingHooks,
  createRedactingHooksWith,
  createRedactingLogMethod,
  createRedactingLogMethodWith,
  formatPinoMessage,
  type RedactingHooks,
  type RedactingHooksOptions,
  type RedactingLogMethod,
} from "@redact-secret/adapter-pino";
import {
  createRedactingSpanProcessor,
  RedactingSpanProcessorWith,
  redactAttributesWith,
  type OtelSpanOutcome,
  type RedactAttributesOptions,
  type RedactingSpanProcessorOptions,
} from "@redact-secret/adapter-otel";
import {
  createRedactingSpanProcessor as createTraceProcessor,
  RedactingSpanProcessorWith as TraceProcessor,
  redactAttributesWith as traceRedactAttributesWith,
  type CreateRedactingSpanProcessorOptions as TraceCreateOptions,
  type OtelSpanOutcome as TraceSpanOutcome,
  type RedactingSpanProcessorOptions as TraceProcessorOptions,
} from "@redact-secret/adapter-otel-trace";
import {
  AI_CONTEXT_DEFAULT_LIMITS,
  BLOCK_REASONS,
  SAFE_FINDING_FIELDS,
  createAiContextBoundary,
  createAiContextBoundaryWith,
  withDefaultLimits,
  type AiContextBoundary,
  type AiContextBoundaryOptions,
  type AiContextLimits,
  type AiContextOutcome,
  type SafeFinding,
} from "@redact-secret/adapter-ai-context";
import {
  MCP_BLOCKED_TEXT,
  createMcpBoundary,
  createMcpBoundaryWith,
  toCallToolResult,
  type McpAuditRecord,
  type McpBoundary,
  type McpOutcome,
} from "@redact-secret/adapter-mcp";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { initialize, scanAndRedact, createIncrementalSanitizer } from "@redact-secret/core";

const scanner: ScanAndRedact = (text) => ({ text, findings: [] });
const counter: OutcomeCounter = createOutcomeCounter();
const counts: ValueCounts = toValueCounts(counter);
void counts.redacted;
void maskLeafOutcomeWith(scanner, "x").outcome;
const options: MaskOptions = { limits: { ...DEFAULT_LIMITS }, counter };
void BLOCK_MARKER;
void CYCLE_MARKER;
void ERROR_MARKER;
void LIMIT_MARKER;
void maskSecretsWith(scanner, {}, options);
void maskLeafWith(scanner, "x");
void maskLogValueWith(scanner, "x");
void createMaskSecrets;

const logMethod: RedactingLogMethod = createRedactingLogMethodWith(scanner);
const hookOptions: RedactingHooksOptions = {
  hooks: { logMethod },
  onOutcome: ({ level, stages, values, lineReplaced }) => void [level, stages[0], values.redacted, lineReplaced],
};
const redactingHooks: RedactingHooks = createRedactingHooksWith(scanner, hookOptions);
void pino({ hooks: redactingHooks });
void createRedactingHooks;
void createRedactingLogMethod;
void formatPinoMessage;
void logMethod;

const otelOptions: RedactingSpanProcessorOptions = {
  onOutcome: (outcome: OtelSpanOutcome) => void [outcome.dropped, outcome.values.blocked],
};
const deprecatedOtelOptions: RedactAttributesOptions = {};
void redactAttributesWith;
void createRedactingSpanProcessor;
void deprecatedOtelOptions;
const processor = new RedactingSpanProcessorWith(new SimpleSpanProcessor(new InMemorySpanExporter()), scanner, otelOptions);
void new BasicTracerProvider({ spanProcessors: [processor] });

// The same API under the trace-only name, interchangeable with the deprecated one in both directions.
const traceOptions: TraceProcessorOptions = otelOptions;
const traceCreate: TraceCreateOptions = { ...traceOptions, pii: ["pii:global"] };
const traceProcessor: RedactingSpanProcessorWith = new TraceProcessor(new SimpleSpanProcessor(new InMemorySpanExporter()), scanner, traceOptions);
const shimProcessor: TraceProcessor = processor;
const traceOutcome = (outcome: TraceSpanOutcome): OtelSpanOutcome => outcome;
void [traceCreate, traceProcessor, shimProcessor, traceOutcome, traceRedactAttributesWith];
const createdTrace: Promise<TraceProcessor> = createTraceProcessor(new SimpleSpanProcessor(new InMemorySpanExporter()));
void createdTrace;

const aiOptions: AiContextBoundaryOptions = {
  wholeInputLimits: { maxInputBytes: 1024, maxFindings: 8 },
  incrementalLimits: { maxInputCodeUnits: 1024, maxBufferedCodeUnits: 512, maxTokenCodeUnits: 128, maxMultilineCodeUnits: 256 },
  traversalLimits: { maxDepth: 4, maxNodes: 32 },
  onFinding: (finding: SafeFinding, { boundary }) => void [finding.action, boundary],
};
void initialize;
const aiBoundary: AiContextBoundary = createAiContextBoundaryWith({ scanAndRedact, createIncrementalSanitizer }, aiOptions);
const aiOutcome: AiContextOutcome<string> = aiBoundary.sanitizeText("x", { boundary: "user-input" });
if (aiOutcome.outcome === "blocked") void aiOutcome.reason;
void createAiContextBoundary;
void createAiContextBoundary();
void BLOCK_REASONS;
void SAFE_FINDING_FIELDS;
const presetLimits: AiContextLimits = AI_CONTEXT_DEFAULT_LIMITS;
void presetLimits.traversalLimits.maxNodes;
const defaulted: AiContextBoundaryOptions = withDefaultLimits({ onFinding: () => {} });
void defaulted.wholeInputLimits;

const mcpBoundary: McpBoundary = createMcpBoundaryWith(aiBoundary, {
  binaryContent: "block",
  onAudit: (record: McpAuditRecord) => void [record.stage, record.outcome],
});
const mcpOutcome: McpOutcome<unknown> = mcpBoundary.sanitizeToolResult({ content: [] });
void toCallToolResult(mcpOutcome);
void createMcpBoundary;
void createMcpBoundary();
void MCP_BLOCKED_TEXT;
// A wrapped handler is assignable to each SDK line's tool callback.
const handler = mcpBoundary.wrapToolHandler(() => ({ content: [{ type: "text" as const, text: "ok" }] }));
new McpServerV1({ name: "smoke", version: "0.0.0" }).registerTool("t", { description: "d" }, handler);
new McpServerV2({ name: "smoke", version: "0.0.0" }).registerTool("t", { description: "d" }, handler);
const streamed = mcpBoundary.wrapStreamedToolHandler(async function* () { yield "chunk"; });
new McpServerV1({ name: "smoke", version: "0.0.0" }).registerTool("s", { description: "d" }, streamed);
new McpServerV2({ name: "smoke", version: "0.0.0" }).registerTool("s", { description: "d" }, streamed);
`;

// `dom` because `@modelcontextprotocol/sdk`'s own declarations name
// `HeadersInit`; with `skipLibCheck: false` they are checked too.
const TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: {
      target: "es2022",
      lib: ["es2022", "dom"],
      module: "nodenext",
      moduleResolution: "nodenext",
      strict: true,
      noEmit: true,
      skipLibCheck: false,
      types: ["node"],
    },
    include: ["smoke-test.ts"],
  },
  null,
  2,
);

main();
