#!/usr/bin/env node
/**
 * Computes the release plan: for every package, the version its manifest
 * declares and whether that version is already on its registry. A package
 * is in the plan exactly when its declared version is not yet published —
 * nothing is computed or bumped here, so a train publishes only the
 * packages whose manifests were bumped on `develop`, and a re-run after a
 * partial failure publishes only what is still missing.
 *
 *   node scripts/release-plan.mjs [--check-changelog] [--require-publish]
 *                                 [--require-published] [--check-tags]
 *
 *   --check-changelog    every planned package's CHANGELOG.md has a
 *                        `## [x.y.z]` heading for its declared version
 *   --require-publish    fail if nothing is planned (cut, and the rc PR's
 *                        rehearsal; not inside the Release workflow, whose
 *                        re-runs may have nothing left to publish)
 *   --require-published  fail if anything is still unpublished (reconcile)
 *   --check-tags         every package's `<tag>@<version>` exists locally
 *                        (fetch tags first)
 *
 * Under GitHub Actions it also writes `publish_<id>`, `<id>_version`,
 * `any_publish` and `plan` (JSON) to $GITHUB_OUTPUT, and the plan table to
 * $GITHUB_STEP_SUMMARY.
 */

import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

// `id` is the output-key stem the workflows read (`publish_adapter_pino`,
// `adapter_pino_version`); `tag` is the prefix of the per-package git tag.
const PACKAGES = [
  {
    id: "adapter",
    name: "@redact-secret/adapter",
    registry: "npm",
    manifest: "packages/adapter/package.json",
    changelog: "packages/adapter/CHANGELOG.md",
    tag: "adapter",
  },
  {
    id: "adapter_pino",
    name: "@redact-secret/adapter-pino",
    registry: "npm",
    manifest: "packages/adapter-pino/package.json",
    changelog: "packages/adapter-pino/CHANGELOG.md",
    tag: "adapter-pino",
  },
  {
    id: "adapter_otel",
    name: "@redact-secret/adapter-otel",
    registry: "npm",
    manifest: "packages/adapter-otel/package.json",
    changelog: "packages/adapter-otel/CHANGELOG.md",
    tag: "adapter-otel",
  },
  {
    id: "python",
    name: "redact-secret-adapters",
    registry: "pypi",
    manifest: "python/pyproject.toml",
    changelog: "python/CHANGELOG.md",
    tag: "redact-secret-adapters",
  },
];

const root = new URL("../", import.meta.url);
const args = new Set(process.argv.slice(2));

// `version` in pyproject.toml's `[project]` table, read line by line: a
// table header is any line that starts with `[` in column 0 (array
// continuation lines are indented), so key order, blank lines, comments,
// multi-line arrays and either TOML string quote don't matter. A dynamic
// version or a version outside `[project]` is an error, not a guess.
function pyprojectVersion(text) {
  let table = null;
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      const header = line.match(/^\[\[?([^\]]*)\]\]?\s*(?:#.*)?$/);
      table = header ? header[1].replace(/["'\s]/g, "") : null;
      if (line.startsWith("[[")) table = null;
      continue;
    }
    if (table !== "project") continue;
    const match = line.match(/^\s*version\s*=\s*(?:"([^"\\]*)"|'([^']*)')\s*(?:#.*)?$/);
    if (match) return match[1] ?? match[2];
  }
  return null;
}

function declaredVersion(pkg) {
  const text = readFileSync(new URL(pkg.manifest, root), "utf-8");
  if (pkg.registry === "npm") return JSON.parse(text).version;
  const version = pyprojectVersion(text);
  if (!version) throw new Error(`${pkg.manifest}: no static \`version = "..."\` in its [project] table`);
  return version;
}

// 200 means published, 404 means not; anything else is an error rather than
// a guess — reading a registry outage as "not published" would plan a
// publish that then fails halfway through a train.
async function isPublished(pkg, version) {
  const url =
    pkg.registry === "npm"
      ? `https://registry.npmjs.org/${pkg.name}/${version}`
      : `https://pypi.org/pypi/${pkg.name}/${version}/json`;
  const res = await fetch(url, { method: "GET", headers: { accept: "application/json" } });
  if (res.status === 200) return true;
  if (res.status === 404) return false;
  throw new Error(`${url}: unexpected HTTP ${res.status}`);
}

function hasChangelogEntry(pkg, version) {
  const text = readFileSync(new URL(pkg.changelog, root), "utf-8");
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^## \\[${escaped}\\]`, "m").test(text);
}

function tagExists(tag) {
  return execFileSync("git", ["tag", "--list", tag], { encoding: "utf-8" }).trim() === tag;
}

const plan = [];
for (const pkg of PACKAGES) {
  const version = declaredVersion(pkg);
  const published = await isPublished(pkg, version);
  plan.push({ ...pkg, version, publish: !published, gitTag: `${pkg.tag}@${version}` });
}

const problems = [];
for (const p of plan) {
  if (args.has("--check-changelog") && p.publish && !hasChangelogEntry(p, p.version)) {
    problems.push(`${p.changelog} has no "## [${p.version}]" heading for the version ${p.manifest} declares`);
  }
  if (args.has("--require-published") && p.publish) {
    problems.push(`${p.name}@${p.version} is declared but not on ${p.registry}`);
  }
  if (args.has("--check-tags") && !tagExists(p.gitTag)) {
    problems.push(`tag ${p.gitTag} is missing`);
  }
}
const anyPublish = plan.some((p) => p.publish);
if (args.has("--require-publish") && !anyPublish) {
  problems.push(
    "every declared version is already published: bump a package version on develop before cutting a train",
  );
}

const table = [
  "| Package | Registry | Declared version | Plan |",
  "|---|---|---|---|",
  ...plan.map(
    (p) => `| ${p.name} | ${p.registry} | ${p.version} | ${p.publish ? "**publish**" : "already published, skip"} |`,
  ),
].join("\n");
console.log(table);

if (process.env.GITHUB_OUTPUT) {
  const lines = plan.flatMap((p) => [`publish_${p.id}=${p.publish}`, `${p.id}_version=${p.version}`]);
  lines.push(`any_publish=${anyPublish}`);
  lines.push(
    `plan=${JSON.stringify(plan.map(({ name, registry, version, publish, gitTag }) => ({ name, registry, version, publish, gitTag })))}`,
  );
  appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
}
if (process.env.GITHUB_STEP_SUMMARY) {
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Release plan\n\n${table}\n\n`);
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`::error::${problem}`);
  process.exit(1);
}
