#!/usr/bin/env node
/**
 * A local, allowlisted support summary (redact-secret/redact-secret-adapters#186).
 *
 *   node scripts/support-summary.mjs                       # Markdown: summary + where to report
 *   node scripts/support-summary.mjs --json                # the summary object only
 *   node scripts/support-summary.mjs --python              # also read installed Python package versions
 *   node scripts/support-summary.mjs --adapter adapter-ai-context \
 *       --outcome blocked --outcome core_error --outcome INITIALIZATION_FAILED \
 *       --activation "credentials=full;selectors=off;families=;vocabulary=pii-context/v2"
 *
 * Run it from the project that has the packages installed. It is one file with
 * no dependencies, so it can be copied out of this repository and run as is;
 * it is deliberately not a published package or a bin (see docs/support.md).
 *
 * The output is built from a closed set of fields, each filled from a closed
 * source, and every value is validated against a strict pattern or enum before
 * it is kept. Nothing else can reach it:
 *
 * - Node runtime version, platform and architecture (enum), from `process`.
 * - The `version` field of `node_modules/<name>/package.json` for a fixed list
 *   of package names, kept only if it is a plain ASCII SemVer string.
 * - With `--python`, two fixed `importlib.metadata` lookups, parsed and
 *   validated the same way.
 * - `--adapter`, `--outcome` and `--activation`, which the user supplies, only
 *   if they match a fixed id/code list or the core's activation-identity shape.
 * - Reference data from the generated `site-feed/v1/adapters.json`, read only
 *   if it sits beside this script (it does not, when the file was copied out).
 *
 * It never reads environment variables into the output, input, logs, exception
 * messages, paths, hostnames or raw configuration; never serializes an
 * arbitrary object; never loads or initializes `@redact-secret/core` (so the
 * PII activation state is reported only when the user supplies it); and never
 * touches the network. An invalid argument is rejected with a fixed message
 * that does not repeat it.
 *
 * Importing this module runs nothing; the pure helpers are exported for
 * scripts/test/support-summary.test.mjs.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const SCHEMA_VERSION = "redact-secret-adapters.support-summary/v1";

/** Packages whose installed version is reported, and the ids `--adapter` accepts. */
export const NPM_PACKAGES = Object.freeze([
  "@redact-secret/core",
  "@redact-secret/adapter",
  "@redact-secret/adapter-pino",
  "@redact-secret/adapter-otel-trace",
  "@redact-secret/adapter-otel",
  "@redact-secret/adapter-otel-logs",
  "@redact-secret/adapter-ai-context",
  "@redact-secret/adapter-mcp",
  "pino",
  "@opentelemetry/api",
  "@opentelemetry/sdk-trace-base",
  "@opentelemetry/sdk-logs",
  "@modelcontextprotocol/sdk",
]);
export const PYTHON_PACKAGES = Object.freeze(["redact-secret-adapters", "redact-secret"]);
export const ADAPTER_IDS = Object.freeze([
  "adapter",
  "adapter-pino",
  "adapter-otel-trace",
  "adapter-otel",
  "adapter-otel-logs",
  "adapter-ai-context",
  "adapter-mcp",
  "python",
]);

/** Fixed outcome vocabulary: the AI-context outcomes, block reasons, readiness statuses and core error codes. */
export const OUTCOME_CODES = Object.freeze([
  "ok",
  "blocked",
  "aborted",
  "policy",
  "limit_exceeded",
  "unsupported_value",
  "lifecycle",
  "core_error",
  "ready",
  "invalid_options",
  "core_unavailable",
  "initialization_failed",
  "pii_activation_unsupported",
  "pii_activation_not_active",
  "malformed_response",
  "probe_failed",
  "probe_not_redacted",
  "INVALID_INPUT",
  "INVALID_OPTIONS",
  "INVALID_DETECTOR",
  "DETECTOR_FAILURE",
  "INVALID_CANDIDATE",
  "POLICY_FAILURE",
  "INVALID_POLICY_ACTION",
  "INVALID_FINDINGS",
  "PLACEHOLDER_FAILURE",
  "INVALID_PLACEHOLDER",
  "INVALID_LIMITS",
  "INPUT_LIMIT_EXCEEDED",
  "FINDING_LIMIT_EXCEEDED",
  "BUFFER_LIMIT_EXCEEDED",
  "TOKEN_LIMIT_EXCEEDED",
  "MULTILINE_LIMIT_EXCEEDED",
  "INVALID_STATE",
  "INVALID_RULESET",
  "NOT_INITIALIZED",
  "INITIALIZATION_FAILED",
  "INVALID_CHUNK",
  "INVALID_UTF8",
  "UNPAIRED_SURROGATE",
]);
export const MAX_OUTCOMES = 16;

