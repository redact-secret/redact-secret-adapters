#!/usr/bin/env node
/**
 * Adapter-only operational overhead (#11), JavaScript hosts. Measures and
 * records; it carries no threshold and no verdict. Budgets and judgement
 * belong to redact-secret-benchmarks, which consumes this file's output.
 *
 *   npm run build
 *   node scripts/measure-overhead.mjs --out overhead-js.json
 *   node scripts/measure-overhead.mjs --quick --out -        # CI smoke: shape only, numbers meaningless
 *   node scripts/install-overhead-baseline.mjs /tmp/baseline
 *   node scripts/measure-overhead.mjs --baseline /tmp/baseline --out overhead-js.json   # previous release vs current, same session
 *
 * Package size and initialization time are measured separately, by
 * `scripts/measure-footprint.mjs`: both are one-off costs, not per event.
 *
 * For every (host, profile) pair it times four modes over the same events,
 * interleaved and rotated per repetition so drift spreads evenly:
 *
 *   host              the host alone (pino, an OpenTelemetry provider), no adapter
 *   adapter-identity  host + adapter over a scanner that finds nothing: traversal and seam cost only
 *   adapter-core      host + adapter over the real `@redact-secret/core`
 *   core-direct       the real core called directly on exactly the leaves the adapter hands it
 *
 * Each mode is measured in three separate passes, so one kind of measurement
 * never perturbs another:
 *
 *   batch     wall time over eventsPerRepetition events (the per-mode medians below)
 *   latency   every event timed on its own, for the tail (p95, p99, maximum)
 *   memory    bytes allocated and garbage collections, from v8.GCProfiler,
 *             after a forced collection so each repetition starts from the same heap
 *
 * and derives, from per-mode medians, `traversal` (adapter-identity − host),
 * `coreScan` (core-direct), `adapterOverhead` (adapter-core − host), and the
 * `unattributed` remainder. Core scan time is therefore never folded into
 * traversal, and neither is folded into host time.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import v8 from "node:v8";
import { runInNewContext } from "node:vm";

import { buildEvents, loadProfiles, workloadDigest } from "./overhead-workloads.mjs";

const HOSTS = ["pino", "pino-streamwrite", "otel-js", "mask-js", "ai-context-js", "mcp-js", "mcp-stream-js"];
// Hosts whose host mode is the empty call: a ratio over it means nothing.
const HOSTLESS = new Set(["mask-js", "ai-context-js", "mcp-js", "mcp-stream-js"]);
const MODES = ["host", "adapter-identity", "adapter-core", "core-direct"];
// Under --baseline, the previous release's modes: the host alone is shared with the current build.
const BASELINE_MODES = ["adapter-identity", "adapter-core", "core-direct"];
const ADAPTER_PACKAGES = [
  "@redact-secret/adapter",
  "@redact-secret/adapter-pino",
  "@redact-secret/adapter-otel",
  "@redact-secret/adapter-ai-context",
  "@redact-secret/adapter-mcp",
];

function parseArgs(argv) {
  const options = { out: "-", repetitions: 15, events: 400, warmup: 200, hosts: HOSTS, profiles: undefined };
  const setters = {
    "--out": (value) => (options.out = value),
    "--repetitions": (value) => (options.repetitions = Number(value)),
    "--events": (value) => (options.events = Number(value)),
    "--warmup": (value) => (options.warmup = Number(value)),
    "--host": (value) => (options.hosts = value.split(",")),
    "--profile": (value) => (options.profiles = value.split(",")),
    "--baseline": (value) => (options.baseline = value),
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

/**
 * Imports adapter packages from a previous release installed under `prefix`
 * (`prefix/node_modules/@redact-secret/adapter*`, e.g. by
 * scripts/install-overhead-baseline.mjs), by each package's own `exports`.
 */
function baselineFrom(prefix) {
  const root = pathToFileURL(`${resolve(prefix)}/`);
  const manifest = (name) => {
    const file = new URL(`node_modules/${name}/package.json`, root);
    return existsSync(file) ? JSON.parse(readFileSync(file, "utf-8")) : null;
  };
  return {
    packages: Object.fromEntries(ADAPTER_PACKAGES.map((name) => [name, manifest(name)?.version ?? null])),
    load: async (name) => {
      const found = manifest(name);
      if (found === null) throw new Error(`${name} is not installed in the baseline`);
      const entry = found.exports?.["."]?.import ?? found.exports?.["."]?.default ?? found.main ?? "index.js";
      return import(new URL(`node_modules/${name}/${entry.replace(/^\.\//, "")}`, root).href);
    },
  };
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

/** Summary of single-event latencies, pooled over every repetition. */
function summarizeLatency(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    unit: "microseconds",
    count: sorted.length,
    median: round(percentile(sorted, 0.5)),
    p95: round(percentile(sorted, 0.95)),
    p99: round(percentile(sorted, 0.99)),
    maximum: round(sorted.at(-1)),
  };
}

