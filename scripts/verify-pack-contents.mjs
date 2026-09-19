#!/usr/bin/env node
/**
 * Asserts the exact file list `npm pack` would ship for every workspace,
 * against `files: ["dist", "README.md", "LICENSE"]` in each package.json
 * (`package.json` itself is always included by npm and is allowed too).
 * Run after `npm run build`, so `dist` is populated the way a real publish
 * would see it — an empty or stale `dist` would otherwise pass silently.
 *
 * The expected `dist` file list is derived from `src/**\/*.ts`, not just a
 * `.js`/`.d.ts` extension check — a stray compiled `dist/*.test.js` left
 * over from a misconfigured `tsconfig.build.json` has exactly those
 * extensions and would otherwise pass.
 *
 *   node scripts/verify-pack-contents.mjs
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";

const packagesDir = new URL("../packages/", import.meta.url);
const allowedTopLevel = new Set(["README.md", "LICENSE", "package.json"]);

function listFilesRecursive(dirUrl, prefix = "") {
  let out = [];
  for (const entry of readdirSync(dirUrl, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out = out.concat(listFilesRecursive(new URL(`${entry.name}/`, dirUrl), `${prefix}${entry.name}/`));
    } else {
      out.push(`${prefix}${entry.name}`);
    }
  }
  return out;
}

let failed = false;

for (const dir of readdirSync(packagesDir)) {
  const pkgDir = new URL(`${dir}/`, packagesDir);
  const manifest = JSON.parse(readFileSync(new URL("package.json", pkgDir), "utf-8"));
  const name = manifest.name;

  const srcFiles = listFilesRecursive(new URL("src/", pkgDir)).filter((f) => f.endsWith(".ts"));
  const expectedDist = new Set();
  for (const f of srcFiles) {
    const base = f.slice(0, -".ts".length);
    expectedDist.add(`dist/${base}.js`);
    expectedDist.add(`dist/${base}.d.ts`);
  }

  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--workspace", name], { encoding: "utf-8" });
  const [{ files }] = JSON.parse(out);
  const paths = files.map((f) => f.path).sort();

  const problems = [];
  for (const p of paths) {
    if (allowedTopLevel.has(p)) continue;
    if (expectedDist.has(p)) continue;
    problems.push(`unexpected file in tarball: ${p}`);
  }
  for (const expected of expectedDist) {
    if (!paths.includes(expected)) problems.push(`missing ${expected}`);
  }
  for (const required of ["README.md", "LICENSE", "package.json"]) {
    if (!paths.includes(required)) problems.push(`missing ${required}`);
  }

  if (problems.length > 0) {
    failed = true;
    console.error(`${name}: tarball contents do not match what's intended`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error(`  actual files: ${paths.join(", ")}`);
  } else {
    console.log(`${name}: ok (${paths.length} files)`);
  }
}

if (failed) process.exit(1);
