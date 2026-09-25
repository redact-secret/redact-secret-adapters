#!/usr/bin/env node
/**
 * Fails when `compatibility.json` (#11) disagrees with what the repository
 * actually declares and exercises:
 *
 *   node scripts/check-compatibility-record.mjs            # offline, run in CI
 *   node scripts/check-compatibility-record.mjs --resolve  # also re-resolve endpoints from npm and PyPI
 *
 * Offline it checks that every package is recorded exactly once; that every
 * recorded range equals the manifest's own (`peerDependencies`, `engines`,
 * `requires-python`, `dependencies`, the `otel` extra); that the runtimes CI
 * exercises equal the recorded ones; that CI still installs both range
 * endpoints; and that every `qualifiedBy` test file exists. `--resolve`
 * reports endpoint drift against the registries without failing on it: a new
 * host release moves the highest endpoint, and CI already tests it.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const read = (path) => readFileSync(new URL(path, root), "utf-8");
const record = JSON.parse(read("compatibility.json"));
const ci = read(".github/workflows/ci.yml");
const problems = [];
const problem = (message) => problems.push(message);

function matrix(key) {
  const match = new RegExp(`^\\s+${key}: \\[([^\\]]*)\\]`, "m").exec(ci);
  return match === null ? null : match[1].split(",").map((entry) => entry.trim().replace(/^"|"$/g, ""));
}

/** The few pyproject.toml values this record mirrors, read without a TOML parser. */
function pyproject() {
  const text = read("python/pyproject.toml");
  const string = (key) => new RegExp(`^${key} = "([^"]*)"`, "m").exec(text)?.[1];
  const list = (key) => {
    const match = new RegExp(`^${key} = \\[([^\\]]*)\\]`, "m").exec(text);
    return match === null ? [] : [...match[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]);
  };
  return {
    name: string("name"),
    requiresPython: string("requires-python"),
    dependencies: list("dependencies"),
    otel: list("otel"),
  };
}

const byName = new Map(record.packages.map((entry) => [entry.name, entry]));
if (byName.size !== record.packages.length) problem("a package is recorded more than once");

const npmPackages = readdirSync(new URL("packages/", root)).map((dir) => ({
  dir,
  manifest: JSON.parse(read(`packages/${dir}/package.json`)),
}));
const python = pyproject();
const expectedNames = [...npmPackages.map((p) => p.manifest.name), python.name].sort();
const recordedNames = [...byName.keys()].sort();
if (JSON.stringify(expectedNames) !== JSON.stringify(recordedNames)) {
  problem(`recorded packages ${recordedNames.join(", ")} differ from the repository's ${expectedNames.join(", ")}`);
}

const nodeMatrix = matrix("node");
const pythonMatrix = matrix("python");
const NPM_ENDPOINTS =
  /range-endpoints:[\s\S]*?end: \[lowest, highest\][\s\S]*?npm run range-endpoint -- \$\{\{ matrix\.end \}\}/;
const PYTHON_ENDPOINTS =
  /python-range-endpoints:[\s\S]*?end: \[lowest, highest\][\s\S]*?install-range-endpoint\.py \$\{\{ matrix\.end \}\}/;
if (!NPM_ENDPOINTS.test(ci)) problem("ci.yml no longer installs both npm range endpoints");
if (!PYTHON_ENDPOINTS.test(ci)) problem("ci.yml no longer installs both Python range endpoints");

function checkCommon(entry) {
  for (const file of entry.qualifiedBy ?? []) {
    if (!existsSync(new URL(file, root))) problem(`${entry.name}: qualifiedBy ${file} does not exist`);
  }
  if ((entry.qualifiedBy ?? []).length === 0) problem(`${entry.name}: no qualifying test is named`);
  for (const requirement of entry.requires) {
    if (requirement.endpoints?.lowest === undefined || requirement.endpoints?.highest === undefined) {
      problem(`${entry.name}: ${requirement.name} has no recorded endpoints`);
    }
  }
}

for (const { dir, manifest } of npmPackages) {
  const entry = byName.get(manifest.name);
  if (entry === undefined) continue;
  checkCommon(entry);
  if (entry.manifest !== `packages/${dir}/package.json`) problem(`${entry.name}: manifest path is ${entry.manifest}`);
  if (entry.runtime.range !== manifest.engines?.node)
    problem(`${entry.name}: node range ${entry.runtime.range} != engines ${manifest.engines?.node}`);
  if (JSON.stringify(entry.runtime.ciExercised) !== JSON.stringify(nodeMatrix)) {
    problem(`${entry.name}: ciExercised ${entry.runtime.ciExercised} != ci.yml node matrix ${nodeMatrix}`);
  }
  const declared = manifest.peerDependencies ?? {};
  const recorded = Object.fromEntries(entry.requires.map((r) => [r.name, r.range]));
  if (JSON.stringify(Object.entries(declared).sort()) !== JSON.stringify(Object.entries(recorded).sort())) {
    problem(
      `${entry.name}: recorded requirements ${JSON.stringify(recorded)} != peerDependencies ${JSON.stringify(declared)}`,
    );
  }
}

const pythonEntry = byName.get(python.name);
if (pythonEntry !== undefined) {
  checkCommon(pythonEntry);
  if (pythonEntry.runtime.range !== python.requiresPython)
    problem(`${python.name}: python range != requires-python ${python.requiresPython}`);
  if (JSON.stringify(pythonEntry.runtime.ciExercised) !== JSON.stringify(pythonMatrix)) {
    problem(`${python.name}: ciExercised ${pythonEntry.runtime.ciExercised} != ci.yml python matrix ${pythonMatrix}`);
  }
  const declared = [...python.dependencies.map((d) => ["dependency", d]), ...python.otel.map((d) => ["extra:otel", d])];
  const recorded = pythonEntry.requires.map((r) => [r.kind, `${r.name}${r.range}`]);
  if (JSON.stringify(declared.sort()) !== JSON.stringify(recorded.sort())) {
    problem(
      `${python.name}: recorded requirements ${JSON.stringify(recorded)} != pyproject ${JSON.stringify(declared)}`,
    );
  }
}

for (const entry of record.unqualified) {
  if (!["refused", "documented"].includes(entry.enforcement))
    problem(`unqualified ${entry.host}: enforcement must be refused or documented`);
  if (!entry.how) problem(`unqualified ${entry.host}: no explanation of how it is refused or disclosed`);
}

if (process.argv.includes("--resolve")) {
  const npmEnds = (name, range) => {
    const versions = [
      JSON.parse(execFileSync("npm", ["view", `${name}@${range}`, "version", "--json"], { encoding: "utf-8" })),
    ].flat();
    return { lowest: versions[0], highest: versions.at(-1) };
  };
  for (const entry of record.packages.filter((p) => p.registry === "npm")) {
    for (const requirement of entry.requires) {
      const live = npmEnds(requirement.name, requirement.range);
      if (live.lowest !== requirement.endpoints.lowest || live.highest !== requirement.endpoints.highest) {
        console.log(
          `drift: ${entry.name} ${requirement.name}@${requirement.range} now resolves ${live.lowest}..${live.highest}`,
        );
      }
    }
  }
  console.log(
    "Python endpoints: run `python scripts/install-range-endpoint.py lowest|highest` to see what they resolve to.",
  );
}

if (problems.length > 0) {
  for (const message of problems) console.error(`compatibility.json: ${message}`);
  process.exit(1);
}
console.log(`compatibility.json agrees with ${record.packages.length} manifests and ci.yml`);
