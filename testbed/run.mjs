#!/usr/bin/env node
/**
 * The testbed one-command runner (#192, #193).
 *
 *   npm run testbed                          candidate: install this checkout's packed artifacts
 *   npm run testbed -- --mode published      install the explicitly pinned released versions
 *
 * Steps: preflight (Docker) -> stage artifacts (pack/wheel + manifest, fresh per run) ->
 * build images (clean installs, verified) -> start healthy services (bounded wait) ->
 * run every registered scenario and the Playwright specs inside the compose network ->
 * write provenance.json + report.json -> clean up (always, also on failure and Ctrl-C).
 *
 * Exit codes: 0 all scenarios and browser specs passed; 1 an assertion failed;
 * 2 the environment, install or startup failed; 130 interrupted.
 *
 * Options:
 *   --mode candidate|published   (default candidate)
 *   --published <name>=<ver>     override a published-mode pin (repeatable)
 *   --port <n>                   UI loopback port (default: first free from 18080)
 *   --no-cache                   build images without the Docker layer cache
 *   --keep                       leave services running and images in place (prints the cleanup command)
 *   --wait-timeout <s>           bounded readiness wait (default 90)
 *   --fault <name>               self-test only: missing-artifact | missing-peer | wrong-mode |
 *                                broken-exports | startup-failure. The run must then exit non-zero.
 *   --candidate-dir <dir>        self-test only: use a prepared artifacts directory instead of packing
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePlans } from "./lib/pins.mjs";
import { checkoutIdentity, stageArtifacts } from "./lib/stage.mjs";

const testbedDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(testbedDir, "..");
const FAULTS = ["missing-artifact", "missing-peer", "wrong-mode", "broken-exports", "startup-failure"];
const KEEP_RUNS = 5;

function parseArgs(argv) {
  const o = {
    mode: "candidate",
    published: {},
    port: null,
    noCache: false,
    keep: false,
    waitTimeout: 90,
    fault: null,
    candidateDir: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? usage(`${a} needs a value`);
    if (a === "--mode") o.mode = next();
    else if (a === "--published") {
      const [name, version] = next().split("=");
      if (!name || !version) usage("--published expects <name>=<version>");
      o.published[name] = version;
    } else if (a === "--port") o.port = Number(next());
    else if (a === "--no-cache") o.noCache = true;
    else if (a === "--keep") o.keep = true;
    else if (a === "--wait-timeout") o.waitTimeout = Number(next());
    else if (a === "--fault") o.fault = next();
    else if (a === "--candidate-dir") o.candidateDir = next();
    else usage(`unknown option ${a}`);
  }
  if (!["candidate", "published"].includes(o.mode)) usage(`--mode must be candidate or published, got '${o.mode}'`);
  if (o.fault && !FAULTS.includes(o.fault)) usage(`--fault must be one of ${FAULTS.join(", ")}`);
  if (o.port !== null && !(Number.isInteger(o.port) && o.port > 1023 && o.port < 65536))
    usage("--port must be 1024-65535");
  if (!(o.waitTimeout > 0 && o.waitTimeout <= 600)) usage("--wait-timeout must be 1-600 seconds");
  return o;
}

function usage(message) {
  console.error(`testbed: ${message}\nsee the header of testbed/run.mjs or testbed/README.md`);
  process.exit(2);
}

function freePort(start) {
  return new Promise((resolve, reject) => {
    const tryPort = (p) => {
      if (p > start + 200) return reject(new Error("no free loopback port found"));
      const s = createServer();
      s.once("error", () => tryPort(p + 1));
      s.listen(p, "127.0.0.1", () => s.close(() => resolve(p)));
    };
    tryPort(start);
  });
}

const children = new Set();
function exec(cmd, args, { env = {}, quiet = false } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: quiet ? ["ignore", "ignore", "ignore"] : "inherit",
      env: { ...process.env, ...env },
    });
    children.add(child);
    child.on("close", (code) => {
      children.delete(child);
      resolve(code ?? 1);
    });
    child.on("error", () => resolve(127));
  });
}

function pinnedImages() {
  const out = {};
  for (const f of ["node-consumer", "python-consumer", "runner", "ui"]) {
    const text = readFileSync(join(testbedDir, "services", f, "Dockerfile"), "utf-8");
    const m = /^ARG (?:NODE|PYTHON|PLAYWRIGHT)_IMAGE=(\S+)/m.exec(text);
    if (m) out[f] = m[1];
  }
  return out;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.fault) console.log(`!! FAULT INJECTION '${opts.fault}': this run is a self-test and is expected to FAIL.`);

  // Preflight: Docker must answer, Compose v2 must exist.
  if ((await exec("docker", ["info"], { quiet: true })) !== 0) {
    console.error("Docker is not available. Start Docker (Linux engine) and retry; see testbed/README.md.");
    return 2;
  }
  if ((await exec("docker", ["compose", "version"], { quiet: true })) !== 0) {
    console.error("Docker Compose v2 ('docker compose') is required.");
    return 2;
  }

  const runId = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..*/, "Z")}-${Math.random().toString(36).slice(2, 6)}`;
  const outDir = join(testbedDir, "out", runId);
  mkdirSync(outDir, { recursive: true });
  pruneOldRuns();
  const project = `redact-testbed-${runId.toLowerCase()}`;
  const port = opts.port ?? (await freePort(18080));
  const images = pinnedImages();
  const plans = resolvePlans(repoRoot, testbedDir);
  const identity = checkoutIdentity(repoRoot);
  console.log(
    `testbed run ${runId}: mode ${opts.mode}, checkout ${identity.sha.slice(0, 12)}${identity.dirty ? " (dirty)" : ""}, UI 127.0.0.1:${port}`,
  );

  const provenance = {
    schema: "redact-secret-adapters/testbed-provenance-v1",
    runId,
    mode: opts.mode,
    evidence:
      opts.mode === "candidate"
        ? "candidate (packed from the checkout)"
        : "published (registry versions; says nothing about this checkout)",
    fault: opts.fault,
    checkout: identity,
    docker: { platform: `${platform()}-${arch()} host; Linux containers`, images },
    plans,
  };
  const writeProvenance = () =>
    writeFileSync(join(outDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);

  const fragments = readdirSync(join(testbedDir, "services"))
    .filter((d) => existsSync(join(testbedDir, "services", d, "compose.yaml")))
    .map((d) => join("services", d, "compose.yaml"));
  const composeArgs = [
    "compose",
    "-p",
    project,
    "-f",
    join(testbedDir, "compose.yaml"),
    ...fragments.flatMap((f) => ["-f", join(testbedDir, f)]),
  ];
  const env = {
    TESTBED_PROJECT: project,
    TESTBED_ARTIFACTS_DIR: join(outDir, "artifacts"),
    TESTBED_OUT_DIR: join(outDir, "reports"),
    TESTBED_UI_PORT: String(port),
    TESTBED_UID: String(process.getuid?.() ?? 1000),
    TESTBED_GID: String(process.getgid?.() ?? 1000),
    TESTBED_FAULT: ["missing-peer", "wrong-mode", "broken-exports", "startup-failure"].includes(opts.fault)
      ? opts.fault
      : "",
  };
  mkdirSync(env.TESTBED_OUT_DIR, { recursive: true });
  const compose = (...a) => exec("docker", [...composeArgs, ...a], { env });

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    if (opts.keep) {
      console.log(
        `--keep: services left running. Clean up with:\n  docker compose -p ${project} down --volumes --remove-orphans --rmi local`,
      );
      return;
    }
    console.log("== cleanup");
    try {
      // Scoped to this run's project: only its containers, networks, volumes and locally built images.
      execFileSync(
        "docker",
        [
          ...composeArgs,
          "--profile",
          "runner",
          "down",
          "--volumes",
          "--remove-orphans",
          "--rmi",
          "local",
          "--timeout",
          "10",
        ],
        {
          stdio: "ignore",
          env: { ...process.env, ...env },
          timeout: 120000,
        },
      );
    } catch {
      console.error(
        `cleanup may be incomplete; inspect with: docker ps -a --filter label=com.docker.compose.project=${project}`,
      );
    }
  };
  let interrupted = false;
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      if (interrupted) return;
      interrupted = true;
      console.error(`\n${sig}: stopping and cleaning up`);
      for (const c of children) c.kill("SIGTERM");
      cleanup();
      writeProvenance();
      process.exit(130);
    });
  }

  let exitCode = 2;
  try {
    // 1. Stage clean artifacts (#193).
    try {
      const staged = stageArtifacts({
        repoRoot,
        outDir,
        mode: opts.mode,
        plans,
        publishedOverrides: opts.published,
        pythonImage: images["python-consumer"],
        candidateDir: opts.candidateDir,
      });
      if (opts.fault === "missing-artifact") {
        const first = readdirSync(join(staged.artifacts, "npm"))[0];
        rmSync(join(staged.artifacts, "npm", first));
        console.log(`!! fault: removed ${first} after hashing it`);
      }
      provenance.artifacts = staged.manifest;
    } catch (err) {
      console.error(`staging artifacts failed: ${err.message}`);
      return 2;
    }
    writeProvenance();

    // 2. Build the consumer images: this is the clean install, verified inside the build.
    console.log("== build images (clean install in isolated consumers)");
    if ((await compose("--profile", "runner", "build", ...(opts.noCache ? ["--no-cache"] : []))) !== 0) {
      console.error("image build failed (install or verification failure above)");
      return 2;
    }

    // 3. Start services with a bounded readiness wait.
    console.log(`== start services (wait <= ${opts.waitTimeout}s)`);
    if (
      (await compose(
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        String(opts.waitTimeout),
        "ui",
        "node-consumer",
        "python-consumer",
      )) !== 0
    ) {
      console.error("services did not become healthy; last logs:");
      await compose("logs", "--no-color", "--tail", "40");
      return 2;
    }

    // 4. Resolved identities as the running consumers report them.
    try {
      provenance.resolved = await (
        await fetch(`http://127.0.0.1:${port}/api/provenance`, { signal: AbortSignal.timeout(10000) })
      ).json();
    } catch {
      console.error("could not read /api/provenance from the UI");
      return 2;
    }
    writeProvenance();

    // 5. Scenarios and Playwright inside the compose network.
    console.log("== run scenarios and Playwright");
    const runnerCode = await compose("run", "--rm", "--no-deps", "runner");
    exitCode = runnerCode === 0 ? 0 : 1;
    if (exitCode !== 0) await compose("logs", "--no-color", "--tail", "40", "node-consumer", "python-consumer");
  } finally {
    summarize(outDir, provenance, exitCode);
    cleanup();
  }
  return exitCode;
}

