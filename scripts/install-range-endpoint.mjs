#!/usr/bin/env node
/**
 * Installs one end of every declared compatibility range, so CI can
 * typecheck and test against it:
 *
 *   node scripts/install-range-endpoint.mjs lowest
 *   node scripts/install-range-endpoint.mjs highest
 *
 * The ranges are read from each workspace's `package.json` — every
 * `peerDependencies` entry, plus the `@redact-secret/core` range — and
 * resolved against the registry, so this script never carries a version
 * number of its own. Nothing is saved to a manifest or the lockfile.
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { workspaceDirs } from "./workspace-dirs.mjs";

const CORE = "@redact-secret/core";
const end = process.argv[2];
if (end !== "lowest" && end !== "highest") {
  console.error("usage: install-range-endpoint.mjs <lowest|highest>");
  process.exit(2);
}

function resolve(name, range) {
  const out = execFileSync("npm", ["view", `${name}@${range}`, "version", "--json"], { encoding: "utf-8" });
  const versions = [JSON.parse(out)].flat();
  if (versions.length === 0) throw new Error(`no published version of ${name} satisfies ${range}`);
  return end === "lowest" ? versions[0] : versions[versions.length - 1];
}

const packagesDir = new URL("../packages/", import.meta.url);
const endpoints = new Map();
for (const dir of workspaceDirs(packagesDir)) {
  const manifest = JSON.parse(readFileSync(new URL(`${dir}/package.json`, packagesDir), "utf-8"));
  const ranges = { ...manifest.peerDependencies };
  const coreRange = manifest.dependencies?.[CORE] ?? manifest.peerDependencies?.[CORE];
  if (coreRange) ranges[CORE] = coreRange;

  const specs = [];
  for (const [name, range] of Object.entries(ranges)) {
    const version = resolve(name, range);
    const seen = endpoints.get(name);
    if (seen !== undefined && seen !== version) {
      throw new Error(`${name}: the ${end} endpoint is ${seen} for one workspace and ${version} for ${manifest.name}`);
    }
    endpoints.set(name, version);
    specs.push(`${name}@${version}`);
  }
  if (specs.length > 0) console.log(`${manifest.name}: ${end} -> ${specs.join(" ")}`);
}

// One install at the root, for every endpoint at once. `--no-save` reifies
// from the lockfile, so each further `--no-save` install would put back what
// the one before it installed and only the last would stick. The root is also
// where these packages are hoisted, so every workspace resolves the endpoint
// and the tree never mixes two core versions.
const specs = [...endpoints].map(([name, version]) => `${name}@${version}`);
if (specs.length > 0) {
  console.log(`root: ${end} -> ${specs.join(" ")}`);
  execFileSync("npm", ["install", "--no-save", ...specs], { stdio: "inherit" });
}

// Fail rather than test some other version: read back what is installed.
const rootDir = new URL("../", import.meta.url);
for (const [name, version] of endpoints) {
  const installed = JSON.parse(readFileSync(new URL(`node_modules/${name}/package.json`, rootDir), "utf-8")).version;
  if (installed !== version) {
    throw new Error(`${name}: expected ${version} installed for the ${end} endpoint, found ${installed}`);
  }
}
console.log(`installed the ${end} endpoint of ${endpoints.size} ranges`);
