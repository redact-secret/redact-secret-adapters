/**
 * `scripts/support-summary.mjs` (#186): the output is a closed, allowlisted
 * shape, and a synthetic sentinel placed in every source it could conceivably
 * read (environment, package metadata, feed, Python probe, arguments, paths)
 * never appears in it.
 */

import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import { expect, test } from "vitest";

import { BLOCK_REASONS, READINESS_STATUSES } from "../../packages/adapter-ai-context/src/index.ts";
import {
  buildSummary,
  cleanVersion,
  installedVersion,
  main,
  NPM_PACKAGES,
  OUTCOME_CODES,
  parseArgs,
  pythonFacts,
  ROUTES,
  referenceFeed,
  renderMarkdown,
} from "../support-summary.mjs";

const SENTINEL = "SENTINEL_SECRET_VALUE_9f3c";
const schema = JSON.parse(readFileSync(new URL("../support-summary.schema.json", import.meta.url), "utf8"));
const validate = new Ajv2020({ strict: false }).compile(schema);

/** A project directory with the given packages installed at the given (raw) versions. */
function project(packages) {
  const root = mkdtempSync(join(tmpdir(), `support-${SENTINEL}-`));
  for (const [name, version] of Object.entries(packages)) {
    const dir = join(root, "node_modules", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name, version, secret: SENTINEL }));
  }
  return root;
}

function run(argv, cwd) {
  let stdout = "";
  let stderr = "";
  const code = main(argv, { out: { write: (s) => (stdout += s) }, err: { write: (s) => (stderr += s) }, cwd });
  return { code, stdout, stderr };
}

test("output validates against the explicit schema, and rejects unexpected fields", () => {
  const summary = buildSummary({ node: "22.1.0", platform: "linux", arch: "x64", installed: {} });
  expect(validate(summary)).toBe(true);
  expect(validate({ ...summary, extra: 1 })).toBe(false);
  expect(validate({ ...summary, runtime: { ...summary.runtime, hostname: "h" } })).toBe(false);
});

test("missing packages are reported as not installed, honestly", () => {
  const cwd = project({ "@redact-secret/adapter": "0.1.7" });
  const { code, stdout } = run(["--json"], cwd);
  expect(code).toBe(0);
  const summary = JSON.parse(stdout);
  expect(validate(summary)).toBe(true);
  const byName = Object.fromEntries(summary.installed.map((entry) => [entry.name, entry]));
  expect(byName["@redact-secret/adapter"]).toMatchObject({ status: "installed", version: "0.1.7" });
  expect(byName["@redact-secret/adapter-pino"]).toMatchObject({
    status: "not_found",
    version: null,
    relation: "not_installed",
  });
});

test("mixed versions are shown next to reference data, not judged", () => {
  const reference = {
    status: "available",
    generatedAt: "2026-09-29T00:00:00Z",
    versions: { "@redact-secret/adapter": "0.1.7" },
  };
  const summary = buildSummary({
    installed: {
      "@redact-secret/adapter": { status: "installed", version: "0.0.1" },
      "@redact-secret/core": { status: "installed", version: "9.9.9" },
    },
    reference,
  });
  const byName = Object.fromEntries(summary.installed.map((entry) => [entry.name, entry]));
  expect(byName["@redact-secret/adapter"]).toMatchObject({
    relation: "differs_from_reference",
    referenceVersion: "0.1.7",
  });
  expect(byName["@redact-secret/core"].relation).toBe("no_reference");
  expect(summary.reference.generatedAt).toBe("2026-09-29T00:00:00Z");
  expect(summary.reference.note).toMatch(/not your installed versions/);
});

test("the generated feed is read offline, allowlisted, and tolerant of a missing or broken file", () => {
  const root = mkdtempSync(join(tmpdir(), "support-feed-"));
  const feed = join(root, "adapters.json");
  writeFileSync(
    feed,
    JSON.stringify({
      generatedAt: "2026-09-29T00:00:00Z",
      packages: [
        { name: "@redact-secret/adapter", version: "0.1.7", token: SENTINEL },
        { name: SENTINEL, version: "1.0.0" },
        { name: "pino", version: `1.0.0-${SENTINEL}‮` },
      ],
      extra: SENTINEL,
    }),
  );
  const read = referenceFeed(feed);
  expect(read).toEqual({
    status: "available",
    generatedAt: "2026-09-29T00:00:00Z",
    versions: { "@redact-secret/adapter": "0.1.7" },
  });
  expect(referenceFeed(join(root, "missing.json")).status).toBe("unavailable");
  writeFileSync(feed, "{ not json");
  expect(referenceFeed(feed).status).toBe("unavailable");
  expect(referenceFeed(undefined).status).toBe("unavailable");
});

test("the real repository feed is usable reference data", () => {
  const read = referenceFeed(new URL("../../site-feed/v1/adapters.json", import.meta.url).pathname);
  expect(read.status).toBe("available");
  expect(read.versions["@redact-secret/adapter"]).toMatch(/^\d+\.\d+\.\d+/);
});

test("version strings: only plain ASCII SemVer survives; malicious and Unicode strings do not", () => {
  expect(cleanVersion("0.1.0-beta.12")).toBe("0.1.0-beta.12");
  for (const bad of [
    "1.0.0\n## injected",
    "1.0.0 `x`",
    "1.0.0<script>",
    "１.０.０",
    "1.0.0-‮evil",
    "1.0.0-\u{1F600}",
    `1.0.0-${"a".repeat(41)}`,
    "latest",
    "",
    1,
    null,
    { toString: () => "1.0.0" },
  ]) {
    expect(cleanVersion(bad)).toBeUndefined();
  }
  const cwd = project({ "@redact-secret/adapter": `1.0.0-${SENTINEL}\n` });
  expect(installedVersion("@redact-secret/adapter", cwd)).toEqual({ status: "installed", version: undefined });
  const { stdout } = run(["--json"], cwd);
  expect(stdout).not.toContain(SENTINEL);
  expect(JSON.parse(stdout).installed.find((e) => e.name === "@redact-secret/adapter").relation).toBe(
    "version_unreadable",
  );
});

