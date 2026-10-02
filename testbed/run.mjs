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
 *   --run-timeout <s>            bound on the in-network scenario and browser stage (default 900)
 *   --headed-debug               build and start, publish the services on extra loopback ports, skip the
 *                                in-network tests and leave everything running so Playwright can run
 *                                headed from the host (testbed/README.md, "Headed debugging")
 *   --fault <name>               self-test only: missing-artifact | missing-peer | wrong-mode |
 *                                broken-exports | startup-failure | wrong-expectation | ui-wrong-response.
 *                                The run must then exit non-zero.
 *   --candidate-dir <dir>        self-test only: use a prepared artifacts directory instead of packing
 */

import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { arch, platform } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSentinels, makeScrubber } from "./contract/envelope.mjs";
import { buildDiagnostics, filterServiceLogs, installFailureLine } from "./lib/diagnostics.mjs";
import { resolvePlans } from "./lib/pins.mjs";
import { checkoutIdentity, stageArtifacts } from "./lib/stage.mjs";

const testbedDir = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = join(testbedDir, "..");
const FAULTS = [
  "missing-artifact",
  "missing-peer",
  "wrong-mode",
  "broken-exports",
  "startup-failure",
  "wrong-expectation",
  "ui-wrong-response",
];
const RUNTIME_FAULTS = [
  "missing-peer",
  "wrong-mode",
  "broken-exports",
  "startup-failure",
  "wrong-expectation",
  "ui-wrong-response",
];
const KEEP_RUNS = 5;
const MAX_CAPTURE = 400_000;

function parseArgs(argv) {
  const o = {
    mode: "candidate",
    published: {},
    port: null,
    noCache: false,
    keep: false,
    waitTimeout: 90,
    runTimeout: 900,
    headedDebug: false,
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
    else if (a === "--run-timeout") o.runTimeout = Number(next());
    else if (a === "--headed-debug") o.headedDebug = true;
    else if (a === "--fault") o.fault = next();
    else if (a === "--candidate-dir") o.candidateDir = next();
    else usage(`unknown option ${a}`);
  }
  if (!["candidate", "published"].includes(o.mode)) usage(`--mode must be candidate or published, got '${o.mode}'`);
  if (o.fault && !FAULTS.includes(o.fault)) usage(`--fault must be one of ${FAULTS.join(", ")}`);
  if (o.port !== null && !(Number.isInteger(o.port) && o.port > 1023 && o.port < 65536))
    usage("--port must be 1024-65535");
  if (!(o.waitTimeout > 0 && o.waitTimeout <= 600)) usage("--wait-timeout must be 1-600 seconds");
  if (!(o.runTimeout > 0 && o.runTimeout <= 3600)) usage("--run-timeout must be 1-3600 seconds");
  if (o.headedDebug) o.keep = true;
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
/**
 * Runs a command. `capture` (optional) receives the combined output while it is still echoed;
 * `timeoutMs` kills the command (exit 124) so no stage can hang forever.
 */
function exec(cmd, args, { env = {}, quiet = false, capture = null, timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      stdio: quiet ? ["ignore", "ignore", "ignore"] : capture ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { ...process.env, ...env },
    });
    children.add(child);
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGTERM");
        }, timeoutMs)
      : null;
    if (capture) {
      child.stdout.on("data", (d) => {
        process.stdout.write(d);
        capture(d.toString());
      });
      child.stderr.on("data", (d) => {
        process.stderr.write(d);
        capture(d.toString());
      });
    }
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      children.delete(child);
      resolve(timedOut ? 124 : (code ?? 1));
    });
    child.on("error", () => resolve(127));
  });
}

