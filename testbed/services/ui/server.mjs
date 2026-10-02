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
const FETCH_TIMEOUT_MS = 25000;
const FAULT = process.env.TESTBED_FAULT ?? "";
const BROWSER = process.env.BROWSER_CONSUMER ?? "";
const STATIC = new Map(
  [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/app.css", "app.css", "text/css; charset=utf-8"],
  ].map(([path, file, type]) => [path, { type, body: readFileSync(new URL(`./public/${file}`, import.meta.url)) }]),
);
// SemVer (npm) or PEP 440 (Python, e.g. 0.1.0b12).
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,39}$/;
const coreVersion = (p) => {
  const v = p.core?.version ?? p.core?.["redact-secret"];
  return typeof v === "string" && VERSION.test(v) ? v : null;
};
const NAME = /^(@[a-z0-9-]+\/)?[a-z0-9._-]{1,60}$/;

if (FAULT === "ui-startup-failure") process.exit(1);

async function consumer(host, path, method = "GET") {
  const res = await fetch(`${CONSUMERS[host]}${path}`, { method, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  return { status: res.status, body: await res.json() };
}

/**
 * The one scenario this service owns (#196): a fixed envelope whose strings are hostile markup. The
 * page must render every one of them as text. It has no input, it is the same on every call, and
 * nothing here is a real secret.
 */
const HOSTILE = [
  '<img src=x onerror="window.__xss=1">',
  "<script>window.__xss=1</script>",
  '"><svg onload="window.__xss=1">',
  "javascript:window.__xss=1",
  '<a href="javascript:window.__xss=1">click</a>',
];
const FIXTURE_ID = "ui.hostile-strings-fixture";
const FIXTURE_TITLE = "Fixed hostile-string fixture: the page must show these as text and execute nothing";
function fixtureResult() {
  return {
    schema: "redact-secret-adapters/testbed-result-v1",
    scenarioId: FIXTURE_ID,
    host: "browser",
    classification: "negative-control",
    title: FIXTURE_TITLE,
    status: "pass",
    startedAt: "1970-01-01T00:00:00.000Z",
    durationMs: 0,
    assertions: HOSTILE.map((h) => ({ name: `rendered as text: ${h}`.slice(0, 120), ok: true })),
    evidence: {
      comparisons: HOSTILE.map((h) => ({ label: h, kind: "other", expected: h, actual: h, match: true })),
    },
  };
}

/** Self-test fault ui-wrong-response: an intentionally incorrect response, so the journeys must fail. */
function tamper(result) {
  if (FAULT !== "ui-wrong-response" || result.scenarioId === FIXTURE_ID) return result;
  const comparisons = result.evidence?.comparisons;
  if (Array.isArray(comparisons) && comparisons.length > 0)
    comparisons[0] = { ...comparisons[0], actual: "[tampered by fault]", match: true };
  return { ...result, status: "pass" };
}

function safeList(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => NAME.test(p?.name ?? "") && VERSION.test(p?.version ?? ""))
    .map((p) => ({ name: p.name, version: p.version }));
}

/** Environment facts the page shows, copied field by field from the consumers (no raw provenance, no hashes). */
async function environment() {
  const hosts = [];
  for (const host of Object.keys(CONSUMERS)) {
    const p = (await consumer(host, "/provenance")).body;
    hosts.push({
      host,
      mode: p.mode === "published" ? "published" : "candidate",
      runtime: String(p[host] ?? "").slice(0, 20),
      core: coreVersion(p),
      native: safeList(p.coreNative),
      adapters: safeList(p.adapters),
    });
  }
  if (BROWSER) {
    try {
      const status = await (await fetch(`${BROWSER}/status`, { signal: AbortSignal.timeout(5000) })).json();
      const p = await (await fetch(`${BROWSER}/provenance`, { signal: AbortSignal.timeout(5000) })).json();
      hosts.push({
        host: "browser",
        mode: p.mode === "published" ? "published" : "candidate",
        runtime:
          status.packaging === "supported" ? "Chromium via the browser consumer (esbuild bundle + WebAssembly)" : "",
        packaging: status.packaging === "supported" ? "supported" : "blocked-by-packaging",
        core: coreVersion(p),
        native: safeList(p.coreNative),
        adapters: safeList(p.adapters),
      });
    } catch {
      hosts.push({
        host: "browser",
        mode: "unknown",
        runtime: "",
        packaging: "unavailable",
        core: null,
        native: [],
        adapters: [],
      });
    }
  }
  return { faultMode: FAULT === "" ? "none" : FAULT, hosts };
}

async function listScenarios() {
  const scenarios = [];
  for (const host of Object.keys(CONSUMERS)) {
    const { body } = await consumer(host, "/scenarios");
    for (const s of body.scenarios) scenarios.push({ ...s, host });
  }
  scenarios.push({ id: FIXTURE_ID, title: FIXTURE_TITLE, classification: "negative-control", host: "browser" });
  return scenarios.sort((a, b) => a.id.localeCompare(b.id));
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    // Scripts and styles only from this origin: no inline script or style, so injected markup could not run anyway.
    "content-security-policy":
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  try {
    if (req.method === "GET" && url.pathname === "/healthz") return send(res, 200, { ok: true });
    if (req.method === "GET" && STATIC.has(url.pathname)) {
      const f = STATIC.get(url.pathname);
      return send(res, 200, f.body, f.type);
    }
    if (req.method === "GET" && url.pathname === "/api/environment") return send(res, 200, await environment());
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
      if (known.id === FIXTURE_ID) return send(res, 200, fixtureResult());
      const { status, body } = await consumer(known.host, `/run/${m[1]}`, "POST");
      if (status === 409) return send(res, 409, { error: "a scenario is already running" });
      if (status !== 200) return send(res, 502, { error: "consumer unavailable" });
      return send(res, 200, tamper(body));
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
