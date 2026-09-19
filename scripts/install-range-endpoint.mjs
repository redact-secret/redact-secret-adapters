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
import { readdirSync, readFileSync } from "node:fs";

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
for (const dir of readdirSync(packagesDir)) {
  const manifest = JSON.parse(readFileSync(new URL(`${dir}/package.json`, packagesDir), "utf-8"));
  const ranges = { ...manifest.peerDependencies };
  const coreRange = manifest.dependencies?.[CORE] ?? manifest.peerDependencies?.[CORE];
  if (coreRange) ranges[CORE] = coreRange;

  const specs = Object.entries(ranges).map(([name, range]) => `${name}@${resolve(name, range)}`);
  if (specs.length === 0) continue;
  console.log(`${manifest.name}: ${end} -> ${specs.join(" ")}`);
  execFileSync("npm", ["install", "--no-save", "--workspace", manifest.name, ...specs], { stdio: "inherit" });
}
