/**
 * Sanitized failure diagnostics (#197), built from an allowlist in the style of
 * scripts/support-summary.mjs (#186): every field is copied by name from a closed source and
 * validated; anything else is dropped. Nothing here reads environment variables, copies an
 * exception or assertion message, a path, a host name or a log line that is not on the log
 * allowlist, and nothing is serialized wholesale. The consumer environment is reported in the
 * #186 support-summary format (buildSummary), so a maintainer reads the same shape as in an issue.
 *
 * Used by testbed/run.mjs (writes diagnostics.json, the file CI uploads first) and unit tested in
 * testbed/test/diagnostics.test.mjs.
 */

import { buildSummary, cleanVersion, ROUTES } from "../../scripts/support-summary.mjs";

export const DIAGNOSTICS_SCHEMA = "redact-secret-adapters/testbed-diagnostics-v1";
export const STAGES = ["preflight", "stage-artifacts", "build", "start", "run", "interrupted"];
const OUTCOMES = ["pass", "assertion-failed", "environment-failed", "interrupted"];
const STATUSES = ["pass", "fail", "error", "unsupported"];
const FAULTS = [
  "missing-artifact",
  "missing-peer",
  "wrong-mode",
  "broken-exports",
  "startup-failure",
  "wrong-expectation",
  "ui-wrong-response",
];
const SHA = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SCENARIO_ID = /^(smoke|pino|pylog|aictx|browser|ui)\.[a-z0-9]+(-[a-z0-9]+)*$/;
const ERROR_CODE = /^[A-Za-z0-9_.-]{1,80}$/;
const PACKAGE = /^(@[a-z0-9-]+\/)?[a-z0-9._-]{1,60}$/;
const MAX = { failures: 40, assertions: 8, journeys: 80, packages: 40, label: 120, logLines: 60, logLine: 200 };