const PLATFORMS = Object.freeze(["darwin", "linux", "win32", "freebsd", "openbsd", "sunos", "aix"]);
const ARCHES = Object.freeze(["x64", "arm64", "arm", "ia32", "ppc64", "s390x", "riscv64"]);
const VERSION = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}(?:-[0-9A-Za-z.-]{1,40})?(?:\+[0-9A-Za-z.-]{1,40})?$/;
/** The core's activation identity, e.g. `credentials=full;selectors=off;families=;vocabulary=pii-context/v2`. */
const ACTIVATION = /^[A-Za-z0-9=;:,._/-]{1,512}$/;
const DATE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}(?:T[0-9:.]{1,16}Z)?$/;

export const ROUTES = Object.freeze({
  detection: {
    when: "A secret was missed, or text was masked that should not have been (false negative / false positive).",
    repository: "https://github.com/redact-secret/redact-secret/issues",
  },
  integration: {
    when: "An adapter failed to initialize, blocked unexpectedly, or misbehaved inside its host (pino, OpenTelemetry, MCP, AI context, Python logging).",
    repository: "https://github.com/redact-secret/redact-secret-adapters/issues",
  },
  benchmark: {
    when: "A performance or benchmark result is disputed.",
    repository: "https://github.com/redact-secret/redact-secret-benchmarks/issues",
  },
  vulnerability: {
    when: "You suspect a vulnerability. Do not open a public issue.",
    repository: "https://github.com/redact-secret/redact-secret-adapters/security/advisories/new",
  },
});

/** `value` when it is a plain ASCII SemVer string, else `undefined`. */
export function cleanVersion(value) {
  return typeof value === "string" && VERSION.test(value) ? value : undefined;
}

/** Looks for `node_modules/<name>/package.json` from `start` upwards; returns only a validated version. */
export function installedVersion(name, start = process.cwd()) {
  let dir = start;
  for (;;) {
    const file = join(dir, "node_modules", name, "package.json");
    if (existsSync(file)) {
      try {
        return { status: "installed", version: cleanVersion(JSON.parse(readFileSync(file, "utf8")).version) };
      } catch {
        return { status: "installed", version: undefined };
      }
    }
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) return { status: "not_found", version: undefined };
    dir = parent;
  }
}

const PYTHON_PROBE = [
  "import sys, json, importlib.metadata as m",
  "o = {'python': '%d.%d.%d' % sys.version_info[:3], 'packages': {}}",
  `for n in ${JSON.stringify(PYTHON_PACKAGES)}:`,
  "    try: o['packages'][n] = m.version(n)",
  "    except Exception: pass",
  "print(json.dumps(o))",
].join("\n");

/** Fixed `python3`/`python` lookup. The interpreter is never chosen by the caller. */
export function pythonFacts(run = execFileSync) {
  for (const exe of ["python3", "python"]) {
    try {
      const out = run(exe, ["-c", PYTHON_PROBE], {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
        env: { PATH: process.env.PATH ?? "" },
      });
      const parsed = JSON.parse(out);
      const packages = PYTHON_PACKAGES.map((name) => ({
        name,
        version: cleanVersion(parsed?.packages?.[name]) ?? null,
      }));
      return { status: "collected", python: cleanVersion(parsed?.python) ?? null, packages };
    } catch {
      // Try the next interpreter name; nothing about the failure is kept.
    }
  }
  return { status: "unavailable", python: null, packages: [] };
}

/** The reference release feed (generated data), when it sits beside this script. */
export function referenceFeed(feedPath) {
  try {
    if (feedPath === undefined || !existsSync(feedPath))
      return { status: "unavailable", generatedAt: null, versions: {} };
    const feed = JSON.parse(readFileSync(feedPath, "utf8"));
    const versions = {};
    for (const entry of Array.isArray(feed.packages) ? feed.packages : []) {
      if (NPM_PACKAGES.includes(entry?.name) && cleanVersion(entry.version) !== undefined) {
        versions[entry.name] = entry.version;
      }
    }
    const generatedAt = typeof feed.generatedAt === "string" && DATE.test(feed.generatedAt) ? feed.generatedAt : null;
    return { status: "available", generatedAt, versions };
  } catch {
    return { status: "unavailable", generatedAt: null, versions: {} };
  }
}

/**
 * Builds the summary from already-gathered facts, copying each field by name
 * and validating it. Anything outside the allowlist is dropped.
 */
