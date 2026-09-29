#!/usr/bin/env node
/**
 * Generates the adapter release feed (#61) that redact-secret-www reads
 * instead of asking npm and PyPI what this repository ships:
 *
 *   node scripts/generate-site-feed.mjs           # rewrite site-feed/v1/adapters.json
 *   node scripts/generate-site-feed.mjs --check   # fail if it is stale or schema-invalid (CI)
 *
 * The feed is built from machine-readable manifests only, never from
 * Markdown: the release plan's package list (`PACKAGES` in
 * scripts/release-plan.mjs), each package's own manifest
 * (`package.json` / `python/pyproject.toml`), and `compatibility.json`,
 * whose agreement with those manifests and with CI `npm run compat:check`
 * already enforces. It carries only what those files publicly declare.
 *
 * The output is a pure function of the inputs. There is no wall clock in it:
 * `generatedAt` is the date `compatibility.json` was last resolved
 * (`endpointsResolvedAt`), so regenerating an unchanged tree reproduces the
 * committed bytes exactly, which is what `--check` compares. The revision
 * and digest belong to the consumer: it fetches the file at a full commit
 * SHA and hashes the bytes it received. See RELEASING.md § The site release
 * feed for the contract.
 *
 * Importing this module runs nothing; the pure helpers are exported for
 * scripts/test/site-feed.test.mjs.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { Ajv2020 } from "ajv/dist/2020.js";

import { distTagFor, PACKAGES, pyprojectVersion } from "./release-plan.mjs";

export const SCHEMA_VERSION = "redact-secret-adapters.release-feed/v1";
export const FEED_PATH = "site-feed/v1/adapters.json";
export const SCHEMA_PATH = "site-feed/v1/adapters.schema.json";
export const REPOSITORY = "https://github.com/redact-secret/redact-secret-adapters";

// The core under both of its names. Every package requires exactly one.
const CORE_NAMES = new Set(["@redact-secret/core", "redact-secret"]);

const PEP440 = /^(?:0|[1-9]\d*)(?:\.(?:0|[1-9]\d*))*(?:(a|b|rc)(?:0|[1-9]\d*))?(?:\.post\d+)?(\.dev\d+)?$/;
const PEP440_CHANNELS = { a: "alpha", b: "beta", rc: "rc" };

/**
 * The channel a PyPI version is on, in the same words as an npm dist-tag:
 * `latest` for a final release, `alpha` / `beta` / `rc` for a pre-release,
 * `dev` for a development release. Throws rather than guess on anything
 * that is not a normalized PEP 440 version.
 */
export function pypiChannel(version) {
  const match = PEP440.exec(version);
  if (match === null) throw new Error(`${version} is not a normalized PEP 440 version`);
  if (match[2] !== undefined) return "dev";
  return match[1] === undefined ? "latest" : PEP440_CHANNELS[match[1]];
}

/** The input files, as repository-relative paths, in the order they are listed in the feed. */
export function sourcePaths() {
  return ["scripts/release-plan.mjs", "compatibility.json", ...PACKAGES.map((pkg) => pkg.manifest)];
}

/** `peerDependency (optional)` / `extra:otel` / `dependency` as the feed's structured fields. */
function requirementKind(kind) {
  if (kind === "peerDependency") return { kind: "peerDependency", optional: false };
  if (kind === "peerDependency (optional)") return { kind: "peerDependency", optional: true };
  if (kind === "dependency") return { kind: "dependency", optional: false };
  const extra = /^extra:([a-z0-9][a-z0-9-]*)$/.exec(kind);
  if (extra !== null) return { kind: "dependency", optional: true, extra: extra[1] };
  throw new Error(`unknown requirement kind "${kind}" in compatibility.json`);
}

function tested(requirement, owner) {
  const { lowest, highest } = requirement.endpoints ?? {};
  if (typeof lowest !== "string" || typeof highest !== "string") {
    throw new Error(`${owner}: ${requirement.name} has no recorded endpoints in compatibility.json`);
  }
  return { lowest, highest };
}

function byName(a, b) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Builds the feed object.
 *
 * @param {{ compatibility: object, manifests: Record<string, string> }} inputs
 *   `compatibility.json` parsed, and each package manifest's text keyed by
 *   its repository-relative path.
 */
