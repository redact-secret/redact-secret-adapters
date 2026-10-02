#!/usr/bin/env node
/**
 * Keeps the standalone examples under `examples/` honest (#181, #183, #184).
 *
 * Static checks (no network, run by `npm run examples:check`):
 *   1. Every documentation snippet that sits under a `<!-- snippet: path#region -->` (or
 *      `<!-- snippet: path -->` for a whole file) marker equals that region of the executable
 *      source, so the docs cannot drift from code that CI runs. `--write` rewrites them.
 *   2. Every example manifest pins exact released versions: no ranges, tags, `file:`, `link:` or
 *      `workspace:` dependencies, so an example installs from the registry and never from this
 *      checkout. Every `requirements.txt` requirement is `==` pinned.
 *   3. Every bare package the root README's JavaScript snippets import is installed by an
 *      `npm i` command in that README (an import with no matching install line is a #181 bug).
 *
 * Run checks (`npm run examples:run [-- name...]`, needs the network and Python 3.10+):
 *   Copies each example to a fresh directory OUTSIDE this checkout, installs from the registry
 *   (`npm install`, or a venv and `pip install -r requirements.txt`), runs it, and compares its
 *   exact stdout to the example README's `<!-- expected-output -->` block. A nonzero exit or a
 *   difference fails. The failure message names the example and the first differing line number,
 *   never the output itself.
 *
 *   node scripts/check-examples.mjs [--write] [--run [name...]]
 */

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const examplesDir = join(repoRoot, "examples");

const problems = [];
const fail = (message) => problems.push(message);

function exampleNames() {
  return readdirSync(examplesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && existsSync(join(examplesDir, entry.name, "README.md")))
    .map((entry) => entry.name)
    .sort();
}

function markdownFiles() {
  const files = ["README.md", "python/README.md", "docs/pii.md", "docs/troubleshooting.md", "examples/README.md"];
  for (const dir of ["packages"]) {
    for (const pkg of readdirSync(join(repoRoot, dir))) files.push(join(dir, pkg, "README.md"));
  }
  for (const name of exampleNames()) files.push(join("examples", name, "README.md"));
  return files.filter((file) => existsSync(join(repoRoot, file)));
}

// ---- snippets -------------------------------------------------------------------------------

/** The text of `path#region` between `snippet:start region` and `snippet:end region` (any comment style). */
function sourceSnippet(ref) {
  const [path, region] = ref.split("#");
  const text = readFileSync(join(repoRoot, path), "utf-8");
  if (region === undefined) return text.replace(/\n$/, "");
  const lines = text.split("\n");
  const start = lines.findIndex((line) => line.includes(`snippet:start ${region}`));
  const end = lines.findIndex((line) => line.includes(`snippet:end ${region}`));
  if (start === -1 || end === -1 || end < start) throw new Error(`${ref}: no snippet region`);
  const body = lines.slice(start + 1, end);
  const indent = Math.min(...body.filter((l) => l.trim() !== "").map((l) => l.match(/^ */)[0].length));
  return body
    .map((l) => l.slice(indent))
    .join("\n")
    .replace(/^\n+|\n+$/g, "");
}

const SNIPPET = /(<!-- snippet: ([^\s]+) -->\n```(\w*)\n)([\s\S]*?)(```)/g;

function checkSnippets(write) {
  for (const file of markdownFiles()) {
    const path = join(repoRoot, file);
    const text = readFileSync(path, "utf-8");
    let changed = false;
    const next = text.replace(SNIPPET, (whole, open, ref, _lang, body, close) => {
      let expected;
      try {
        expected = `${sourceSnippet(ref)}\n`;
      } catch (error) {
        fail(`${file}: ${error.message}`);
        return whole;
      }
      if (body === expected) return whole;
      if (write) {
        changed = true;
        return `${open}${expected}${close}`;
      }
      fail(`${file}: snippet ${ref} differs from its source (run: node scripts/check-examples.mjs --write)`);
      return whole;
    });
    if (changed) writeFileSync(path, next);
  }
}

// ---- manifests ------------------------------------------------------------------------------

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

