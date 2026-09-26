#!/usr/bin/env node
/**
 * Installs each package the way a registry consumer can get it: this
 * checkout's tarball, with every `@redact-secret/adapter*` dependency at the
 * LOWEST registry version its declared range allows, then runs the package's
 * contract probe (redact-secret-adapters#36).
 *
 * `npm test` and `smoke-test` pair every package with the workspace build of
 * its siblings, so they cannot see a range that still admits a published
 * sibling without the API the package now needs. That is how
 * `adapter-ai-context` shipped `^0.1.1` against an `adapter` whose `0.1.1`
 * walker passes no key: the key-aware `sanitizeValue` silently fell back to
 * blocking. A range floor below the version that carries a needed API fails
 * here.
 *
 * A range no published version satisfies yet is a sibling that ships in the
 * same train: the check installs this checkout's tarball for it instead, and
 * says so. Once that version is published, the next run exercises it.
 *
 *   npm run build && node scripts/check-published-combination.mjs
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const PACKAGE_DIRS = ["adapter", "adapter-pino", "adapter-otel", "adapter-ai-context", "adapter-mcp"];
const manifests = Object.fromEntries(
  PACKAGE_DIRS.map((dir) => [dir, JSON.parse(readFileSync(join(repoRoot, "packages", dir, "package.json"), "utf-8"))]),
);
const dirByName = Object.fromEntries(PACKAGE_DIRS.map((dir) => [manifests[dir].name, dir]));

function npm(args, cwd, capture = false) {
  if (!capture) console.log(`+ npm ${args.join(" ")}`);
  return execFileSync("npm", args, { cwd, encoding: "utf-8", stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit" });
}

/** Numeric-then-lexical SemVer precedence, enough for the versions npm reports. */
function compareVersions(a, b) {
  const split = (v) => {
    const [core, pre] = v.split(/-(.*)/s);
    return { core: core.split(".").map(Number), pre: pre === undefined ? [] : pre.split(".") };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] - y.core[i];
  if (x.pre.length === 0 || y.pre.length === 0) return y.pre.length - x.pre.length;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    if (x.pre[i] === undefined) return -1;
    if (y.pre[i] === undefined) return 1;
    const [p, q] = [x.pre[i], y.pre[i]];
    const [pn, qn] = [/^\d+$/.test(p), /^\d+$/.test(q)];
    if (pn && qn && Number(p) !== Number(q)) return Number(p) - Number(q);
    if (pn !== qn) return pn ? -1 : 1;
    if (p !== q) return p < q ? -1 : 1;
  }
  return 0;
}

/** The lowest published version of `name` inside `range`, or null when none is published yet. */
function lowestPublished(name, range) {
  let out;
  try {
    out = npm(["view", `${name}@${range}`, "version", "--json"], repoRoot, true).trim();
  } catch (error) {
    if (/E404|No match found/.test(String(error.stderr ?? ""))) return null;
    throw error;
  }
  if (out === "") return null;
  const versions = [JSON.parse(out)].flat();
  return versions.sort(compareVersions)[0] ?? null;
}

/** Every `@redact-secret/adapter*` dependency of `dir`, transitively, at the lowest version the dependent's range allows. */
function plan(dir, resolved = new Map()) {
  for (const [name, range] of Object.entries(manifests[dir].dependencies ?? {})) {
    const sibling = dirByName[name];
    if (sibling === undefined || resolved.has(name)) continue;
    const version = lowestPublished(name, range);
    resolved.set(
      name,
      version === null ? { range, source: "tarball", dir: sibling } : { range, source: "registry", version },
    );
    // A registry version brings its own published dependency ranges; only a tarball's are this checkout's.
    if (version === null) plan(sibling, resolved);
  }
  return resolved;
}

const LIMITS = `{
  wholeInputLimits: { maxInputBytes: 65536, maxFindings: 256 },
  incrementalLimits: { maxInputCodeUnits: 1048576, maxBufferedCodeUnits: 65536, maxTokenCodeUnits: 8192, maxMultilineCodeUnits: 32768 },
  traversalLimits: { maxDepth: 16, maxNodes: 4096 },
}`;

