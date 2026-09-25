#!/usr/bin/env node
/**
 * The one-off costs of each npm package (#11, #12), measured apart from the
 * per-event overhead `scripts/measure-overhead.mjs` records. Measures and
 * records; it carries no threshold and no verdict. Budgets and judgement
 * belong to redact-secret-benchmarks.
 *
 *   npm run build
 *   node scripts/measure-footprint.mjs --out footprint-js.json
 *   node scripts/measure-footprint.mjs --quick --out -        # CI smoke: shape only, numbers meaningless
 *
 * Two measurements, each independent of the other and of scan cost:
 *
 *   packageSize     `npm pack --dry-run` of every workspace: tarball bytes,
 *                   unpacked bytes, file count. The package's own bytes only;
 *                   `@redact-secret/core` is a peer and is not counted.
 *   initialization  wall time in a fresh Node process, repeated, for:
 *                     import         importing the package's entry point (never loads the core)
 *                     core           importing `@redact-secret/core` and awaiting `initialize()`, alone
 *                     live-factory   the package's live factory end to end (core load and
 *                                    `initialize()` included), for the packages that have one
 *                   so `live-factory − core` is the adapter's own share of start-up.
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

const root = new URL("../", import.meta.url);

/** Live factories, called with the arguments a first-time consumer would pass. */
const LIVE_FACTORIES = {
  "@redact-secret/adapter": "await m.createMaskSecrets();",
  "@redact-secret/adapter-pino": "await m.createRedactingLogMethod();",
  "@redact-secret/adapter-otel":
    "await m.createRedactingSpanProcessor({ onStart() {}, onEnd() {}, forceFlush: async () => {}, shutdown: async () => {} });",
  "@redact-secret/adapter-ai-context": `await m.createAiContextBoundary({
    wholeInputLimits: { maxInputBytes: 65536, maxFindings: 256 },
    incrementalLimits: { maxInputCodeUnits: 1048576, maxBufferedCodeUnits: 65536, maxTokenCodeUnits: 8192, maxMultilineCodeUnits: 32768 },
    traversalLimits: { maxDepth: 16, maxNodes: 4096 },
  });`,
};

function parseArgs(argv) {
  const options = { out: "-", repetitions: 15 };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === "--quick") options.repetitions = 2;
    else if (argv[i] === "--out") options.out = argv[++i];
    else if (argv[i] === "--repetitions") options.repetitions = Number(argv[++i]);
    else throw new Error(`unknown argument: ${argv[i]}`);
  }
  if (!Number.isSafeInteger(options.repetitions) || options.repetitions < 1) {
    throw new Error("--repetitions must be a positive integer");
  }
  return options;
}

function workspaces() {
  return readdirSync(new URL("packages/", root))
    .map((dir) => JSON.parse(readFileSync(new URL(`packages/${dir}/package.json`, root), "utf-8")).name)
    .sort();
}

function packageSize(name) {
  const [pack] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--workspace", name], {
      cwd: root,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  return { tarballBytes: pack.size, unpackedBytes: pack.unpackedSize, files: pack.entryCount };
}

/** Milliseconds for `body` in a fresh process, timed from inside it, so process start-up is excluded. */
function timeInFreshProcess(body) {
  const script = `const t0 = performance.now(); ${body} process.stdout.write(String(performance.now() - t0));`;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], { cwd: root, encoding: "utf-8" });
  return Number(out);
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (x) => Math.round(x * 1000) / 1000;
  const at = (p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
  return {
    unit: "milliseconds",
    samples: samples.map(round),
    median: round(at(0.5)),
    p95: round(at(0.95)),
    minimum: round(sorted[0]),
    maximum: round(sorted.at(-1)),
  };
}

function sample(repetitions, body) {
  return summarize(Array.from({ length: repetitions }, () => timeInFreshProcess(body)));
}

function gitState() {
  try {
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf-8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf-8" }).trim() !== "";
    return { commit, dirty };
  } catch {
    return { commit: null, dirty: null };
  }
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const core = sample(options.repetitions, `const c = await import("@redact-secret/core"); await c.initialize();`);
  const results = workspaces().map((name) => {
    const factory = LIVE_FACTORIES[name];
    const initialization = {
      import: sample(options.repetitions, `const m = await import(${JSON.stringify(name)}); void m;`),
      core,
      ...(factory === undefined
        ? {}
        : {
            "live-factory": sample(options.repetitions, `const m = await import(${JSON.stringify(name)}); ${factory}`),
          }),
    };
    const result = { package: name, packageSize: packageSize(name), initialization };
    console.error(
      `${name}: ${result.packageSize.tarballBytes} B packed, import ${initialization.import.median} ms, live factory ${initialization["live-factory"]?.median ?? "-"} ms (core alone ${core.median} ms)`,
    );
    return result;
  });
  const cpus = os.cpus();
  const output = {
    schema: "redact-secret-adapters/footprint-v1",
    language: "javascript",
    measuredAt: new Date().toISOString(),
    source: { repository: "redact-secret/redact-secret-adapters", ...gitState() },
    environment: {
      platform: os.platform(),
      arch: os.arch(),
      cpuModel: cpus[0]?.model ?? null,
      logicalCpus: cpus.length,
      runtime: `node-${process.versions.node}`,
      loadAverage1m: os.loadavg()[0],
      core: JSON.parse(readFileSync(new URL("node_modules/@redact-secret/core/package.json", root), "utf-8")).version,
    },
    method: {
      quick: process.argv.includes("--quick"),
      repetitions: options.repetitions,
      processes: "one fresh node process per sample; timed from inside it, so process start-up is excluded",
      clock: "performance.now",
      percentile: "nearest-rank",
    },
    results,
    limitations: [
      "Host-dependent: these numbers describe this machine, runtime and disk cache only.",
      "packageSize counts the package's own tarball; @redact-secret/core is a peer and is measured by the core repository.",
      "initialization.core loads whichever core artifact this host resolves (native addon or its WebAssembly fallback).",
      "This output carries no threshold and no verdict.",
    ],
  };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (options.out === "-") process.stdout.write(text);
  else writeFileSync(options.out, text);
}

main();