export function buildSummary(facts) {
  const node = cleanVersion(facts.node) ?? null;
  const reference = facts.reference ?? { status: "unavailable", generatedAt: null, versions: {} };
  const installed = NPM_PACKAGES.map((name) => {
    const found = facts.installed?.[name] ?? { status: "not_found", version: undefined };
    const version = cleanVersion(found.version) ?? null;
    const referenceVersion = cleanVersion(reference.versions?.[name]) ?? null;
    let relation = "no_reference";
    if (version === null) relation = found.status === "installed" ? "version_unreadable" : "not_installed";
    else if (referenceVersion !== null)
      relation = version === referenceVersion ? "same_as_reference" : "differs_from_reference";
    return {
      name,
      status: found.status === "installed" ? "installed" : "not_found",
      version,
      referenceVersion,
      relation,
    };
  });
  const python = facts.python ?? { status: "not_requested", python: null, packages: [] };
  return {
    schema: SCHEMA_VERSION,
    runtime: {
      node,
      platform: PLATFORMS.includes(facts.platform) ? facts.platform : "other",
      arch: ARCHES.includes(facts.arch) ? facts.arch : "other",
    },
    adapter: ADAPTER_IDS.includes(facts.adapter) ? facts.adapter : null,
    installed,
    python: {
      status: ["not_requested", "collected", "unavailable"].includes(python.status) ? python.status : "unavailable",
      version: cleanVersion(python.python) ?? null,
      packages: PYTHON_PACKAGES.map((name) => ({
        name,
        version: cleanVersion(python.packages?.find?.((entry) => entry?.name === name)?.version) ?? null,
      })),
    },
    activation:
      typeof facts.activation === "string" && ACTIVATION.test(facts.activation)
        ? { status: "user_supplied", identity: facts.activation }
        : { status: "not_provided", identity: null },
    outcomes: (Array.isArray(facts.outcomes) ? facts.outcomes : [])
      .filter((code) => OUTCOME_CODES.includes(code))
      .slice(0, MAX_OUTCOMES),
    reference: {
      source: reference.status === "available" ? "site-feed/v1/adapters.json" : "unavailable",
      generatedAt:
        typeof reference.generatedAt === "string" && DATE.test(reference.generatedAt) ? reference.generatedAt : null,
      note: "Reference versions are the latest release this repository documents. They are not your installed versions and not a statement that a combination is supported.",
    },
  };
}

/** The human-readable report: the summary, then where it belongs. */
export function renderMarkdown(summary) {
  const lines = [
    "<!-- Review before posting. Contains only the fields below; no environment, paths, hostnames, logs or input. -->",
    "```json",
    JSON.stringify(summary, null, 2),
    "```",
    "",
    "Where to report (use the repository's issue form where one exists; reproduce with synthetic values only):",
  ];
  for (const [kind, route] of Object.entries(ROUTES)) lines.push(`- ${kind}: ${route.when} -> ${route.repository}`);
  lines.push("", "Never paste a real credential, production log or customer data into an issue.");
  return `${lines.join("\n")}\n`;
}

const FLAGS = Object.freeze({
  "--adapter": "value",
  "--activation": "value",
  "--outcome": "value",
  "--python": "bool",
  "--json": "bool",
  "--help": "bool",
});

/** Parses argv into options. Throws `UsageError` with a fixed message that never repeats the input. */
export class UsageError extends Error {}

export function parseArgs(argv) {
  const options = { adapter: undefined, activation: undefined, outcomes: [], python: false, json: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const kind = Object.hasOwn(FLAGS, argv[i]) ? FLAGS[argv[i]] : undefined;
    if (kind === undefined) throw new UsageError("unknown argument; see --help");
    const flag = argv[i];
    if (kind === "bool") {
      options[flag.slice(2)] = true;
      continue;
    }
    const value = argv[++i];
    if (typeof value !== "string") throw new UsageError(`${flag} needs a value`);
    if (flag === "--adapter") {
      if (!ADAPTER_IDS.includes(value)) throw new UsageError("--adapter is not a known adapter id");
      options.adapter = value;
    } else if (flag === "--activation") {
      if (!ACTIVATION.test(value)) throw new UsageError("--activation is not a PII activation identity");
      options.activation = value;
    } else {
      if (!OUTCOME_CODES.includes(value)) throw new UsageError("--outcome is not a known outcome code");
      if (options.outcomes.length >= MAX_OUTCOMES) throw new UsageError("too many --outcome values");
      options.outcomes.push(value);
    }
  }
  return options;
}

export const USAGE = `Usage: node scripts/support-summary.mjs [--json] [--python] [--adapter <id>] [--outcome <code>]... [--activation <identity>]

Prints a local, copyable support summary. Nothing is uploaded.
  --adapter     one of: ${ADAPTER_IDS.join(", ")}
  --outcome     a fixed outcome code (repeatable, at most ${MAX_OUTCOMES}), e.g. blocked, core_error, INITIALIZATION_FAILED
  --activation  the core's PII activation identity, if you have it (this tool never loads the core)
  --python      also read the installed Python package versions
  --json        print the summary object only
`;

export function main(argv, { out = process.stdout, err = process.stderr, cwd = process.cwd() } = {}) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    err.write(`${error instanceof UsageError ? error.message : "invalid arguments"}\n`);
    return 2;
  }
  if (options.help) {
    out.write(USAGE);
    return 0;
  }
  const installed = {};
  for (const name of NPM_PACKAGES) installed[name] = installedVersion(name, cwd);
  const feedPath = join(dirname(fileURLToPath(import.meta.url)), "..", "site-feed", "v1", "adapters.json");
  const summary = buildSummary({
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    adapter: options.adapter,
    installed,
    python: options.python ? pythonFacts() : undefined,
    activation: options.activation,
    outcomes: options.outcomes,
    reference: referenceFeed(feedPath),
  });
  out.write(options.json ? `${JSON.stringify(summary, null, 2)}\n` : renderMarkdown(summary));
  return 0;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = main(process.argv.slice(2));
}