// Synthetic values only. A leaf identified only by its object key is redacted
// in place, not blocked (redact-secret/redact-secret#842).
const PROBES = {
  "adapter-ai-context": `import assert from "node:assert/strict";
import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";
const boundary = await createAiContextBoundary(${LIMITS});
const r = boundary.sanitizeValue({ note: "ordinary text", password: "synthetic-not-a-secret" }, { boundary: "tool-result" });
assert.equal(r.outcome, "ok", \`key-aware sanitizeValue returned \${r.outcome} \${r.reason ?? ""}\`);
assert.ok(r.value.note === "ordinary text", "an ordinary leaf changed");
assert.ok(/^<SECRET_\\d+>$/.test(r.value.password), "the key-identified leaf was not redacted in place");
console.log("@redact-secret/adapter-ai-context: key-aware sanitizeValue ok");
`,
  "adapter-mcp": `import assert from "node:assert/strict";
import { createMcpBoundary } from "@redact-secret/adapter-mcp";
const mcp = await createMcpBoundary(${LIMITS});
const r = mcp.sanitizeResourceResult({
  contents: [{ uri: "file:///synthetic/readme.txt", mimeType: "text/plain", text: "ordinary text" }],
  _meta: { password: "synthetic-not-a-secret" },
});
assert.equal(r.outcome, "ok", \`sanitizeResourceResult returned \${r.outcome} \${r.reason ?? ""}\`);
assert.ok(/^<SECRET_\\d+>$/.test(r.value._meta.password), "the key-identified _meta leaf was not redacted in place");
console.log("@redact-secret/adapter-mcp: key-aware resources/read ok");
`,
};

function check(dir, packsDir, root) {
  const resolved = plan(dir);
  console.log(`\n== ${manifests[dir].name}@${manifests[dir].version}`);
  for (const [name, entry] of resolved) {
    console.log(
      entry.source === "registry"
        ? `   ${name} ${entry.range} -> lowest published ${entry.version}`
        : `   ${name} ${entry.range} -> nothing published yet; this checkout's ${manifests[entry.dir].version} (same train)`,
    );
  }
  const tarball = (d) => {
    const [{ filename }] = JSON.parse(
      npm(["pack", "--json", "--workspace", manifests[d].name, "--pack-destination", packsDir], repoRoot, true),
    );
    return join(packsDir, filename);
  };
  const projectDir = join(root, dir);
  mkdirSync(projectDir);
  const overrides = {};
  const dependencies = { [manifests[dir].name]: `file:${tarball(dir)}` };
  for (const [name, entry] of resolved) {
    overrides[name] = entry.source === "registry" ? entry.version : `file:${tarball(entry.dir)}`;
    if (entry.source === "tarball") dependencies[name] = overrides[name];
  }
  dependencies["@redact-secret/core"] = manifests[dir].peerDependencies["@redact-secret/core"];
  writeFileSync(
    join(projectDir, "package.json"),
    JSON.stringify(
      { name: `published-combination-${dir}`, private: true, type: "module", dependencies, overrides },
      null,
      2,
    ),
  );
  npm(["install", "--no-audit", "--no-fund", "--omit=optional"], projectDir);
  for (const [name, entry] of resolved) {
    const installed = JSON.parse(readFileSync(join(projectDir, "node_modules", name, "package.json"), "utf-8")).version;
    const expected = entry.source === "registry" ? entry.version : manifests[entry.dir].version;
    if (installed !== expected) throw new Error(`${name}: installed ${installed}, planned ${expected}`);
  }
  writeFileSync(join(projectDir, "probe.mjs"), PROBES[dir]);
  execFileSync(process.execPath, ["probe.mjs"], { cwd: projectDir, stdio: "inherit" });
}

const root = mkdtempSync(join(realpathSync(tmpdir()), "redact-secret-published-combination-"));
const packsDir = join(root, "packs");
mkdirSync(packsDir);
let ok = false;
try {
  for (const dir of Object.keys(PROBES)) check(dir, packsDir, root);
  console.log(
    "\npublished combination ok: every probed package works with the lowest sibling versions its ranges admit.",
  );
  ok = true;
} finally {
  if (ok) rmSync(root, { recursive: true, force: true });
  else console.error(`\npublished-combination check failed; projects left at ${root}`);
}
