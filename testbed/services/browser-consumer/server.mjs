/**
 * Static server for the browser consumer (#195): serves the bundle, the core's
 * .wasm assets and one page from fixed allowlisted paths, plus GET /status and
 * GET /provenance. No request body is read, no path is evaluated against the
 * file system (only names recorded at build time are served), no URL is fetched.
 * Same-origin only: the CSP forbids every other origin, and WebAssembly needs
 * 'wasm-unsafe-eval' (recorded here, as an application would have to allow it).
 */

import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const ROOT = new URL(".", import.meta.url).pathname;
const status = JSON.parse(readFileSync(join(ROOT, "status.json"), "utf-8"));
const install = JSON.parse(readFileSync(join(ROOT, "install-manifest.json"), "utf-8"));
const page = readFileSync(join(ROOT, "public", "index.html"));
const files = new Map();
if (status.packaging === "supported") {
  files.set("/bundle.mjs", {
    type: "text/javascript; charset=utf-8",
    body: readFileSync(join(ROOT, "public", "bundle.mjs")),
  });
  for (const a of status.assets)
    files.set(`/${a.name}`, { type: "application/wasm", body: readFileSync(join(ROOT, "public", a.name)) });
}
if (process.env.TESTBED_FAULT === "startup-failure") process.exit(1);

function send(res, code, body, type = "application/json") {
  res.writeHead(code, {
    "content-type": type,
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
    "content-security-policy":
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; base-uri 'none'; form-action 'none'",
  });
  res.end(type === "application/json" ? JSON.stringify(body) : body);
}

createServer((req, res) => {
  const path = new URL(req.url ?? "/", "http://localhost").pathname;
  if (req.method !== "GET") return send(res, 405, { error: "method not allowed" });
  if (path === "/healthz") return send(res, 200, { ok: true, host: "browser", packaging: status.packaging });
  if (path === "/status") return send(res, 200, status);
  if (path === "/provenance") return send(res, 200, { ...install, host: "browser", packaging: status });
  if (path === "/") return send(res, 200, page, "text/html; charset=utf-8");
  const f = files.get(path);
  if (f) return send(res, 200, f.body, f.type);
  return send(res, 404, { error: "not found" });
}).listen(8080, "0.0.0.0");
for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, () => process.exit(0));
console.log(`browser consumer ready: packaging ${status.packaging}`);