/** Median over repetitions of allocation and collection cost, per event. */
function summarizeMemory(repetitions, events) {
  const median = (values) =>
    percentile(
      [...values].sort((a, b) => a - b),
      0.5,
    );
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    basis: "v8.GCProfiler: used-heap growth plus the heap every collection reclaimed",
    allocatedBytesPerEvent: round(median(repetitions.map((r) => r.allocatedBytes)) / events),
    peakBytes: null,
    gcCountPerEvent: round(median(repetitions.map((r) => r.gcCount)) / events),
    gcPauseMicrosecondsPerEvent: round(median(repetitions.map((r) => r.gcPauseMicroseconds)) / events),
  };
}

// A forced collection before each memory repetition, without requiring --expose-gc on the command line.
v8.setFlagsFromString("--expose-gc");
const collectGarbage = runInNewContext("gc");

/** Bytes allocated while `work` runs: heap growth plus what every collection during it reclaimed. */
async function measureAllocation(work) {
  collectGarbage();
  const profiler = new v8.GCProfiler();
  profiler.start();
  const before = v8.getHeapStatistics().used_heap_size;
  const pending = work();
  if (pending !== undefined) await pending;
  const after = v8.getHeapStatistics().used_heap_size;
  const { statistics } = profiler.stop();
  let reclaimed = 0;
  let pause = 0;
  for (const gc of statistics) {
    reclaimed += gc.beforeGC.heapStatistics.usedHeapSize - gc.afterGC.heapStatistics.usedHeapSize;
    pause += gc.cost;
  }
  return { allocatedBytes: after - before + reclaimed, gcCount: statistics.length, gcPauseMicroseconds: pause };
}

const identityScanner = (text) => ({ text, findings: [] });

/**
 * For each host, `make(scanner)` returns a runner for one event. A host whose
 * runners are async sets `make.async`; every pass then awaits each event, and
 * only for that host, so the synchronous hosts are timed exactly as before. A
 * host whose core-direct is not "scan each recorded leaf" sets
 * `make.coreDirect(event)`. `load` imports an adapter package: the current
 * build, or a previous release under --baseline; hosts always come from here.
 */
