#!/usr/bin/env node
/**
 * No testbed or control-route code in anything a consumer installs (#192).
 *
 * For every npm workspace: lists the files `npm pack --dry-run` would ship and fails when
 * a path or the manifest mentions testbed/control/fixture material, or a packed text file
 * contains a testbed control marker. Also fails when testbed/ is a workspace or when
 * the Python distribution config or source tree reaches testbed/ or a control route.
 * Run after `npm run build` so dist/ is populated. The installed artifacts are checked
 * again inside the consumer images (smoke.*-install-isolation).
 *
 *   node testbed/scripts/check-pack-isolation.mjs
 */

import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const PATH_RE = /(^|\/)(testbed|fixtures?)(\/|$)|__control/i;
const CONTENT_RE = /__control|\/testbed\b|testbed\//;
const problems = [];

const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
for (const w of root.workspaces ?? []) {
  if (/testbed/.test(w)) problems.push(`root workspaces include '${w}'`);
}

for (const dir of readdirSync(join(repoRoot, "packages"))) {
  const pkgDir = join(repoRoot, "packages", dir);
  if (!statSync(pkgDir).isDirectory()) continue;
  const manifest = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
  const [{ files }] = JSON.parse(
    execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: pkgDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }),
  );
  if (files.length === 0) problems.push(`${manifest.name}: npm pack lists no files (is dist built?)`);
  for (const { path } of files) {
    if (PATH_RE.test(path)) problems.push(`${manifest.name}: packed path ${path}`);
    if (/\.(js|mjs|cjs|ts|json|md)$/.test(path) && path !== "CHANGELOG.md" && path !== "README.md") {
      if (CONTENT_RE.test(readFileSync(join(pkgDir, path), "utf-8")))
        problems.push(`${manifest.name}: ${path} mentions a testbed/control marker`);
    }
  }
  const declared = JSON.stringify({
    files: manifest.files,
    exports: manifest.exports,
    bin: manifest.bin,
    main: manifest.main,
  });
  if (/testbed|__control/.test(declared))
    problems.push(`${manifest.name}: package.json files/exports reach testbed or a control route`);
}

const py = join(repoRoot, "python");
const pyproject = readFileSync(join(py, "pyproject.toml"), "utf-8");
if (/testbed|__control/.test(pyproject)) problems.push("python/pyproject.toml mentions testbed or a control route");
function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? (e.name === "__pycache__" ? [] : walk(join(dir, e.name))) : [join(dir, e.name)],
  );
}
for (const file of walk(join(py, "redact_secret_adapters"))) {
  if (/__control|testbed/.test(readFileSync(file, "utf-8")))
    problems.push(`python: ${relative(repoRoot, file)} mentions testbed or a control route`);
}

if (problems.length > 0) {
  console.error(`testbed isolation check FAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(
  "testbed isolation check ok: no packed npm file, manifest, workspace or Python source reaches testbed/control code",
);
