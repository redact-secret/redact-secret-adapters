import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDiagnostics, filterServiceLogs, installFailureLine, plainLabel } from "../lib/diagnostics.mjs";

const provenance = {
  runId: "20261001T000000Z-ab12",
  mode: "candidate",
  fault: "wrong-expectation",
  checkout: { sha: "a".repeat(40), dirty: false },
  secretEnv: "AWS_SECRET_ACCESS_KEY=should-never-appear",
  artifacts: {
    npm: {
      adapters: [
        { name: "@redact-secret/adapter-pino", version: "0.1.3", sha256: "b".repeat(64), file: "/home/x/y.tgz" },
      ],
      core: { name: "@redact-secret/core", version: "0.1.0-beta.12" },
    },
    python: {
      name: "redact-secret-adapters",
      version: "0.1.3",
      sha256: "c".repeat(64),
      core: { "redact-secret": "0.1.0b12" },
    },
  },
  resolved: {
    node: {
      node: "v22.16.0",
      adapters: [{ name: "@redact-secret/adapter-pino", version: "0.1.3", resolved: "file:/leak/path" }],
      hosts: [{ name: "pino", version: "10.3.1" }],
      core: { name: "@redact-secret/core", version: "0.1.0-beta.12" },
    },
    python: {
      python: "3.12.11",
      adapters: [{ name: "redact-secret-adapters", version: "0.1.3" }],
      core: { "redact-secret": "0.1.0b12" },
    },
  },
};
const scenarios = {
  results: [
    {
      scenarioId: "pino.policy-block",
      status: "fail",
      assertions: [
        { name: "marker present", ok: false, detail: "/secret/path" },
        { name: "fine", ok: true },
      ],
      evidence: { raw: "ghp_SHOULD_NOT_COPY" },
    },
    {
      scenarioId: "aictx.limits",
      status: "error",
      error: { code: "Error", message: "raw exception text with /home/user" },
      assertions: [],
    },
    { scenarioId: "smoke.node-core-active", status: "pass", assertions: [] },
    { scenarioId: "bad id!", status: "fail", assertions: [] },
  ],
};

test("diagnostics carry only allowlisted facts", () => {
  const d = buildDiagnostics({
    provenance,
    exitCode: 1,
    stage: "run",
    scenarios,
    playwright: {
      suites: [
        {
          specs: [
            {
              title: "ui.masking-journey: <script>x</script>",
              tests: [{ results: [{ status: "failed", errors: [{ message: "raw message /path" }] }] }],
            },
          ],
        },
      ],
    },
    browserLane: { status: "supported/pass" },
    installFailure: null,
    logs: filterServiceLogs(
      "node-consumer-1  | node consumer ready: 54 scenarios (mode candidate)\nTraceback /home/u/secret\nAWS_SECRET=zzz",
    ),
    arch: "arm64",
  });
  const text = JSON.stringify(d);
  for (const forbidden of [
    "should-never-appear",
    "/leak/path",
    "/home/",
    "/secret/path",
    "raw exception",
    "raw message",
    "SHOULD_NOT_COPY",
    "AWS_SECRET",
    "Traceback",
    "bad id",
  ])
    assert.ok(!text.includes(forbidden), `diagnostics leaked ${forbidden}`);
  assert.equal(d.outcome, "assertion-failed");
  assert.equal(d.failedStage, "run");
  assert.equal(d.fault, "wrong-expectation");
  assert.deepEqual(
    d.scenarios.failures.map((f) => [f.id, f.status, f.failedAssertions.length]),
    [
      ["pino.policy-block", "fail", 1],
      ["aictx.limits", "error", 0],
    ],
  );
  assert.equal(d.scenarios.failures[1].errorCode, "Error");
  assert.equal(d.journeys[0].status, "failed");
  assert.ok(!d.journeys[0].title.includes("<script"), "markup characters are not kept in titles... as markup");
  assert.equal(d.serviceLogs.kept.length, 1);
  assert.equal(d.serviceLogs.withheldLines, 2);
  assert.equal(d.consumers.node.schema, "redact-secret-adapters.support-summary/v1");
  assert.equal(d.consumers.node.runtime.platform, "linux");
  assert.equal(d.consumers.python.python.version, "3.12.11");
  assert.equal(d.packages.find((p) => p.name === "@redact-secret/adapter-pino").sha256, "b".repeat(64));
});

test("exit codes map to outcomes and stages", () => {
  const base = { provenance, scenarios: null, playwright: null, browserLane: null, logs: null, arch: "x64" };
  assert.equal(buildDiagnostics({ ...base, exitCode: 0, stage: "run" }).failedStage, null);
  assert.equal(buildDiagnostics({ ...base, exitCode: 2, stage: "build" }).outcome, "environment-failed");
  assert.equal(buildDiagnostics({ ...base, exitCode: 2, stage: "not-a-stage" }).failedStage, null);
});

test("service logs keep only the lines the services print on purpose", () => {
  const out = filterServiceLogs(
    "ui ready: consumers node,python\nnode consumer ready: 3 scenarios (mode candidate)\nsomething else\n\n/root/x",
  );
  assert.equal(out.kept.length, 2);
  assert.equal(out.withheld, 2);
});

test("the install failure line is reduced to plain characters", () => {
  assert.equal(
    installFailureLine("noise\nINSTALL VERIFICATION FAILED: tarball sha256 mismatch for adapter\nmore"),
    "tarball sha256 mismatch for adapter",
  );
  assert.equal(installFailureLine("nothing here"), null);
  assert.equal(plainLabel("a\u0000b\nc`$(x)"), "a?b?c??(x)");
});