/** Keeps only characters that appear in authored titles and labels; everything else becomes '?'. */
export function plainLabel(value, max = MAX.label) {
  return String(value ?? "")
    .replace(/[^A-Za-z0-9 .,:;_()/'+=\-[\]#]/g, "?")
    .slice(0, max);
}

/** Log lines the services print on purpose, and nothing else. Other lines are counted, not kept. */
const LOG_ALLOW = [
  /^(?:[a-z0-9-]+\s+\|\s+)?(?:node|python|browser) consumer ready: [A-Za-z0-9 ,.:()_/-]{1,120}$/,
  /^(?:[a-z0-9-]+\s+\|\s+)?ui ready: consumers [a-z,]{1,40}$/,
  /^(?:[a-z0-9-]+\s+\|\s+)?testbed fault injection: [a-z-]{1,40}$/,
];

export function filterServiceLogs(text) {
  const lines = String(text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.filter((l) => LOG_ALLOW.some((rx) => rx.test(l))).slice(0, MAX.logLines);
  return { kept: kept.map((l) => l.slice(0, MAX.logLine)), withheld: lines.length - kept.length };
}

/** The one line the installers print on a verified failure, reduced to plain characters. */
export function installFailureLine(text) {
  const m = /INSTALL VERIFICATION FAILED: ([^\n]{1,300})/.exec(String(text ?? ""));
  return m ? plainLabel(m[1], 200) : null;
}

function scenarioFailures(scenarios, scrub) {
  const list = Array.isArray(scenarios?.results) ? scenarios.results : [];
  const failures = [];
  for (const s of list) {
    if (!SCENARIO_ID.test(s?.scenarioId ?? "")) continue;
    const status = STATUSES.includes(s.status) ? s.status : "error";
    if (status === "pass" || (status === "unsupported" && s.envelopeValid !== false)) continue;
    failures.push({
      id: s.scenarioId,
      status,
      errorCode: ERROR_CODE.test(s.error?.code ?? "") ? s.error.code : null,
      failedAssertions: (Array.isArray(s.assertions) ? s.assertions : [])
        .filter((a) => a?.ok !== true)
        .slice(0, MAX.assertions)
        .map((a) => scrub(plainLabel(a?.name))),
    });
  }
  return {
    total: list.length,
    passed: list.filter((s) => s?.status === "pass").length,
    unsupported: list.filter((s) => s?.status === "unsupported").length,
    failures: failures.slice(0, MAX.failures),
  };
}

function journeys(playwright) {
  const out = [];
  const walk = (suite) => {
    for (const spec of suite.specs ?? []) {
      const results = (spec.tests ?? []).flatMap((t) => t.results ?? []);
      const status = results.at(-1)?.status;
      out.push({
        title: plainLabel(spec.title),
        status: ["passed", "failed", "timedOut", "skipped", "interrupted"].includes(status) ? status : "unknown",
      });
    }
    for (const child of suite.suites ?? []) walk(child);
  };
  for (const suite of Array.isArray(playwright?.suites) ? playwright.suites : []) walk(suite);
  return out.slice(0, MAX.journeys);
}

/** Packages as installed, in the #186 support-summary format, from what the consumers reported. */
function summaries(resolved, arch) {
  const out = {};
  const node = resolved?.node;
  if (node && typeof node === "object") {
    const installed = {};
    const add = (p) => {
      if (PACKAGE.test(p?.name ?? "")) installed[p.name] = { status: "installed", version: cleanVersion(p.version) };
    };
    for (const p of node.adapters ?? []) add(p);
    for (const p of node.hosts ?? []) add(p);
    add(node.core);
    out.node = buildSummary({
      node: typeof node.node === "string" ? node.node.replace(/^v/, "") : undefined,
      platform: "linux",
      arch,
      installed,
    });
  }
  const python = resolved?.python;
  if (python && typeof python === "object") {
    const versions = Object.fromEntries(
      (python.adapters ?? []).filter((p) => typeof p?.name === "string").map((p) => [p.name, p.version]),
    );
    out.python = buildSummary({
      platform: "linux",
      arch,
      python: {
        status: "collected",
        python: python.python,
        packages: [
          { name: "redact-secret-adapters", version: versions["redact-secret-adapters"] },
          { name: "redact-secret", version: python.core?.["redact-secret"] },
        ],
      },
    });
  }
  return out;
}

export function buildDiagnostics({
  provenance,
  exitCode,
  stage,
  scenarios,
  playwright,
  browserLane,
  installFailure,
  logs,
  arch,
  scrub = (s) => s,
}) {
  const packages = [];
  const addPackage = (p, sha) => {
    if (PACKAGE.test(p?.name ?? ""))
      packages.push({
        name: p.name,
        version: cleanVersion(p.version) ?? null,
        sha256: SHA256.test(sha ?? "") ? sha : null,
      });
  };
  for (const p of Array.isArray(provenance?.artifacts?.npm?.adapters) ? provenance.artifacts.npm.adapters : [])
    addPackage(p, p.sha256);
  addPackage(provenance?.artifacts?.npm?.core, null);
  addPackage(provenance?.artifacts?.python, provenance?.artifacts?.python?.sha256);

  const outcome =
    exitCode === 0
      ? "pass"
      : stage === "interrupted"
        ? "interrupted"
        : exitCode === 1
          ? "assertion-failed"
          : "environment-failed";
  return {
    schema: DIAGNOSTICS_SCHEMA,
    runId: /^[0-9A-Za-z-]{1,40}$/.test(provenance?.runId ?? "") ? provenance.runId : null,
    mode: provenance?.mode === "published" ? "published" : "candidate",
    evidence:
      provenance?.mode === "published"
        ? "published versions: says nothing about this checkout"
        : "candidate: this checkout, packed",
    outcome: OUTCOMES.includes(outcome) ? outcome : "environment-failed",
    exitCode: Number.isInteger(exitCode) ? exitCode : null,
    failedStage: exitCode === 0 ? null : STAGES.includes(stage) ? stage : null,
    fault: FAULTS.includes(provenance?.fault) ? provenance.fault : null,
    checkout: {
      sha: SHA.test(provenance?.checkout?.sha ?? "") ? provenance.checkout.sha : null,
      dirty: provenance?.checkout?.dirty === true,
    },
    packages: packages.slice(0, MAX.packages),
    installFailure: installFailure ? scrub(plainLabel(installFailure, 200)) : null,
    scenarios: scenarioFailures(scenarios, scrub),
    journeys: journeys(playwright),
    browserLane: ["supported/pass", "blocked-by-packaging", "failed"].includes(browserLane?.status)
      ? browserLane.status
      : null,
    serviceLogs: logs
      ? {
          kept: logs.kept.slice(0, MAX.logLines).map((l) => scrub(plainLabel(l, MAX.logLine))),
          withheldLines: logs.withheld,
        }
      : null,
    consumers: summaries(provenance?.resolved, arch),
    reportTo: { integration: ROUTES.integration.repository },
    scope:
      "Linux containers and Chromium only. Not evidence for macOS or Windows, and not a statement about detector accuracy or performance.",
  };
}