async function hostRunners(host, core, load) {
  if (host === "pino" || host === "pino-streamwrite") {
    const pino = (await import("pino")).default;
    const { createRedactingLogMethodWith, createRedactingStreamWriteWith } = await load("@redact-secret/adapter-pino");
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
    const { RedactingSpanProcessorWith } = await load("@redact-secret/adapter-otel");
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
    const { maskSecretsWith } = await load("@redact-secret/adapter");
    // There is no host around a masking callback: the baseline is the empty call.
    return (scanner) => (scanner === undefined ? () => undefined : (event) => maskSecretsWith(scanner, event));
  }
  if (host === "ai-context-js") {
    const { createAiContextBoundaryWith } = await load("@redact-secret/adapter-ai-context");
    const { AI_CONTEXT_LIMITS, contextParts } = await import("./overhead-workloads.mjs");
    // The streaming path is not exercised: this profile is whole-input
    // context construction, the boundary every agent turn crosses.
    const unusedSession = () => {
      throw new Error("overhead harness: no incremental session is measured");
    };
    return (scanner) => {
      if (scanner === undefined) return () => undefined;
      const boundary = createAiContextBoundaryWith(
        { scanAndRedact: scanner, createIncrementalSanitizer: unusedSession },
        AI_CONTEXT_LIMITS,
      );
      return (event) => {
        const outcome = boundary.buildContext(contextParts(event));
        if (outcome.outcome !== "ok") throw new Error(`overhead harness: ai-context-js ${outcome.outcome}`);
      };
    };
  }
  if (host === "mcp-js") {
    const { createAiContextBoundaryWith } = await load("@redact-secret/adapter-ai-context");
    const { createMcpBoundaryWith } = await load("@redact-secret/adapter-mcp");
    const { AI_CONTEXT_LIMITS, mcpToolResult } = await import("./overhead-workloads.mjs");
    const unusedSession = () => {
      throw new Error("overhead harness: mcp-js measures no incremental session");
    };
    // Whole-input: one tool result per event, through the MCP boundary's result handling.
    return (scanner) => {
      if (scanner === undefined) return () => undefined;
      const mcp = createMcpBoundaryWith(
        createAiContextBoundaryWith(
          { scanAndRedact: scanner, createIncrementalSanitizer: unusedSession },
          AI_CONTEXT_LIMITS,
        ),
      );
      return (event) => {
        const outcome = mcp.sanitizeToolResult(mcpToolResult(event));
        if (outcome.outcome !== "ok") throw new Error(`overhead harness: mcp-js ${outcome.outcome}`);
      };
    };
  }
  if (host === "mcp-stream-js") {
    const { createAiContextBoundaryWith } = await load("@redact-secret/adapter-ai-context");
    const { createMcpBoundaryWith } = await load("@redact-secret/adapter-mcp");
    const { AI_CONTEXT_LIMITS, mcpChunks } = await import("./overhead-workloads.mjs");
    const unusedScan = () => {
      throw new Error("overhead harness: mcp-stream-js measures no whole-input scan");
    };
    // The core's incremental session for the real core; otherwise a session
    // that hands each chunk to the scanner (identity, or the leaf recorder).
    const sessionFor = (scanner) =>
      scanner === core.scanAndRedact
        ? core.createIncrementalSanitizer
        : () => ({ append: (chunk) => scanner(chunk), finalize: () => ({ text: "", findings: [] }), abort() {} });
    const make = (scanner) => {
      if (scanner === undefined) return async () => undefined;
      const mcp = createMcpBoundaryWith(
        createAiContextBoundaryWith(
          { scanAndRedact: unusedScan, createIncrementalSanitizer: sessionFor(scanner) },
          AI_CONTEXT_LIMITS,
        ),
      );
      return async (event) => {
        const outcome = await mcp.sanitizeStreamedToolResult(mcpChunks(event));
        if (outcome.outcome !== "ok") throw new Error(`overhead harness: mcp-stream-js ${outcome.outcome}`);
      };
    };
    make.async = true;
    // The core's own incremental session over the same chunks, not whole-input scans of them.
    make.coreDirect = (event) => {
      const session = core.createIncrementalSanitizer({ limits: AI_CONTEXT_LIMITS.incrementalLimits });
      for (const chunk of mcpChunks(event)) session.append(chunk);
      session.finalize();
    };
    return make;
  }
  throw new Error(`unknown host: ${host}`);
}

/** The four mode runners for one build of the adapters, and the leaves its core-direct scans. */
async function buildRunners(make, events, core) {
  // The leaves the adapter hands the core, per event, recorded once. This also
  // runs every event through the build once, so a build that cannot run fails here.
  const leaves = [];
  for (const event of events) {
    const recorded = [];
    await make((text) => {
      recorded.push(text);
      return identityScanner(text);
    })(event);
    leaves.push(recorded);
  }
  const runners = {
    host: make(undefined),
    "adapter-identity": make(identityScanner),
    "adapter-core": make(core.scanAndRedact),
    // core-direct keeps its own cursor so it walks the same event order as the others.
    "core-direct": (() => {
      if (make.coreDirect !== undefined) return make.coreDirect;
      let cursor = 0;
      return () => {
        for (const text of leaves[cursor]) core.scanAndRedact(text);
        cursor = (cursor + 1) % leaves.length;
      };
    })(),
  };
  const round = (x) => Math.round(x * 1000) / 1000;
  return {
    runners,
    scannerCallsPerEvent: round(leaves.reduce((s, l) => s + l.length, 0) / leaves.length),
    scannedCodeUnitsPerEvent: round(
      leaves.reduce((s, l) => s + l.reduce((t, x) => t + x.length, 0), 0) / leaves.length,
    ),
  };
}

/** The derived costs from one build's per-mode summaries. */
function derive(host, modes) {
  const median = (mode) => modes[mode].median;
  const round = (x) => Math.round(x * 1000) / 1000;
  const overhead = median("adapter-core") - median("host");
  return {
    unit: "microseconds-per-event",
    basis: "difference of per-mode medians",
    traversal: round(median("adapter-identity") - median("host")),
    coreScan: median("core-direct"),
    adapterOverhead: round(overhead),
    unattributed: round(median("adapter-core") - median("adapter-identity") - median("core-direct")),
    traversalAllocatedBytes: round(
      modes["adapter-identity"].memory.allocatedBytesPerEvent - modes.host.memory.allocatedBytesPerEvent,
    ),
    // adapterOverhead as a fraction of the host's own time; comparable across machines where µs are not.
    adapterOverheadRatio: HOSTLESS.has(host) || !(modes.host.median > 0) ? null : round(overhead / modes.host.median),
  };
}

