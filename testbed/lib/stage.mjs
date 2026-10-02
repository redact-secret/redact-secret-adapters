/**
 * Stages the install artifacts for one run (#193) into <outDir>/artifacts and
 * writes artifacts/manifest.json, the single input both consumer installers
 * read. The directory is created fresh for every run (a run ID is unique), so a
 * stale tarball or wheel from an earlier run can never be picked up; the
 * installers also compare each file's sha256 with the manifest.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const sha256 = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");

const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ["ignore", "pipe", "inherit"], encoding: "utf-8", ...opts });

export function checkoutIdentity(repoRoot) {
  const git = (...a) => run("git", a, { cwd: repoRoot }).trim();
  let sha = "unknown";
  let branch = "unknown";
  let dirty = null;
  try {
    sha = git("rev-parse", "HEAD");
    branch = git("rev-parse", "--abbrev-ref", "HEAD");
    dirty = git("status", "--porcelain").length > 0;
  } catch {
    // not a git checkout: recorded as unknown, never guessed
  }
  return { sha, branch, dirty };
}

/**
 * @param {object} o
 * @param {"candidate"|"published"} o.mode
 * @param {object} o.plans from resolvePlans
 * @param {Record<string,string>} o.publishedOverrides name=version overrides (published mode)
 * @param {string} o.pythonImage image used to build the wheel hermetically
 * @param {string|null} o.candidateDir use pre-built artifacts from here instead of packing (self-test)
 */
export function stageArtifacts({ repoRoot, outDir, mode, plans, publishedOverrides, pythonImage, candidateDir }) {
  const artifacts = join(outDir, "artifacts");
  mkdirSync(join(artifacts, "npm"), { recursive: true });
  mkdirSync(join(artifacts, "python"), { recursive: true });

  const npmPlan = {
    adapters: [],
    core: plans.npm.core,
    hosts: plans.npm.hosts,
  };
  const pyPlan = { name: plans.python.name, core: plans.python.core, hosts: plans.python.hosts };

  if (mode === "candidate") {
    if (candidateDir) {
      cpSync(candidateDir, artifacts, { recursive: true });
    } else {
      console.log("== build and pack npm packages from the checkout");
      run("npm", ["run", "build"], { cwd: repoRoot, stdio: "inherit" });
      for (const a of plans.npm.adapters) {
        const [{ filename }] = JSON.parse(
          run(
            "npm",
            ["pack", "--json", "--ignore-scripts", "--workspace", a.name, "--pack-destination", join(artifacts, "npm")],
            {
              cwd: repoRoot,
            },
          ),
        );
        if (!existsSync(join(artifacts, "npm", filename))) throw new Error(`npm pack did not produce ${filename}`);
      }
      console.log("== build the Python wheel from the checkout (hermetic container)");
      buildWheel(repoRoot, join(artifacts, "python"), pythonImage);
    }
    for (const a of plans.npm.adapters) {
      const file = readdirSync(join(artifacts, "npm")).find(
        (f) => f === `${a.name.replace("@", "").replace("/", "-")}-${a.version}.tgz`,
      );
      npmPlan.adapters.push({
        name: a.name,
        version: a.version,
        publishedPin: a.publishedPin,
        file: file ?? null,
        sha256: file ? sha256(join(artifacts, "npm", file)) : null,
      });
    }
    const pyProject = readFileSync(join(repoRoot, "python", "pyproject.toml"), "utf-8");
    const pyVersion = /^version = "([^"]+)"/m.exec(pyProject)?.[1];
    const wheel = readdirSync(join(artifacts, "python")).find((f) => f.endsWith(".whl"));
    Object.assign(pyPlan, {
      version: pyVersion,
      file: wheel ?? null,
      sha256: wheel ? sha256(join(artifacts, "python", wheel)) : null,
    });
  } else {
    for (const a of plans.npm.adapters) {
      const pin = publishedOverrides[a.name] ?? a.publishedPin;
      npmPlan.adapters.push({ name: a.name, pin: pin ?? null, version: pin ?? null });
    }
    const pin = publishedOverrides[plans.python.name] ?? plans.python.publishedPin;
    if (!pin) throw new Error(`published mode needs a version for ${plans.python.name}`);
    Object.assign(pyPlan, { version: pin });
  }

  const manifest = { schema: "redact-secret-adapters/testbed-artifacts-v1", mode, npm: npmPlan, python: pyPlan };
  writeFileSync(join(artifacts, "manifest.json"), JSON.stringify(manifest, null, 2));
  return { artifacts, manifest };
}

function buildWheel(repoRoot, dest, image) {
  // Copy python/ without build products so nothing stale is built, then build in a pinned container.
  const src = join(dest, "..", "python-src");
  mkdirSync(src, { recursive: true });
  cpSync(join(repoRoot, "python"), src, {
    recursive: true,
    filter: (p) => !/(^|\/)(dist|build|\.venv|__pycache__|\.pytest_cache|\.ruff_cache|[^/]*\.egg-info)(\/|$)/.test(p),
  });
  const uid = process.getuid?.() ?? 1000;
  const gid = process.getgid?.() ?? 1000;
  execFileSync(
    "docker",
    [
      "run",
      "--rm",
      "--user",
      `${uid}:${gid}`,
      "-e",
      "HOME=/tmp",
      "-e",
      "PIP_DISABLE_PIP_VERSION_CHECK=1",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--memory",
      "1g",
      "--pids-limit",
      "256",
      "-v",
      `${src}:/src`,
      "-v",
      `${dest}:/out`,
      image,
      "sh",
      "-c",
      "cd /src && python -m pip wheel --no-deps -w /out . >/tmp/wheel.log 2>&1 || { tail -30 /tmp/wheel.log >&2; exit 1; }",
    ],
    { stdio: "inherit" },
  );
}