test("unavailable activation metadata is reported, not guessed; a supplied identity is validated", () => {
  const none = JSON.parse(run(["--json"], project({})).stdout);
  expect(none.activation).toEqual({ status: "not_provided", identity: null });
  const identity = "credentials=full;selectors=off;families=;vocabulary=pii-context/v2";
  const given = JSON.parse(run(["--json", "--activation", identity], project({})).stdout);
  expect(given.activation).toEqual({ status: "user_supplied", identity });
  const refused = run(["--activation", `selectors=${SENTINEL} with spaces`], project({}));
  expect(refused.code).toBe(2);
  expect(refused.stdout).toBe("");
  expect(refused.stderr).not.toContain(SENTINEL);
});

test("outcome codes and adapter ids are validated against fixed lists", () => {
  const parsed = parseArgs([
    "--adapter",
    "adapter-ai-context",
    "--outcome",
    "blocked",
    "--outcome",
    "INITIALIZATION_FAILED",
  ]);
  expect(parsed).toMatchObject({ adapter: "adapter-ai-context", outcomes: ["blocked", "INITIALIZATION_FAILED"] });
  for (const argv of [
    ["--outcome", SENTINEL],
    ["--outcome", "ok\n## injected"],
    ["--adapter", SENTINEL],
    ["--adapter"],
    [SENTINEL],
    ["--__proto__"],
    ["--constructor"],
    Array.from({ length: 17 }, () => ["--outcome", "ok"]).flat(),
  ]) {
    const result = run(argv, project({}));
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toContain(SENTINEL);
  }
});

test("the outcome vocabulary stays in step with the packages", () => {
  for (const code of [...BLOCK_REASONS, ...READINESS_STATUSES, "ok", "blocked", "aborted"]) {
    expect(OUTCOME_CODES).toContain(code);
  }
});

test("a sentinel in the environment, package metadata, paths and a hostile Python probe never reaches the output", () => {
  const saved = { ...process.env };
  process.env.SENTINEL_ENV = SENTINEL;
  process.env.HOSTNAME = SENTINEL;
  process.env.HOME = `/Users/${SENTINEL}`;
  try {
    const cwd = project({ "@redact-secret/adapter": "0.1.7", pino: "10.0.0" });
    const markdown = run(["--adapter", "adapter", "--outcome", "core_error"], cwd).stdout;
    const json = run(["--json"], cwd).stdout;
    for (const text of [markdown, json]) {
      expect(text).not.toContain(SENTINEL);
      expect(text).not.toContain(cwd);
      expect(text).not.toContain("/Users/");
    }
    const hostile = pythonFacts(() =>
      JSON.stringify({
        python: `3.12.0\n${SENTINEL}`,
        packages: { "redact-secret": SENTINEL, [SENTINEL]: "1.0.0", "redact-secret-adapters": "0.2.0" },
      }),
    );
    const summary = buildSummary({ python: hostile, installed: {} });
    expect(JSON.stringify(summary)).not.toContain(SENTINEL);
    expect(summary.python).toMatchObject({ status: "collected", version: null });
    expect(summary.python.packages).toEqual([
      { name: "redact-secret-adapters", version: "0.2.0" },
      { name: "redact-secret", version: null },
    ]);
    expect(validate(summary)).toBe(true);
  } finally {
    process.env = saved;
  }
});

test("buildSummary copies by name: prototype pollution and extra fields are dropped", () => {
  const summary = buildSummary({
    node: "22.0.0",
    platform: SENTINEL,
    arch: { toString: () => "x64" },
    adapter: SENTINEL,
    outcomes: ["ok", SENTINEL, "../x", 5],
    extra: SENTINEL,
    installed: {
      __proto__: { "@redact-secret/adapter": { status: "installed", version: "1.0.0" } },
      [SENTINEL]: { version: "1.0.0" },
    },
  });
  expect(JSON.stringify(summary)).not.toContain(SENTINEL);
  expect(summary).toMatchObject({ adapter: null, outcomes: ["ok"], runtime: { platform: "other", arch: "other" } });
  expect(validate(summary)).toBe(true);
});

test("an unavailable Python is reported as such and no interpreter output is trusted", () => {
  expect(
    pythonFacts(() => {
      throw new Error(SENTINEL);
    }),
  ).toEqual({ status: "unavailable", python: null, packages: [] });
  expect(pythonFacts(() => "not json").status).toBe("unavailable");
});

test("the Markdown report has one routing line per kind and the repositories are the documented ones", () => {
  const text = renderMarkdown(buildSummary({ installed: {} }));
  for (const [kind, route] of Object.entries(ROUTES))
    expect(text).toContain(`- ${kind}:`) && expect(text).toContain(route.repository);
  expect(ROUTES.detection.repository).toBe("https://github.com/redact-secret/redact-secret/issues");
  expect(ROUTES.integration.repository).toBe("https://github.com/redact-secret/redact-secret-adapters/issues");
  expect(ROUTES.vulnerability.repository).toMatch(/security\/advisories\/new$/);
  expect(NPM_PACKAGES).toContain("@redact-secret/adapter-otel-logs");
});

test("--help prints usage and exits 0", () => {
  const { code, stdout } = run(["--help"], project({}));
  expect(code).toBe(0);
  expect(stdout).toMatch(/^Usage:/);
});
