/**
 * Node consumer service (#192). Runs inside the consumer image next to, not
 * inside, the installed adapter packages. Two listeners:
 *
 *   :8080  scenario API (GET /healthz, /scenarios, /provenance; POST /run/<id>)
 *          reachable through the UI service.
 *   :8081  control API (POST /reset, GET /captures), reachable only from the
 *          compose-internal network. Test-only: it lives in this file, which
 *          is never part of any package.
 *
 * No request body is read, no path is evaluated, no URL is fetched: a request
 * can only pick a fixed scenario ID. One scenario runs at a time, with a
 * timeout.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { discoverScenarios, loadSentinels, makeScrubber, runScenario } from "./contract/envelope.mjs";
import { BoundedCaptures } from "./lib/captures.mjs";

const HOST = "node";
const SCENARIO_TIMEOUT_MS = Number(process.env.TESTBED_SCENARIO_TIMEOUT_MS ?? 20000);

if (process.env.TESTBED_FAULT === "startup-failure") {
  console.error("testbed fault injection: startup-failure");
  process.exit(1);
}

const installManifest = JSON.parse(readFileSync(new URL("./install-manifest.json", import.meta.url), "utf-8"));
const scrub = makeScrubber(loadSentinels(new URL("./contract", import.meta.url).pathname));
const scenarios = await discoverScenarios(
  new URL("./scenarios", import.meta.url).pathname,
  HOST,
  new URL("./contract", import.meta.url).pathname,
);
const captures = new BoundedCaptures();
const ctx = { host: HOST, install: installManifest, captures, appDir: new URL(".", import.meta.url).pathname };

let busy = false;

function send(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(text);
}

const api = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true, host: HOST });
  if (req.method === "GET" && url.pathname === "/provenance") return send(res, 200, installManifest);
  if (req.method === "GET" && url.pathname === "/scenarios") {
    return send(res, 200, {
      schema: "redact-secret-adapters/testbed-scenarios-v1",
      host: HOST,
      scenarios: [...scenarios.values()].map(({ id, title, classification }) => ({ id, title, classification })),
    });
  }
  const m = /^\/run\/([a-z0-9.-]{1,80})$/.exec(url.pathname);
  if (req.method === "POST" && m) {
    const def = scenarios.get(m[1]);
    if (!def) return send(res, 404, { error: "unknown scenario" });
    if (busy) return send(res, 409, { error: "a scenario is already running" });
    busy = true;
    try {
      const timeout = new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              timedOut: true,
            }),
          SCENARIO_TIMEOUT_MS,
        ).unref(),
      );
      const outcome = await Promise.race([runScenario(def, HOST, ctx, scrub), timeout]);
      if (outcome.timedOut) {
        return send(res, 200, {
          schema: "redact-secret-adapters/testbed-result-v1",
          scenarioId: def.id,
          host: HOST,
          classification: def.classification,
          title: def.title,
          status: "error",
          startedAt: new Date().toISOString(),
          durationMs: SCENARIO_TIMEOUT_MS,
          assertions: [],
          evidence: {},
          error: { code: "timeout", message: `scenario exceeded ${SCENARIO_TIMEOUT_MS} ms` },
        });
      }
      return send(res, 200, outcome);
    } finally {
      busy = false;
    }
  }
  return send(res, 404, { error: "not found" });
});

const control = createServer((req, res) => {
  if (req.method === "POST" && req.url === "/reset") {
    captures.reset();
    return send(res, 200, { ok: true });
  }
  if (req.method === "GET" && req.url === "/captures") return send(res, 200, { entries: captures.snapshot() });
  return send(res, 404, { error: "not found" });
});

for (const server of [api, control]) {
  server.headersTimeout = 5000;
  server.requestTimeout = 10000;
  server.maxHeadersCount = 50;
}
api.listen(8080, "0.0.0.0");
control.listen(8081, "0.0.0.0");
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
console.log(`node consumer ready: ${scenarios.size} scenarios (mode ${installManifest.mode})`);
