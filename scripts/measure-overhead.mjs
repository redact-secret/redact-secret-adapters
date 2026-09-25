#!/usr/bin/env node
/**
 * Adapter-only operational overhead (#11), JavaScript hosts. Measures and
 * records; it carries no threshold and no verdict. Budgets and judgement
 * belong to redact-secret-benchmarks, which consumes this file's output.
 *
 *   npm run build
 *   node scripts/measure-overhead.mjs --out overhead-js.json
 *   node scripts/measure-overhead.mjs --quick --out -        # CI smoke: shape only, numbers meaningless
 *
 * For every (host, profile) pair it times four modes over the same events,
 * interleaved and rotated per repetition so drift spreads evenly:
 *
 *   host              the host alone (pino, an OpenTelemetry provider), no adapter
 *   adapter-identity  host + adapter over a scanner that finds nothing: traversal and seam cost only
 *   adapter-core      host + adapter over the real `@redact-secret/core`
 *   core-direct       the real core called directly on exactly the leaves the adapter hands it
 *
 * and derives, from per-mode medians, `traversal` (adapter-identity − host),
 * `coreScan` (core-direct), `adapterOverhead` (adapter-core − host), and the
 * `unattributed` remainder. Core scan time is therefore never folded into
 * traversal, and neither is folded into host time.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";

import { buildEvents, loadProfiles, workloadDigest } from "./overhead-workloads.mjs";

const HOSTS = ["pino", "pino-streamwrite", "otel-js", "mask-js"];
const MODES = ["host", "adapter-identity", "adapter-core", "core-direct"];

function parseArgs(argv) {
  const options = { out: "-", repetitions: 15, events: 400, warmup: 200, hosts: HOSTS, profiles: undefined };
  const setters = {
    "--out": (value) => (options.out = value),
    "--repetitions": (value) => (options.repetitions = Number(value)),
    "--events": (value) => (options.events = Number(value)),
    "--warmup": (value) => (options.warmup = Number(value)),
    "--host": (value) => (options.hosts = value.split(",")),
    "--profile": (value) => (options.profiles = value.split(",")),
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--quick") {
      Object.assign(options, { repetitions: 3, events: 20, warmup: 5 });
    } else if (setters[flag] !== undefined) {
      setters[flag](argv[i + 1]);
      i += 1;
    } else {
      throw new Error(`unknown argument: ${flag}`);
    }
  }
  for (const key of ["repetitions", "events", "warmup"]) {
    if (!Number.isSafeInteger(options[key]) || options[key] < (key === "warmup" ? 0 : 1)) {
      throw new Error(`--${key} must be a positive integer`);
    }
  }
  return options;
}

/** The installed version of `name`, read from the nearest `node_modules` (ESM-only `exports` hide package.json). */
function versionOf(name) {
  for (let dir = new URL("../", import.meta.url); ; dir = new URL("../", dir)) {
    const manifest = new URL(`node_modules/${name}/package.json`, dir);
    if (existsSync(manifest)) return JSON.parse(readFileSync(manifest, "utf-8")).version;
    if (dir.pathname === "/") return null;
  }
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

/** Nearest-rank percentile over sorted samples. */
function percentile(sorted, p) {
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
}

function summarize(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const mean = samples.reduce((s, x) => s + x, 0) / samples.length;
  const sd = Math.sqrt(samples.reduce((s, x) => s + (x - mean) ** 2, 0) / samples.length);
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    unit: "microseconds-per-event",
    samples: samples.map(round),
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    minimum: round(sorted[0]),
    maximum: round(sorted.at(-1)),
    standardDeviation: round(sd),
  };
}

const identityScanner = (text) => ({ text, findings: [] });

async function hostRunners(host) {
  if (host === "pino" || host === "pino-streamwrite") {
    const pino = (await import("pino")).default;
    const { createRedactingLogMethodWith, createRedactingStreamWriteWith } = await import(
      "@redact-secret/adapter-pino"
    );
    const destination = { write() {} };
    const make = (scanner) => {
      const hooks = scanner === undefined ? {} : { logMethod: createRedactingLogMethodWith(scanner) };
      if (scanner !== undefined && host === "pino-streamwrite")
        hooks.streamWrite = createRedactingStreamWriteWith(scanner);
      const logger = pino({ base: null, timestamp: false, hooks }, destination);
      return (event) => logger.info(event.fields, event.message, ...event.args);
    };
    return make;
  }
  if (host === "otel-js") {
    const { BasicTracerProvider, SimpleSpanProcessor } = await import("@opentelemetry/sdk-trace-base");
    const { RedactingSpanProcessorWith } = await import("@redact-secret/adapter-otel");
    const exporter = { export: (_spans, done) => done({ code: 0 }), shutdown: () => Promise.resolve() };
    return (scanner) => {
      const simple = new SimpleSpanProcessor(exporter);
      const processor = scanner === undefined ? simple : new RedactingSpanProcessorWith(simple, scanner);
      const tracer = new BasicTracerProvider({ spanProcessors: [processor] }).getTracer("overhead");
      return (event) => {
        const span = tracer.startSpan(event.name);
        span.setAttributes(event.attributes);
        for (const e of event.events) span.addEvent(e.name, e.attributes);
        span.end();
      };
    };
  }
  if (host === "mask-js") {
    const { maskSecretsWith } = await import("@redact-secret/adapter");
    // There is no host around a masking callback: the baseline is the empty call.
    return (scanner) => (scanner === undefined ? () => undefined : (event) => maskSecretsWith(scanner, event));
  }
  throw new Error(`unknown host: ${host}`);
}