/** The values compared between the baseline and the current build, by name. */
const COMPARED = {
  traversal: (r) => r.derived.traversal,
  adapterOverhead: (r) => r.derived.adapterOverhead,
  adapterOverheadRatio: (r) => r.derived.adapterOverheadRatio,
  coreScan: (r) => r.derived.coreScan,
  traversalAllocatedBytes: (r) => r.derived.traversalAllocatedBytes,
  adapterCoreLatencyP95: (r) => r.modes["adapter-core"].latency.p95,
  adapterCoreLatencyP99: (r) => r.modes["adapter-core"].latency.p99,
  adapterCoreAllocatedBytesPerEvent: (r) => r.modes["adapter-core"].memory.allocatedBytesPerEvent,
  scannerCallsPerEvent: (r) => r.scannerCallsPerEvent,
};

/** Baseline → current for every compared value: a record, not a verdict. */
function compare(baseline, current) {
  const round = (x) => Math.round(x * 1000) / 1000;
  return Object.fromEntries(
    Object.entries(COMPARED).map(([name, read]) => {
      const before = read(baseline);
      const after = read(current);
      const usable = typeof before === "number" && typeof after === "number";
      return [
        name,
        {
          baseline: before ?? null,
          current: after ?? null,
          difference: usable ? round(after - before) : null,
          relative: usable && before !== 0 ? round((after - before) / Math.abs(before)) : null,
        },
      ];
    }),
  );
}

