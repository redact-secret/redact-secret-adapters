/**
 * Scenario UI service (#192): a minimal shell, not the Console product. It
 * serves one static page and a fixed, read-and-run API over the two consumer
 * services. It accepts no input except a scenario ID taken from the fixed
 * registry, has no upload, and can only reach the consumers named in
 * CONSUMERS (set in compose.yaml), never a user-supplied target. It never
 * proxies the consumers' control API.
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";

const CONSUMERS = Object.fromEntries(
  (process.env.CONSUMERS ?? "")
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split("=")),
);
const ID = /^(smoke|pino|pylog|aictx|browser|ui)\.[a-z0-9]+(-[a-z0-9]+)*$/;
const index = readFileSync(new URL("./public/index.html", import.meta.url));
const FETCH_TIMEOUT_MS = 25000;

if (process.env.TESTBED_FAULT === "ui-startup-failure") process.exit(1);

async function consumer(host, path, method = "GET") {
  const res = await fetch(`${CONSUMERS[host]}${path}`, { method, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return { status: res.status, body: await res.json() };
}

async function listScenarios() {
  const scenarios = [];
  for (const host of Object.keys(CONSUMERS)) {
    const { body } = await consumer(host, "/scenarios");
    for (const s of body.scenarios) scenarios.push({ ...s, host });
  }
  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && url.pathname === "/") return send(res, 200, index, "text/html; charset=utf-8");
    if (req.method === "GET" && url.pathname === "/api/scenarios") {
      return send(res, 200, {
        schema: "redact-secret-adapters/testbed-scenarios-v1",
        scenarios: await listScenarios(),
      });
    }
    if (req.method === "GET" && url.pathname === "/api/provenance") {
      const out = {};
      for (const host of Object.keys(CONSUMERS)) out[host] = (await consumer(host, "/provenance")).body;
      return send(res, 200, out);
    }
    const m = /^\/api\/run\/([a-z0-9.-]{1,80})$/.exec(url.pathname);
    if (req.method === "POST" && m && ID.test(m[1])) {
      const known = (await listScenarios()).find((s) => s.id === m[1]);
      if (!known) return send(res, 404, { error: "unknown scenario" });
      const { body } = await consumer(known.host, `/run/${m[1]}`, "POST");
      return send(res, 200, body);
    }
    return send(res, 404, { error: "not found" });
  } catch {
    return send(res, 502, { error: "consumer unavailable" });
  }
});
server.headersTimeout = 5000;
server.requestTimeout = 60000;
server.listen(8080, "0.0.0.0");
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
console.log(`ui ready: consumers ${Object.keys(CONSUMERS).join(",")}`);
