#!/usr/bin/env node
/**
 * Builds docker/bench.Dockerfile and runs the adapter-overhead harness in it
 * against the previous release (#97):
 *
 *   npm run bench:docker                                    # full run, out/overhead-js.json
 *   npm run bench:docker -- --quick
 *   npm run bench:docker -- --cpuset 2,3 --out out/run.json -- --profile log-flat
 *   npm run bench:docker -- --no-baseline                   # current build only
 *   npm run bench:docker -- --aa                            # current build against a copy of itself: the noise floor
 *   npm run bench:docker -- --baseline-packages "@redact-secret/adapter-pino@0.1.0"
 *   npm run bench:docker -- --python                        # the Python harness, out/overhead-python.json
 *   npm run bench:docker -- --python --baseline-packages 0.1.0
 *
 * The container has no network, a fixed memory limit, and, with --cpuset,
 * pinned CPUs. The image id and the source commit go into the output. Pass
 * --quick through to the harness for a shape-only smoke run. Everything after
 * `--` goes to the harness unchanged.
 *
 * Never run it under emulation (for example linux/amd64 on Apple silicon):
 * the image is always built for the Docker host's native platform.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { HOST_CPU_ENV, readHostCpuModel } from "./bench-environment.mjs";

const LANGUAGES = {
  javascript: {
    dockerfile: "docker/bench.Dockerfile",
    image: "redact-secret-adapters-bench",
    out: "out/overhead-js.json",
    baselineArg: "BASELINE_PACKAGES",
  },
  python: {
    dockerfile: "docker/bench-python.Dockerfile",
    image: "redact-secret-adapters-bench-python",
    out: "out/overhead-python.json",
    baselineArg: "BASELINE_VERSION",
  },
};

function parseArgs(argv) {
  const options = {
    language: "javascript",
    out: undefined,
    cpuset: undefined,
    baseline: true,
    baselinePackages: "",
    memory: "4g",
    harness: [],
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (flag === "--") {
      options.harness.push(...argv.slice(i + 1));
      break;
    }
    if (flag === "--quick") options.harness.push("--quick");
    else if (flag === "--no-baseline") options.baseline = false;
    else if (flag === "--aa") options.baseline = "self";
    else if (flag === "--python") options.language = "python";
    else if (flag === "--out") options.out = argv[++i];
    else if (flag === "--cpuset") options.cpuset = argv[++i];
    else if (flag === "--memory") options.memory = argv[++i];
    else if (flag === "--baseline-packages") options.baselinePackages = argv[++i];
    else throw new Error(`unknown argument: ${flag}`);
  }
  return options;
}

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

const options = parseArgs(process.argv.slice(2));
const language = LANGUAGES[options.language];
const IMAGE = language.image;
const root = fileURLToPath(new URL("..", import.meta.url));
const commit = git(["rev-parse", "HEAD"]);
const dirty = commit === "" ? "" : String(git(["status", "--porcelain"]) !== "");

execFileSync(
  "docker",
  [
    "build",
    "--file",
    language.dockerfile,
    "--tag",
    IMAGE,
    "--build-arg",
    `SOURCE_COMMIT=${commit}`,
    "--build-arg",
    `SOURCE_DIRTY=${dirty}`,
    "--build-arg",
    `${language.baselineArg}=${options.baselinePackages}`,
    ".",
  ],
  { cwd: root, stdio: ["ignore", "inherit", "inherit"] },
);
const imageId = execFileSync("docker", ["image", "inspect", "--format", "{{.Id}}", IMAGE], {
  encoding: "utf-8",
}).trim();

const hostCpu = readHostCpuModel();
if (hostCpu === null) {
  console.error("warning: could not read the host CPU model; the output will carry cpuModel null");
}

const out = resolve(options.out ?? language.out);
mkdirSync(dirname(out), { recursive: true });
const run = [
  "run",
  "--rm",
  "--network",
  "none",
  "--memory",
  options.memory,
  "--memory-swap",
  options.memory,
  ...(options.cpuset === undefined ? [] : ["--cpuset-cpus", options.cpuset]),
  "--env",
  `REDACT_SECRET_BENCH_IMAGE=${imageId}`,
  // The container cannot see the host CPU; the harness keys the profile on this (#108).
  ...(hostCpu === null ? [] : ["--env", `${HOST_CPU_ENV}=${hostCpu}`]),
  "--volume",
  `${dirname(out)}:/out`,
  "--user",
  `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
  IMAGE,
  ...(options.baseline === "self"
    ? ["--baseline", "/opt/self"]
    : options.baseline
      ? ["--baseline", "/opt/baseline"]
      : []),
  "--out",
  `/out/${basename(out)}`,
  ...options.harness,
];
execFileSync("docker", run, { stdio: ["ignore", "inherit", "inherit"] });
console.error(`wrote ${out} (image ${imageId})`);
