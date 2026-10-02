/**
 * Resolves the install plan from testbed/manifests/*.d/*.json fragments and the
 * #181 example manifests, so the testbed and the examples cannot pin different
 * core or host versions. A value of "@examples" means "the exact version the
 * examples pin"; every example that names the package must agree.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export function readFragments(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")));
}

function examplePins(repoRoot) {
  const npm = {};
  const examples = join(repoRoot, "examples");
  for (const name of readdirSync(examples)) {
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(join(examples, name, "package.json"), "utf-8"));
    } catch {
      continue;
    }
    for (const [dep, version] of Object.entries(manifest.dependencies ?? {})) {
      if (!npm[dep]) npm[dep] = new Map();
      npm[dep].set(name, version);
    }
  }
  const python = {};
  const req = readFileSync(join(examples, "python-logging", "requirements.txt"), "utf-8");
  for (const line of req.split("\n")) {
    const m = /^([A-Za-z0-9_.-]+)==(\S+)/.exec(line.trim());
    if (m) python[m[1]] = m[2];
  }
  return { npm, python };
}

function exampleVersion(pins, dep) {
  const seen = pins.npm[dep];
  if (!seen) throw new Error(`no example pins ${dep}, but a testbed manifest asks for '@examples'`);
  const versions = new Set(seen.values());
  if (versions.size !== 1) {
    throw new Error(`examples disagree on ${dep}: ${[...seen].map(([n, v]) => `${n}=${v}`).join(", ")}`);
  }
  return [...versions][0];
}

/** @returns the npm and python install plans (versions only; artifacts are added by stage.mjs). */
export function resolvePlans(repoRoot, testbedDir) {
  const pins = examplePins(repoRoot);
  const npmFragments = readFragments(join(testbedDir, "manifests", "npm.d"));
  const pyFragments = readFragments(join(testbedDir, "manifests", "python.d"));

  const adapters = [...new Set(npmFragments.flatMap((f) => f.adapters ?? []))];
  const coreSpec = npmFragments.map((f) => f.core).find(Boolean) ?? "@examples";
  const hostMap = Object.assign({}, ...npmFragments.map((f) => f.hosts ?? {}));
  const resolveVersion = (dep, value) => (value === "@examples" ? exampleVersion(pins, dep) : value);

  const npm = {
    adapters: adapters.map((dir) => {
      const manifest = JSON.parse(readFileSync(join(repoRoot, "packages", dir, "package.json"), "utf-8"));
      const published = pins.npm[manifest.name] ? exampleVersion(pins, manifest.name) : null;
      return { dir, name: manifest.name, version: manifest.version, publishedPin: published };
    }),
    core: { name: "@redact-secret/core", version: resolveVersion("@redact-secret/core", coreSpec) },
    hosts: Object.entries(hostMap).map(([name, v]) => ({ name, version: resolveVersion(name, v) })),
  };

  const pyAdapter = pyFragments.map((f) => f.adapter).find(Boolean);
  const resolvePy = (name, v) => {
    if (v !== "@examples") return v;
    if (!pins.python[name]) throw new Error(`examples/python-logging/requirements.txt does not pin ${name}`);
    return pins.python[name];
  };
  const python = {
    name: pyAdapter,
    publishedPin: pins.python[pyAdapter] ?? null,
    core: Object.fromEntries(
      pyFragments.flatMap((f) => Object.entries(f.core ?? {})).map(([n, v]) => [n, resolvePy(n, v)]),
    ),
    hosts: Object.fromEntries(
      pyFragments.flatMap((f) => Object.entries(f.hosts ?? {})).map(([n, v]) => [n, resolvePy(n, v)]),
    ),
  };
  return { npm, python };
}