function summarize(outDir, provenance, exitCode) {
  let scenarios = null;
  try {
    scenarios = JSON.parse(readFileSync(join(outDir, "reports", "scenario-results.json"), "utf-8"));
  } catch {
    // runner never produced a report: exit code already non-zero
  }
  const artifactOf = (id) => scenarios?.results?.find((r) => r.scenarioId === id)?.evidence?.artifact ?? null;
  provenance.runtimeArtifact = {
    node: artifactOf("smoke.node-core-active"),
    python: artifactOf("smoke.python-core-active"),
  };
  const report = {
    schema: "redact-secret-adapters/testbed-report-v1",
    runId: provenance.runId,
    mode: provenance.mode,
    exitCode,
    scenarios,
  };
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  console.log(`\nreports: ${outDir}\n  provenance.json  report.json  reports/`);
  console.log(exitCode === 0 ? "TESTBED PASS" : `TESTBED FAIL (exit ${exitCode})`);
  console.log("Linux containers only: this does not qualify macOS or Windows, and claims no general leak prevention.");
}

function pruneOldRuns() {
  const dir = join(testbedDir, "out");
  const runs = readdirSync(dir)
    .filter((d) => /^\d{8}T\d{6}Z-/.test(d))
    .sort();
  for (const old of runs.slice(0, Math.max(0, runs.length - KEEP_RUNS)))
    rmSync(join(dir, old), { recursive: true, force: true });
}

process.exitCode = await main();