export function buildFeed({ compatibility, manifests }) {
  if (compatibility.schema !== "redact-secret-adapters/compatibility-v1") {
    throw new Error(`compatibility.json: unsupported schema ${compatibility.schema}`);
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(compatibility.endpointsResolvedAt ?? "")) {
    throw new Error(`compatibility.json: endpointsResolvedAt ${compatibility.endpointsResolvedAt} is not YYYY-MM-DD`);
  }
  const records = new Map(compatibility.packages.map((entry) => [entry.name, entry]));
  const releasedNames = new Set(PACKAGES.map((pkg) => pkg.name));

  const packages = PACKAGES.map((pkg) => {
    const text = manifests[pkg.manifest];
    if (text === undefined) throw new Error(`${pkg.manifest}: not read`);
    const record = records.get(pkg.name);
    if (record === undefined) throw new Error(`${pkg.name}: not recorded in compatibility.json`);
    if (record.registry !== pkg.registry || record.manifest !== pkg.manifest) {
      throw new Error(
        `${pkg.name}: compatibility.json and scripts/release-plan.mjs disagree on its registry or manifest`,
      );
    }

    let version;
    let dependsOn = [];
    if (pkg.registry === "npm") {
      const manifest = JSON.parse(text);
      if (manifest.name !== pkg.name) throw new Error(`${pkg.manifest}: name ${manifest.name} is not ${pkg.name}`);
      if (manifest.private === true) {
        throw new Error(`${pkg.manifest}: a private package is not releasable and must not be in PACKAGES`);
      }
      version = manifest.version;
      dependsOn = Object.entries(manifest.dependencies ?? {})
        .filter(([name]) => releasedNames.has(name))
        .map(([name, range]) => ({ name, range }))
        .sort(byName);
    } else {
      version = pyprojectVersion(text);
      if (!version) throw new Error(`${pkg.manifest}: no static \`version = "..."\` in its [project] table`);
    }
    const channel = pkg.registry === "npm" ? distTagFor(version) : pypiChannel(version);

    const cores = record.requires.filter((r) => CORE_NAMES.has(r.name));
    if (cores.length !== 1)
      throw new Error(`${pkg.name}: expected exactly one core requirement, found ${cores.length}`);
    const [core] = cores;

    const hosts = record.requires
      .filter((r) => !CORE_NAMES.has(r.name))
      .map((r) => ({ name: r.name, range: r.range, ...requirementKind(r.kind), tested: tested(r, pkg.name) }))
      .sort(byName);

    return {
      id: pkg.tag,
      ecosystem: pkg.registry,
      name: pkg.name,
      version,
      channel,
      prerelease: channel !== "latest",
      gitTag: `${pkg.tag}@${version}`,
      sourcePath: pkg.manifest.slice(0, pkg.manifest.lastIndexOf("/")),
      registryUrl:
        pkg.registry === "npm" ? `https://www.npmjs.com/package/${pkg.name}` : `https://pypi.org/project/${pkg.name}/`,
      runtime: {
        name: record.runtime.name,
        range: record.runtime.range,
        tested: [...record.runtime.ciExercised],
      },
      core: { name: core.name, range: core.range, ...requirementKind(core.kind), tested: tested(core, pkg.name) },
      hosts,
      dependsOn,
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: `${compatibility.endpointsResolvedAt}T00:00:00Z`,
    repository: REPOSITORY,
    sources: sourcePaths(),
    packages,
  };
}

/** The exact bytes committed at FEED_PATH. */
export function renderFeed(feed) {
  return `${JSON.stringify(feed, null, 2)}\n`;
}

/** Returns the schema errors for a feed, as `path message` lines; empty when it is valid. */
export function schemaErrors(feed, schema) {
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  if (validate(feed)) return [];
  return validate.errors.map((error) => `${error.instancePath || "/"} ${error.message}`);
}

function main() {
  const root = new URL("../", import.meta.url);
  const read = (path) => readFileSync(new URL(path, root), "utf-8");
  const manifests = Object.fromEntries(PACKAGES.map((pkg) => [pkg.manifest, read(pkg.manifest)]));
  const feed = buildFeed({ compatibility: JSON.parse(read("compatibility.json")), manifests });
  const rendered = renderFeed(feed);

  const problems = schemaErrors(feed, JSON.parse(read(SCHEMA_PATH))).map(
    (e) => `generated feed fails the schema: ${e}`,
  );

  if (process.argv.includes("--check")) {
    let committed;
    try {
      committed = read(FEED_PATH);
    } catch {
      committed = undefined;
    }
    if (committed === undefined) {
      problems.push(`${FEED_PATH} is missing: run \`npm run feed:generate\` and commit it`);
    } else if (committed !== rendered) {
      problems.push(`${FEED_PATH} is stale: run \`npm run feed:generate\` and commit the result`);
    }
    if (problems.length > 0) {
      for (const message of problems) console.error(`site feed: ${message}`);
      process.exit(1);
    }
    console.log(`${FEED_PATH} is current and valid (${feed.packages.length} packages, ${SCHEMA_VERSION})`);
    return;
  }

  if (problems.length > 0) {
    for (const message of problems) console.error(`site feed: ${message}`);
    process.exit(1);
  }
  writeFileSync(new URL(FEED_PATH, root), rendered);
  console.log(`wrote ${FEED_PATH} (${feed.packages.length} packages, ${SCHEMA_VERSION})`);
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
