#!/usr/bin/env node
/**
 * Prints the GitHub Release notes for a release train: one section per
 * package tag (`<pkg>@x.y.z`) that points at HEAD, with that version's
 * CHANGELOG.md section. Derived from tags rather than from a single run's
 * results, so re-running a partially failed train regenerates notes that
 * cover everything the train has shipped so far.
 *
 *   node scripts/release-notes.mjs <train>
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const CHANGELOGS = {
  adapter: {
    name: "@redact-secret/adapter",
    changelog: "packages/adapter/CHANGELOG.md",
    url: "https://www.npmjs.com/package/@redact-secret/adapter/v/",
  },
  "adapter-pino": {
    name: "@redact-secret/adapter-pino",
    changelog: "packages/adapter-pino/CHANGELOG.md",
    url: "https://www.npmjs.com/package/@redact-secret/adapter-pino/v/",
  },
  "adapter-otel": {
    name: "@redact-secret/adapter-otel",
    changelog: "packages/adapter-otel/CHANGELOG.md",
    url: "https://www.npmjs.com/package/@redact-secret/adapter-otel/v/",
  },
  "adapter-ai-context": {
    name: "@redact-secret/adapter-ai-context",
    changelog: "packages/adapter-ai-context/CHANGELOG.md",
    url: "https://www.npmjs.com/package/@redact-secret/adapter-ai-context/v/",
  },
  "adapter-mcp": {
    name: "@redact-secret/adapter-mcp",
    changelog: "packages/adapter-mcp/CHANGELOG.md",
    url: "https://www.npmjs.com/package/@redact-secret/adapter-mcp/v/",
  },
  "redact-secret-adapters": {
    name: "redact-secret-adapters (PyPI)",
    changelog: "python/CHANGELOG.md",
    url: "https://pypi.org/project/redact-secret-adapters/",
  },
};

const train = process.argv[2];
if (!train) {
  console.error("usage: node scripts/release-notes.mjs <train>");
  process.exit(2);
}

const root = new URL("../", import.meta.url);

function changelogSection(path, version) {
  const lines = readFileSync(new URL(path, root), "utf-8").split("\n");
  const start = lines.findIndex((l) => l.startsWith(`## [${version}]`));
  if (start === -1) return "_No CHANGELOG entry found._";
  let end = lines.findIndex((l, i) => i > start && l.startsWith("## ["));
  if (end === -1) end = lines.length;
  return lines
    .slice(start + 1, end)
    .join("\n")
    .trim()
    .replace(/^### /gm, "#### ");
}

const tags = execFileSync("git", ["tag", "--points-at", "HEAD"], { encoding: "utf-8" })
  .split("\n")
  .filter((t) => t.includes("@"))
  .sort();

const out = [`Release train \`${train}\`. Every package is versioned independently; this train shipped:`, ""];
for (const tag of tags) {
  const at = tag.lastIndexOf("@");
  const pkg = CHANGELOGS[tag.slice(0, at)];
  if (!pkg) continue;
  out.push(`- [${pkg.name} ${tag.slice(at + 1)}](${pkg.url}${tag.slice(at + 1)})`);
}
for (const tag of tags) {
  const at = tag.lastIndexOf("@");
  const pkg = CHANGELOGS[tag.slice(0, at)];
  if (!pkg) continue;
  out.push("", `### ${pkg.name} ${tag.slice(at + 1)}`, "", changelogSection(pkg.changelog, tag.slice(at + 1)));
}
console.log(out.join("\n"));
