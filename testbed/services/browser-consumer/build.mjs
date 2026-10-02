/**
 * Build-time packaging probe for the browser consumer (#195). Bundles the
 * installed packages for a browser with esbuild and decides, from facts only,
 * whether the packaging supports a browser consumer. A failure here does NOT
 * fail the image build: it is recorded as `blocked-by-packaging` with a fixed
 * code in status.json, so the report can say so explicitly, and no server
 * request is ever substituted for the browser lane.
 */

import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "esbuild";

const ROOT = process.env.TESTBED_CONSUMER ?? "/opt/consumer";
const PUBLIC = join(ROOT, "public");
const sha = (file) => createHash("sha256").update(readFileSync(file)).digest("hex");
const esbuildVersion = JSON.parse(readFileSync(join(ROOT, "node_modules", "esbuild", "package.json"), "utf-8")).version;

mkdirSync(PUBLIC, { recursive: true });
const status = {
  schema: "redact-secret-adapters/testbed-browser-packaging-v1",
  packaging: "blocked-by-packaging",
  code: null,
  bundler: { name: "esbuild", version: esbuildVersion, platform: "browser", format: "esm" },
  bundle: null,
  assets: [],
};

function done(code) {
  if (code) status.code = code;
  else status.packaging = "supported";
  writeFileSync(join(ROOT, "status.json"), `${JSON.stringify(status, null, 2)}\n`);
  console.log(`browser packaging: ${status.packaging}${code ? ` (${code})` : ""}`);
  process.exit(0);
}

try {
  await build({
    entryPoints: [join(ROOT, "app", "consumer.mjs")],
    bundle: true,
    platform: "browser",
    format: "esm",
    outfile: join(PUBLIC, "bundle.mjs"),
    logLevel: "warning",
  });
} catch (err) {
  console.error(
    `bundle failed: ${String(err?.message ?? err)
      .split("\n")[0]
      .slice(0, 200)}`,
  );
  done("bundle-failed");
}

const bundle = readFileSync(join(PUBLIC, "bundle.mjs"), "utf-8");
status.bundle = {
  file: "bundle.mjs",
  bytes: statSync(join(PUBLIC, "bundle.mjs")).size,
  sha256: sha(join(PUBLIC, "bundle.mjs")),
};
for (const forbidden of ["node:", "require(", '.node"', "@redact-secret/node-"]) {
  if (bundle.includes(forbidden)) done("bundle-names-node-builtin-or-addon");
}
if (!/redact_secret_wasm/.test(bundle)) done("no-wasm-glue-in-bundle");

// The assets an application's pipeline serves beside the bundle: the core's .wasm files.
const wasmDir = join(ROOT, "node_modules", "@redact-secret", "wasm");
let names = [];
try {
  names = readdirSync(wasmDir).filter((f) => f.endsWith(".wasm"));
} catch {
  done("wasm-package-missing");
}
if (names.length === 0) done("no-wasm-assets");
for (const name of names) {
  copyFileSync(join(wasmDir, name), join(PUBLIC, name));
  status.assets.push({ name, bytes: statSync(join(PUBLIC, name)).size, sha256: sha(join(PUBLIC, name)) });
}
done(null);