function pinnedImages() {
  const out = {};
  for (const f of readdirSync(join(testbedDir, "services"))) {
    if (!existsSync(join(testbedDir, "services", f, "Dockerfile"))) continue;
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
  let composeArgs = [
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
    TESTBED_FAULT: RUNTIME_FAULTS.includes(opts.fault) ? opts.fault : "",
  };
  mkdirSync(env.TESTBED_OUT_DIR, { recursive: true });
  const compose = (...a) => exec("docker", [...composeArgs, ...a], { env });
  /** The last service log lines, reduced to the allowlisted ones (see lib/diagnostics.mjs). */
  const readServiceLogs = () => {
    try {
      const text = execFileSync("docker", [...composeArgs, "logs", "--no-color", "--tail", "200"], {
        env: { ...process.env, ...env },
        encoding: "utf-8",
        maxBuffer: 4_000_000,
        timeout: 30000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return filterServiceLogs(text);
    } catch {
      return null;
    }
  };
  let debugPorts = null;
  const post = { stage: "stage-artifacts", installFailure: null, logs: null };

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
    post.stage = "stage-artifacts";
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
    post.stage = "build";
    let buildOutput = "";
    const buildCode = await exec(
      "docker",
      [...composeArgs, "--profile", "runner", "build", ...(opts.noCache ? ["--no-cache"] : [])],
      {
        env,
        capture: (chunk) => {
          if (buildOutput.length < MAX_CAPTURE) buildOutput += chunk;
        },
      },
    );
    if (buildCode !== 0) {
      post.installFailure = installFailureLine(buildOutput);
      console.error("image build failed (install or verification failure above)");
      return 2;
    }

    // 3. Start services with a bounded readiness wait.
    console.log(`== start services (wait <= ${opts.waitTimeout}s)`);
    post.stage = "start";
    if (opts.headedDebug) {
      // Opt-in, loopback only: the consumers' scenario API (never the control API) next to the UI,
      // so the journeys can run on the host with a visible browser.
      debugPorts = { ui: port };
      let next = port;
      for (const name of ["node-consumer", "python-consumer", "browser-consumer"]) {
        next = await freePort(next + 1);
        debugPorts[name] = next;
      }
      const override = join(outDir, "debug-ports.compose.yaml");
      writeFileSync(
        override,
        `services:\n${Object.entries(debugPorts)
          .filter(([n]) => n !== "ui")
          .map(([n, p]) => `  ${n}:\n    ports: ["127.0.0.1:${p}:8080"]\n`)
          .join("")}`,
      );
      composeArgs = [...composeArgs, "-f", override];
    }
    if (
      // No service names: every default-profile service, including the fragments' (browser consumer, #195).
      (await compose("up", "-d", "--wait", "--wait-timeout", String(opts.waitTimeout))) !== 0
    ) {
      console.error("services did not become healthy; allowlisted service log lines:");
      post.logs = readServiceLogs();
      for (const line of post.logs?.kept ?? []) console.error(`  ${line}`);
      console.error(`  (${post.logs?.withheld ?? "?"} other lines withheld; see diagnostics.json)`);
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

    if (opts.headedDebug) {
      const base = `http://127.0.0.1`;
      console.log(`
== headed debugging: services are up and left running
UI                  ${base}:${debugPorts.ui}
node consumer API   ${base}:${debugPorts["node-consumer"]}   python ${base}:${debugPorts["python-consumer"]}   browser ${base}:${debugPorts["browser-consumer"]}
Run the journeys with a visible browser (Linux/Chromium only):
  cd testbed/services/runner && npm ci && npx playwright install chromium
  TESTBED_UI_URL=${base}:${debugPorts.ui} TESTBED_CONSUMER_URLS=node=${base}:${debugPorts["node-consumer"]},python=${base}:${debugPorts["python-consumer"]} \\
    TESTBED_BROWSER_URL=${base}:${debugPorts["browser-consumer"]} TESTBED_OUT=${join(outDir, "reports-headed")} \\
    npx playwright test --headed ui-journeys   # add --debug to step through`);
      post.stage = "run";
      exitCode = 0;
      return exitCode;
    }

    // 5. Scenarios and Playwright inside the compose network, bounded.
    console.log("== run scenarios and Playwright");
    post.stage = "run";
    const runnerCode = await exec("docker", [...composeArgs, "run", "--rm", "--no-deps", "runner"], {
      env,
      timeoutMs: opts.runTimeout * 1000,
    });
    if (runnerCode === 124)
      console.error(`the test stage exceeded --run-timeout (${opts.runTimeout}s) and was stopped`);
    exitCode = runnerCode === 0 ? 0 : 1;
    if (exitCode !== 0) post.logs = readServiceLogs();
  } finally {
    summarize(outDir, provenance, exitCode, post);
    cleanup();
  }
  return exitCode;
}

function summarize(outDir, provenance, exitCode, post) {
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
  let browserLane = null;
  try {
    // Written by the Playwright browser lane (#195): supported/pass | blocked-by-packaging | failed.
    browserLane = JSON.parse(readFileSync(join(outDir, "reports", "browser-lane.json"), "utf-8"));
  } catch {
    // no browser lane report: reported as absent, never as passed
  }
  const report = {
    schema: "redact-secret-adapters/testbed-report-v1",
    runId: provenance.runId,
    mode: provenance.mode,
    exitCode,
    scenarios,
    browserLane,
  };
  if (browserLane) provenance.runtimeArtifact.browser = browserLane.runtime?.piiOff?.artifact ?? null;
  if (browserLane) provenance.browserLane = { status: browserLane.status, provenance: browserLane.provenance ?? null };
  console.log(`browser lane: ${browserLane ? browserLane.status : "NOT REPORTED (failed)"}`);
  writeFileSync(join(outDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(join(outDir, "provenance.json"), `${JSON.stringify(provenance, null, 2)}\n`);
  // Sanitized failure diagnostics (#197): allowlisted fields only, in the #186 support-summary format.
  let playwright = null;
  try {
    playwright = JSON.parse(readFileSync(join(outDir, "reports", "playwright.json"), "utf-8"));
  } catch {
    // the browser stage never wrote a report
  }
  const scrub = makeScrubber(loadSentinels(join(testbedDir, "contract")));
  const diagnostics = buildDiagnostics({
    provenance,
    exitCode,
    stage: post.stage,
    scenarios,
    playwright,
    browserLane,
    installFailure: post.installFailure,
    logs: post.logs,
    arch: arch(),
    scrub,
  });
  writeFileSync(join(outDir, "diagnostics.json"), `${JSON.stringify(diagnostics, null, 2)}\n`);
  if (post.logs)
    writeFileSync(
      join(outDir, "service-logs.txt"),
      `${[...post.logs.kept, `(${post.logs.withheld} other log lines withheld by the allowlist)`].join("\n")}\n`,
    );
  if (exitCode !== 0) {
    const f = diagnostics.scenarios.failures;
    console.log(`\nfailed stage: ${diagnostics.failedStage ?? "unknown"}; outcome: ${diagnostics.outcome}`);
    if (diagnostics.installFailure) console.log(`install failure: ${diagnostics.installFailure}`);
    for (const x of f.slice(0, 10))
      console.log(`  ${x.status} ${x.id}${x.failedAssertions.length ? `: ${x.failedAssertions.join("; ")}` : ""}`);
    for (const j of diagnostics.journeys.filter((x) => x.status !== "passed").slice(0, 10))
      console.log(`  journey ${j.status}: ${j.title}`);
  }
  console.log(`\nreports: ${outDir}\n  diagnostics.json  provenance.json  report.json  reports/`);
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
