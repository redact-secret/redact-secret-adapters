#!/usr/bin/env node
/**
 * Packs every workspace, installs the tarballs into a throwaway project
 * OUTSIDE the checkout, then imports each package through its public entry
 * point, exercises it against a real host (`pino`,
 * `@opentelemetry/sdk-trace-base`), and typechecks a consumer file against
 * the installed `.d.ts` files.
 *
 * Workspace resolution inside this monorepo papers over a wrong `exports`
 * entry, a missing `types` path, or a `dist` file that was never emitted —
 * none of that is visible to `npm test`. This script checks the package
 * shape the way an outside consumer would install it.
 *
 * Install order matters: `adapter` first, then `adapter-pino` and
 * `adapter-otel`, which depend on it. If `adapter` isn't already installed
 * from its tarball when the other two are, npm resolves
 * `@redact-secret/adapter` from the registry instead: a different build
 * than the one under test, or a failed install when the checkout declares
 * a version that isn't published yet.
 *
 *   node scripts/smoke-test-npm-packages.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_ORDER = ["adapter", "adapter-pino", "adapter-otel"];

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
    npm(["install", tarballs["adapter-pino"], tarballs["adapter-otel"]], projectDir);

    // 4. The peer hosts and the type-only peer, at the ranges this repo declares.
    const adapterManifest = manifestFor("adapter");
    const pinoManifest = manifestFor("adapter-pino");
    const otelManifest = manifestFor("adapter-otel");
    const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
    npm(
      [
        "install",
        `pino@${pinoManifest.peerDependencies.pino}`,
        `@opentelemetry/sdk-trace-base@${otelManifest.peerDependencies["@opentelemetry/sdk-trace-base"]}`,
        `@redact-secret/core@${adapterManifest.peerDependencies["@redact-secret/core"]}`,
        `typescript@${rootManifest.devDependencies.typescript}`,
        `@types/node@${rootManifest.devDependencies["@types/node"]}`,
      ],
      projectDir,
    );

    // 5. Exercise each package's public entry point against a real host.
    writeFileSync(join(projectDir, "smoke-test.mjs"), SMOKE_TEST_MJS);
    console.log("+ node smoke-test.mjs");
    execFileSync(process.execPath, ["smoke-test.mjs"], { cwd: projectDir, stdio: "inherit" });

    // 6. Types resolve for a consumer, typechecked against the installed `.d.ts`.
    writeFileSync(join(projectDir, "smoke-test.ts"), SMOKE_TEST_TS);
    writeFileSync(join(projectDir, "tsconfig.json"), TSCONFIG_JSON);
    const tsc = join(projectDir, "node_modules", ".bin", "tsc");
    console.log("+ tsc -p tsconfig.json");
    execFileSync(tsc, ["-p", "tsconfig.json"], { cwd: projectDir, stdio: "inherit" });

    console.log("\nsmoke test passed: all three packages import, run, and typecheck from outside the workspace.");
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

const SMOKE_TEST_MJS = `import assert from "node:assert/strict";
import pino from "pino";
import { BasicTracerProvider, InMemorySpanExporter, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { BLOCK_MARKER, ERROR_MARKER, maskSecretsWith } from "@redact-secret/adapter";
import { createRedactingLogMethodWith } from "@redact-secret/adapter-pino";
import { RedactingSpanProcessorWith } from "@redact-secret/adapter-otel";
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
console.log("@redact-secret/adapter-pino: ok");

// @redact-secret/adapter-otel: a real span through the packed adapter.
const exporter = new InMemorySpanExporter();
const processor = new RedactingSpanProcessorWith(new SimpleSpanProcessor(exporter), fakeScanAndRedact);
const provider = new BasicTracerProvider({ spanProcessors: [processor] });
const span = provider.getTracer("smoke-test").startSpan("call");
span.setAttribute("llm.input", "call SECRET_TOKEN_1 now");
span.end();
await provider.forceFlush();
const [exported] = exporter.getFinishedSpans();
assert.equal(exported?.attributes["llm.input"], "call <SECRET_1> now");
await provider.shutdown();
console.log("@redact-secret/adapter-otel: ok");
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
  maskLeafWith,
  maskLogValueWith,
  maskSecretsWith,
  type MaskOptions,
  type ScanAndRedact,
} from "@redact-secret/adapter";
import {
  createRedactingLogMethod,
  createRedactingLogMethodWith,
  formatPinoMessage,
  type RedactingLogMethod,
} from "@redact-secret/adapter-pino";
import {
  createRedactingSpanProcessor,
  RedactingSpanProcessorWith,
  redactAttributesWith,
  type RedactAttributesOptions,
} from "@redact-secret/adapter-otel";

const scanner: ScanAndRedact = (text) => ({ text, findings: [] });
const options: MaskOptions = { limits: { ...DEFAULT_LIMITS } };
void BLOCK_MARKER;
void CYCLE_MARKER;
void ERROR_MARKER;
void LIMIT_MARKER;
void maskSecretsWith(scanner, {}, options);
void maskLeafWith(scanner, "x");
void maskLogValueWith(scanner, "x");
void createMaskSecrets;

const logMethod: RedactingLogMethod = createRedactingLogMethodWith(scanner);
void pino;
void createRedactingLogMethod;
void formatPinoMessage;
void logMethod;

const otelOptions: RedactAttributesOptions = {};
void redactAttributesWith;
void createRedactingSpanProcessor;
const processor = new RedactingSpanProcessorWith(new SimpleSpanProcessor(new InMemorySpanExporter()), scanner, otelOptions);
void new BasicTracerProvider({ spanProcessors: [processor] });
`;

const TSCONFIG_JSON = JSON.stringify(
  {
    compilerOptions: {
      target: "es2022",
      lib: ["es2022"],
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
