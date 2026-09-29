#!/usr/bin/env node
/**
 * Installs the previous release of every adapter package into a prefix, so
 * `scripts/measure-overhead.mjs --baseline <prefix>` can time it against the
 * current build in the same session (#97):
 *
 *   node scripts/install-overhead-baseline.mjs <prefix>
 *   node scripts/install-overhead-baseline.mjs <prefix> @redact-secret/adapter-pino@0.1.1 ...
 *
 * By default each package's baseline is the highest published version below
 * the workspace's own version, so the script never carries a version number
 * of its own. An explicit `name@version` overrides one package. A package
 * with nothing published below it is left out, and the harness reports it
 * as not comparable.
 *
 * Only the adapter packages are installed: install scripts are skipped and
 * peers (the core, pino, OpenTelemetry) are not, because the harness injects
 * its own core and hosts into both builds.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { workspaceDirs } from "./workspace-dirs.mjs";

const [prefix, ...overrides] = process.argv.slice(2);
if (prefix === undefined || prefix.startsWith("-")) {
  console.error("usage: install-overhead-baseline.mjs <prefix> [name@version ...]");
  process.exit(2);
}

/** Semver precedence: -1, 0 or 1. Build metadata is ignored. */
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = v.split("+")[0].split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre: pre === undefined ? [] : pre.split(".") };
  };
  const x = parse(a);
  const y = parse(b);
  for (let i = 0; i < 3; i += 1) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (x.pre.length === 0 || y.pre.length === 0) return x.pre.length === y.pre.length ? 0 : x.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i += 1) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    if (x.pre[i] === y.pre[i]) continue;
    const nx = /^\d+$/.test(x.pre[i]);
    const ny = /^\d+$/.test(y.pre[i]);
    if (nx && ny) return Number(x.pre[i]) < Number(y.pre[i]) ? -1 : 1;
    if (nx !== ny) return nx ? -1 : 1;
    return x.pre[i] < y.pre[i] ? -1 : 1;
  }
  return 0;
}

function published(name) {
  try {
    const out = execFileSync("npm", ["view", name, "versions", "--json"], { encoding: "utf-8" });
    return [JSON.parse(out)].flat();
  } catch {
    return [];
  }
}

const pinned = new Map(
  overrides.map((spec) => {
    const at = spec.lastIndexOf("@");
    if (at <= 0) throw new Error(`expected name@version, got ${spec}`);
    return [spec.slice(0, at), spec.slice(at + 1)];
  }),
);

const packagesDir = new URL("../packages/", import.meta.url);
const specs = [];
for (const dir of workspaceDirs(packagesDir)) {
  const { name, version } = JSON.parse(readFileSync(new URL(`${dir}/package.json`, packagesDir), "utf-8"));
  const chosen =
    pinned.get(name) ??
    published(name)
      .filter((v) => compareVersions(v, version) < 0)
      .sort(compareVersions)
      .at(-1);
  if (chosen === undefined) {
    console.error(`${name}: nothing published below ${version}; left out of the baseline`);
    continue;
  }
  console.error(`${name}: baseline ${chosen} (workspace ${version})`);
  specs.push(`${name}@${chosen}`);
}

const target = resolve(prefix);
mkdirSync(target, { recursive: true });
// A manifest of its own, so npm installs here rather than into an enclosing project.
writeFileSync(`${target}/package.json`, `${JSON.stringify({ name: "overhead-baseline", private: true }, null, 2)}\n`);
if (specs.length > 0) {
  execFileSync(
    "npm",
    [
      "install",
      "--prefix",
      target,
      "--no-save",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--no-audit",
      "--no-fund",
      ...specs,
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );
}