async function measurePair(host, profile, events, core, options, baseline) {
  const make = await hostRunners(host, core, (name) => import(name));
  const isAsync = make.async === true;
  // A heavy profile caps its own batch so a full run stays bounded; --quick still wins when smaller.
  const perRepetition = Math.min(options.events, profile.maxEventsPerRepetition ?? Number.POSITIVE_INFINITY);
  const current = await buildRunners(make, events, core);
  const runners = { ...current.runners };
  let order = MODES;
  let previous;
  let unavailable = null;
  if (baseline !== undefined) {
    try {
      previous = await buildRunners(await hostRunners(host, core, baseline.load), events, core);
    } catch (error) {
      unavailable = { comparable: false, reason: `the baseline cannot run ${host}: ${error?.message ?? error}` };
    }
    if (previous !== undefined) {
      // The host alone is the same for both builds, so it is timed once.
      for (const mode of BASELINE_MODES) runners[`baseline:${mode}`] = previous.runners[mode];
      order = [...MODES, ...BASELINE_MODES.map((mode) => `baseline:${mode}`)];
    }
  }
  const run = isAsync
    ? async (mode, count) => {
        const runner = runners[mode];
        for (let k = 0; k < count; k += 1) await runner(events[k % events.length]);
      }
    : (mode, count) => {
        const runner = runners[mode];
        for (let k = 0; k < count; k += 1) runner(events[k % events.length]);
      };
  for (const mode of order) await run(mode, options.warmup);
  const samples = Object.fromEntries(order.map((mode) => [mode, []]));
  for (let rep = 0; rep < options.repetitions; rep += 1) {
    for (let m = 0; m < order.length; m += 1) {
      const mode = order[(m + rep) % order.length];
      const started = process.hrtime.bigint();
      if (isAsync) await run(mode, perRepetition);
      else run(mode, perRepetition);
      samples[mode].push(Number(process.hrtime.bigint() - started) / 1000 / perRepetition);
    }
  }
  const latencies = Object.fromEntries(order.map((mode) => [mode, []]));
  for (let rep = 0; rep < options.repetitions; rep += 1) {
    for (let m = 0; m < order.length; m += 1) {
      const mode = order[(m + rep) % order.length];
      const runner = runners[mode];
      for (let k = 0; k < perRepetition; k += 1) {
        const event = events[k % events.length];
        const started = process.hrtime.bigint();
        if (isAsync) await runner(event);
        else runner(event);
        latencies[mode].push(Number(process.hrtime.bigint() - started) / 1000);
      }
    }
  }
  const allocations = Object.fromEntries(order.map((mode) => [mode, []]));
  for (let rep = 0; rep < options.repetitions; rep += 1) {
    for (let m = 0; m < order.length; m += 1) {
      const mode = order[(m + rep) % order.length];
      allocations[mode].push(await measureAllocation(() => run(mode, perRepetition)));
    }
  }
  const summary = (key) => ({
    ...summarize(samples[key]),
    latency: summarizeLatency(latencies[key]),
    memory: summarizeMemory(allocations[key], perRepetition),
  });
  const modes = Object.fromEntries(MODES.map((mode) => [mode, summary(mode)]));
  const result = {
    host,
    profileId: profile.id,
    eventsPerRepetition: perRepetition,
    scannerCallsPerEvent: current.scannerCallsPerEvent,
    scannedCodeUnitsPerEvent: current.scannedCodeUnitsPerEvent,
    modes,
    derived: derive(host, modes),
  };
  if (previous !== undefined) {
    const baselineModes = Object.fromEntries(BASELINE_MODES.map((mode) => [mode, summary(`baseline:${mode}`)]));
    const measured = {
      comparable: true,
      scannerCallsPerEvent: previous.scannerCallsPerEvent,
      scannedCodeUnitsPerEvent: previous.scannedCodeUnitsPerEvent,
      modes: baselineModes,
      derived: derive(host, { host: modes.host, ...baselineModes }),
    };
    result.baseline = measured;
    result.change = compare(measured, result);
  } else if (unavailable !== null) {
    result.baseline = unavailable;
  }
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const loadAtStart = os.loadavg();
  const document = loadProfiles();
  const core = await import("@redact-secret/core");
  await core.initialize();
  const baseline = options.baseline === undefined ? undefined : baselineFrom(options.baseline);
  const results = [];
  for (const profile of document.profiles) {
    if (options.profiles !== undefined && !options.profiles.includes(profile.id)) continue;
    const events = buildEvents(document, profile);
    for (const host of profile.hosts.filter((h) => options.hosts.includes(h) && HOSTS.includes(h))) {
      const result = await measurePair(host, profile, events, core, options, baseline);
      results.push(result);
      const d = result.derived;
      console.error(
        `${host}/${profile.id}: host ${result.modes.host.median}µs, traversal ${d.traversal}µs, core ${d.coreScan}µs, overhead ${d.adapterOverhead}µs per event`,
      );
      if (result.change !== undefined) {
        const t = result.change.traversal;
        console.error(`  baseline traversal ${t.baseline}µs -> ${t.current}µs`);
      } else if (result.baseline !== undefined) {
        console.error(`  baseline not comparable: ${result.baseline.reason}`);
      }
    }
  }
  const cpus = os.cpus();
  const output = {
    schema: "redact-secret-adapters/overhead-v2",
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
      // Set by the container wrapper; null for a run outside one.
      containerImage: process.env.REDACT_SECRET_BENCH_IMAGE || null,
      // Other work on the machine is the main source of noise between runs.
      loadAverage1m: { start: loadAtStart[0], end: os.loadavg()[0] },
      packages: Object.fromEntries(
        [
          "@redact-secret/core",
          "@redact-secret/adapter",
          "@redact-secret/adapter-pino",
          "@redact-secret/adapter-otel",
          "@redact-secret/adapter-ai-context",
          "@redact-secret/adapter-mcp",
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
      passes: ["batch", "latency", "memory"],
      processes: 1,
    },
    // The previous release measured in this same session under --baseline; null otherwise.
    baseline:
      baseline === undefined
        ? null
        : {
            packages: baseline.packages,
            order:
              "the previous release's adapter-identity, adapter-core and core-direct interleaved with the current modes; host is shared",
            change: "per result: baseline to current, differences of medians; a record, not a verdict",
          },
    results,
    limitations: [
      "Host-dependent: these numbers describe this machine and runtime only.",
      "Per-event times are batch means over eventsPerRepetition events; the distribution is across repetitions, not across single events.",
      "Single-event latencies include one clock read of overhead each; memory repetitions start from a forced collection, which the batch and latency passes do not.",
      "memory counts the V8 heap only: native allocations inside the core are not included.",
      "derived values are differences of medians, not medians of differences, and can be negative within noise.",
      "The OpenTelemetry exporter is a no-op, so export cost is excluded; pino writes to a no-op destination, so I/O cost is excluded.",
      "mcp-js and mcp-stream-js have no host around them either: mcp-js measures sanitizeToolResult over one tool result per payload event, mcp-stream-js sanitizeStreamedToolResult over one chunk per message and tool result, awaited per event.",
      "ai-context-js has no host around it: its host mode is the empty call, and it measures buildContext over whole-input scans only, not a stream.",
      "This output carries no threshold and no verdict.",
    ],
  };
  const text = `${JSON.stringify(output, null, 2)}\n`;
  if (options.out === "-") process.stdout.write(text);
  else writeFileSync(options.out, text);
}

await main();
