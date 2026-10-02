/**
 * Build-time installer for the Node consumer image (#193). Runs in an empty
 * directory inside the image with the staged artifacts bind-mounted at
 * /artifacts. It performs a clean `npm install`, then refuses to continue
 * unless what npm resolved is exactly what the selected mode promises:
 *
 *   candidate  every adapter is the packed tarball from this checkout: the
 *              lockfile entry resolves to file:, and its integrity matches the
 *              tarball's sha512. No registry copy of an adapter may be present.
 *   published  every pinned adapter resolves to the registry at exactly the
 *              requested version.
 *
 * In both modes the core and the hosts are installed at the exact pinned
 * versions (a prerelease core is never left to registry default resolution),
 * and `npm ls` must report no missing or invalid peer. The result is written
 * to install-manifest.json, which the running service reports.
 *
 * TESTBED_FAULT (self-test only, set by `run.mjs --fault`) deliberately breaks
 * one of those guarantees so the failure path is proven:
 *   missing-peer   omit the core, so the peer check must fail the build
 *   wrong-mode     install adapters from the registry although candidate was selected
 *   broken-exports delete an adapter's entry file after the checks, so the import scenario must fail
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const ARTIFACTS = process.env.TESTBED_ARTIFACTS ?? "/artifacts";
const CONSUMER = process.env.TESTBED_CONSUMER ?? "/opt/consumer";
const fault = process.env.TESTBED_FAULT ?? "";
const manifest = JSON.parse(readFileSync(join(ARTIFACTS, "manifest.json"), "utf-8"));
const plan = manifest.npm;
const die = (message) => {
  console.error(`INSTALL VERIFICATION FAILED: ${message}`);
  process.exit(1);
};
const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const sha512 = (file) => `sha512-${createHash("sha512").update(readFileSync(file)).digest("base64")}`;

if (!["candidate", "published"].includes(manifest.mode)) die(`unknown mode '${manifest.mode}'`);

writeFileSync(
  join(CONSUMER, "package.json"),
  JSON.stringify({ name: "testbed-node-consumer", private: true, type: "module" }),
);
const specs = [];
const tarballs = {};
for (const pkg of plan.adapters) {
  const registrySpec = pkg.pin ? `${pkg.name}@${pkg.pin}` : null;
  if (manifest.mode === "candidate" && fault !== "wrong-mode") {
    const file = join(ARTIFACTS, "npm", pkg.file ?? "");
    if (!pkg.file) die(`candidate artifact for ${pkg.name} is missing from the manifest`);
    let actual;
    try {
      actual = sha256(file);
    } catch {
      die(`candidate artifact ${pkg.file} for ${pkg.name} is missing`);
    }
    if (actual !== pkg.sha256) die(`candidate artifact ${pkg.file} does not match its recorded sha256`);
    tarballs[pkg.name] = file;
    specs.push(file);
  } else if (manifest.mode === "candidate") {
    if (pkg.publishedPin) specs.push(`${pkg.name}@${pkg.publishedPin}`); // fault: wrong-mode
  } else if (registrySpec) {
    specs.push(registrySpec);
  }
}
if (fault !== "missing-peer") specs.push(`${plan.core.name}@${plan.core.version}`);
for (const host of plan.hosts) specs.push(`${host.name}@${host.version}`);

console.log(
  `+ npm install (${manifest.mode}) ${specs.map((s) => (s.startsWith("/") ? s.split("/").at(-1) : s)).join(" ")}`,
);
// --legacy-peer-deps: npm must not auto-install a peer; every peer is an explicit pinned spec above.
execFileSync(
  "npm",
  ["install", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", ...specs],
  { cwd: CONSUMER, stdio: "inherit" },
);
try {
  execFileSync("npm", ["ls", "--omit=dev", "--all"], { cwd: CONSUMER, stdio: "inherit" });
} catch {
  die("npm ls reports a missing or invalid dependency (peer dependency not satisfied)");
}

const lock = JSON.parse(readFileSync(join(CONSUMER, "node_modules", ".package-lock.json"), "utf-8")).packages;
const entry = (name) => lock[`node_modules/${name}`];
const version = (name) =>
  JSON.parse(readFileSync(join(CONSUMER, "node_modules", name, "package.json"), "utf-8")).version;

const resolved = [];
for (const pkg of plan.adapters) {
  const e = entry(pkg.name);
  if (!e) {
    if (manifest.mode === "published" && !pkg.pin) continue;
    die(`${pkg.name} is not installed`);
  }
  if (manifest.mode === "candidate") {
    if (typeof e.resolved !== "string" || !e.resolved.startsWith("file:")) {
      die(
        `${pkg.name} resolved to '${String(e.resolved).slice(0, 80)}', not the candidate tarball (wrong installation mode)`,
      );
    }
    if (e.integrity !== sha512(tarballs[pkg.name])) die(`${pkg.name} integrity does not match the candidate tarball`);
    if (e.version !== pkg.version) die(`${pkg.name} installed ${e.version}, packed ${pkg.version}`);
  } else {
    if (!String(e.resolved).startsWith("https://registry.npmjs.org/"))
      die(`${pkg.name} did not resolve to the registry`);
    if (pkg.pin && e.version !== pkg.pin) die(`${pkg.name} resolved to ${e.version}, requested ${pkg.pin}`);
  }
  resolved.push({ name: pkg.name, version: e.version, resolved: e.resolved, integrity: e.integrity });
}
if (manifest.mode === "published") {
  // Adapters pulled in transitively (not pinned in the plan) are still recorded.
  for (const [path, e] of Object.entries(lock)) {
    const m = /^node_modules\/(@redact-secret\/adapter[^/]*)$/.exec(path);
    if (m && !resolved.some((r) => r.name === m[1])) {
      resolved.push({ name: m[1], version: e.version, resolved: e.resolved, integrity: e.integrity, transitive: true });
    }
  }
}
if (manifest.mode === "candidate") {
  // No adapter package may come from the registry (the core and its native packages do).
  for (const [path, e] of Object.entries(lock)) {
    const m = /^node_modules\/(@redact-secret\/adapter[^/]*)$/.exec(path);
    if (m && !String(e.resolved).startsWith("file:")) die(`${m[1]} came from the registry in candidate mode`);
  }
}
if (version(plan.core.name) !== plan.core.version)
  die(`${plan.core.name} is ${version(plan.core.name)}, expected ${plan.core.version}`);
for (const host of plan.hosts) {
  if (version(host.name) !== host.version) die(`${host.name} is ${version(host.name)}, expected ${host.version}`);
}

if (fault === "broken-exports")
  rmSync(join(CONSUMER, "node_modules/@redact-secret/adapter-pino/dist/index.js"), { force: true });

writeFileSync(
  join(CONSUMER, "install-manifest.json"),
  JSON.stringify(
    {
      schema: "redact-secret-adapters/testbed-install-v1",
      host: "node",
      mode: manifest.mode,
      evidence: manifest.mode === "candidate" ? "candidate" : "published",
      node: process.version,
      npm: execFileSync("npm", ["--version"], { encoding: "utf-8" }).trim(),
      adapters: resolved,
      core: { name: plan.core.name, version: version(plan.core.name) },
      coreNative: Object.entries(lock)
        .filter(([path]) => /^node_modules\/@redact-secret\/(?!adapter)(?!core$)[^/]+$/.test(path))
        .map(([path, e]) => ({ name: path.slice("node_modules/".length), version: e.version })),
      hosts: plan.hosts.map((h) => ({ name: h.name, version: version(h.name) })),
      fault: fault || null,
    },
    null,
    2,
  ),
);
console.log("install verified");