function checkManifests() {
  for (const name of exampleNames()) {
    const dir = join(examplesDir, name);
    const pkgPath = join(dir, "package.json");
    const reqPath = join(dir, "requirements.txt");
    if (!existsSync(pkgPath) && !existsSync(reqPath)) fail(`examples/${name}: no package.json or requirements.txt`);
    if (existsSync(pkgPath)) {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      if (pkg.private !== true || pkg.type !== "module") fail(`examples/${name}/package.json: must be private and ESM`);
      if (typeof pkg.scripts?.start !== "string") fail(`examples/${name}/package.json: no start script`);
      for (const [dep, version] of Object.entries(pkg.dependencies ?? {})) {
        if (!EXACT.test(version)) fail(`examples/${name}/package.json: ${dep} is "${version}", not an exact version`);
      }
      for (const key of ["devDependencies", "peerDependencies", "optionalDependencies", "workspaces", "overrides"]) {
        if (pkg[key] !== undefined) fail(`examples/${name}/package.json: ${key} is not allowed in a consumer example`);
      }
    }
    if (existsSync(reqPath)) {
      for (const raw of readFileSync(reqPath, "utf-8").split("\n")) {
        const line = raw.trim();
        if (line === "" || line.startsWith("#")) continue;
        if (!/^[A-Za-z0-9_.-]+(\[[A-Za-z0-9_,-]+\])?==[0-9A-Za-z.]+$/.test(line)) {
          fail(`examples/${name}/requirements.txt: "${line}" is not an exact == pin`);
        }
      }
    }
    const readme = readFileSync(join(dir, "README.md"), "utf-8");
    if (!/<!-- expected-output -->\n```text\n/.test(readme))
      fail(`examples/${name}/README.md: no expected-output block`);
  }
}

function checkRootReadmeInstalls() {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");
  const installed = new Set();
  for (const match of readme.matchAll(/npm i(?:nstall)? ([^`\n]+)/g)) {
    for (const word of match[1].split(/\s+/)) if (word !== "" && !word.startsWith("-")) installed.add(word);
  }
  for (const block of readme.matchAll(/```js\n([\s\S]*?)```/g)) {
    for (const imp of block[1].matchAll(/from "([^"./][^"]*)"/g)) {
      const spec = imp[1].startsWith("@") ? imp[1].split("/").slice(0, 2).join("/") : imp[1].split("/")[0];
      if (!spec.startsWith("node:") && !installed.has(spec)) {
        fail(`README.md: a snippet imports ${spec}, which no \`npm i\` line there installs`);
      }
    }
  }
}

// ---- running --------------------------------------------------------------------------------

function sh(command, args, cwd, env = {}) {
  return spawnSync(command, args, { cwd, encoding: "utf-8", env: { ...process.env, ...env } });
}

function expectedOutput(name) {
  const readme = readFileSync(join(examplesDir, name, "README.md"), "utf-8");
  const match = /<!-- expected-output -->\n```text\n([\s\S]*?)```/.exec(readme);
  if (match === null) throw new Error(`examples/${name}/README.md: no expected-output block`);
  return match[1];
}

function runExample(name) {
  const work = mkdtempSync(join(tmpdir(), `redact-example-${name}-`));
  try {
    cpSync(join(examplesDir, name), work, {
      recursive: true,
      filter: (src) => !/node_modules|\.venv/.test(relative(join(examplesDir, name), src)),
    });
    let result;
    if (existsSync(join(work, "package.json"))) {
      const install = sh("npm", ["install", "--no-audit", "--no-fund", "--silent"], work);
      if (install.status !== 0) return fail(`examples/${name}: npm install failed`);
      result = sh("npm", ["start", "--silent"], work);
    } else {
      const python = process.env.PYTHON ?? "python3";
      if (sh(python, ["-m", "venv", ".venv"], work).status !== 0) return fail(`examples/${name}: venv creation failed`);
      const bin = join(work, ".venv", "bin", "python");
      const pip = sh(
        bin,
        ["-m", "pip", "install", "--quiet", "--disable-pip-version-check", "-r", "requirements.txt"],
        work,
      );
      if (pip.status !== 0) return fail(`examples/${name}: pip install failed`);
      result = sh(bin, [existsSync(join(work, "check.py")) ? "check.py" : "main.py"], work);
    }
    if (result.status !== 0) return fail(`examples/${name}: the example exited with status ${result.status}`);
    const actual = result.stdout.split("\n");
    const expected = expectedOutput(name).split("\n");
    const at = actual.findIndex((line, i) => line !== expected[i]);
    if (at !== -1 || actual.length !== expected.length) {
      return fail(
        `examples/${name}: stdout differs from the README's expected output at line ${(at === -1 ? Math.min(actual.length, expected.length) : at) + 1}`,
      );
    }
    console.log(`ok  examples/${name}`);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

// ---- main -----------------------------------------------------------------------------------

const args = process.argv.slice(2);
const runIndex = args.indexOf("--run");
const write = args.includes("--write");

checkSnippets(write);
checkManifests();
checkRootReadmeInstalls();

if (runIndex !== -1) {
  const wanted = args.slice(runIndex + 1).filter((arg) => !arg.startsWith("--"));
  const names = wanted.length > 0 ? wanted : exampleNames();
  for (const name of names) {
    if (!exampleNames().includes(name)) fail(`unknown example ${name}`);
    else runExample(name);
  }
}

if (problems.length > 0) {
  for (const problem of problems) console.error(`FAIL: ${problem}`);
  process.exit(1);
}
console.log(runIndex === -1 ? "examples: static checks ok" : "examples: static and run checks ok");