async function measurePair(host, profile, events, core, options) {
  const make = await hostRunners(host);
  // The leaves the adapter hands the core, per event, recorded once.
  const leaves = events.map((event) => {
    const recorded = [];
    make((text) => {
      recorded.push(text);
      return identityScanner(text);
    })(event);
    return recorded;
  });
  const runners = {
    host: make(undefined),
    "adapter-identity": make(identityScanner),
    "adapter-core": make(core.scanAndRedact),
    "core-direct": (() => {
      let cursor = 0;
      return () => {
        for (const text of leaves[cursor]) core.scanAndRedact(text);
        cursor = (cursor + 1) % leaves.length;
      };
    })(),
  };
  // core-direct keeps its own cursor so it walks the same event order as the others.
  const run = (mode, count) => {
    const runner = runners[mode];
    for (let k = 0; k < count; k += 1) runner(events[k % events.length]);
  };
  for (const mode of MODES) run(mode, options.warmup);
  const samples = Object.fromEntries(MODES.map((mode) => [mode, []]));
  for (let rep = 0; rep < options.repetitions; rep += 1) {
    for (let m = 0; m < MODES.length; m += 1) {
      const mode = MODES[(m + rep) % MODES.length];
      const started = process.hrtime.bigint();
      run(mode, options.events);
      samples[mode].push(Number(process.hrtime.bigint() - started) / 1000 / options.events);
    }
  }
  const modes = Object.fromEntries(MODES.map((mode) => [mode, summarize(samples[mode])]));
  const median = (mode) => modes[mode].median;
  const round = (x) => Math.round(x * 1000) / 1000;
  const scannerCalls = leaves.reduce((s, l) => s + l.length, 0) / leaves.length;
  const leafChars = leaves.reduce((s, l) => s + l.reduce((t, x) => t + x.length, 0), 0) / leaves.length;
  return {
    host,
    profileId: profile.id,
    scannerCallsPerEvent: round(scannerCalls),
    scannedCodeUnitsPerEvent: round(leafChars),
    modes,
    derived: {
      unit: "microseconds-per-event",
      basis: "difference of per-mode medians",
      traversal: round(median("adapter-identity") - median("host")),
      coreScan: median("core-direct"),
      adapterOverhead: round(median("adapter-core") - median("host")),
      unattributed: round(median("adapter-core") - median("adapter-identity") - median("core-direct")),
    },
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const loadAtStart = os.loadavg();
  const document = loadProfiles();
  const core = await import("@redact-secret/core");
  await core.initialize();
  const results = [];
  for (const profile of document.profiles) {
    if (options.profiles !== undefined && !options.profiles.includes(profile.id)) continue;
    const events = buildEvents(document, profile);
    for (const host of profile.hosts.filter((h) => options.hosts.includes(h) && HOSTS.includes(h))) {
      const result = await measurePair(host, profile, events, core, options);
      results.push(result);
      const d = result.derived;
      console.error(
        `${host}/${profile.id}: host ${result.modes.host.median}µs, traversal ${d.traversal}µs, core ${d.coreScan}µs, overhead ${d.adapterOverhead}µs per event`,
      );
    }
  }
  const cpus = os.cpus();
  const output = {
    schema: "redact-secret-adapters/overhead-v1",
    language: "javascript",
    measuredAt: new Date().toISOString(),
    source: { repository: "redact-secret/redact-secret-adapters", ...gitState() },
    workloads: {
      file: "fixtures/overhead-profiles.json",
      schemaVersion: document.schemaVersion,
      digest: workloadDigest(document),
    },
    environment: {
      os: `${os.platform()}-${os.release()}`,
      platform: os.platform(),
      arch: os.arch(),
      cpuModel: cpus[0]?.model ?? null,
      logicalCpus: cpus.length,
      totalMemoryBytes: os.totalmem(),
      runtime: `node-${process.versions.node}`,
      // Other work on the machine is the main source of noise between runs.
      loadAverage1m: { start: loadAtStart[0], end: os.loadavg()[0] },
      packages: Object.fromEntries(
        [
          "@redact-secret/core",
          "@redact-secret/adapter",
          "@redact-secret/adapter-pino",
          "@redact-secret/adapter-otel",
          "pino",
          "@opentelemetry/sdk-trace-base",
        ].map((name) => [name, versionOf(name)]),
      ),
    },
    method: {
      quick: process.argv.includes("--quick"),
      repetitions: options.repetitions,
      eventsPerRepetition: options.events,
      warmupEventsPerMode: options.warmup,
      distinctEvents: document.distinctEvents,
      order: "modes interleaved within each repetition, rotated by one position per repetition",
      clock: "process.hrtime.bigint",
      percentile: "nearest-rank",
      processes: 1,
    },
    results,
    limitations: [
      "Host-dependent: these numbers describe this machine and runtime only.",
      "Per-event times are batch means over eventsPerRepetition events; the distribution is across repetitions, not across single events.",
      "derived values are differences of medians, not medians of differences, and can be negative within noise.",
      "The OpenTelemetry exporter is a no-op, so export cost is excluded; pino writes to a no-op destination, so I/O cost is excluded.",
      "This output carries no threshold and no verdict.",
    ],
  };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (options.out === "-") process.stdout.write(text);
  else writeFileSync(options.out, text);
}

await main();
