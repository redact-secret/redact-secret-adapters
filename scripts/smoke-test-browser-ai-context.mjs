#!/usr/bin/env node
/**
 * Browser-bundle qualification of `@redact-secret/adapter-ai-context`
 * (redact-secret/redact-secret-adapters#179), and of nothing else.
 *
 * The AI-context boundary (with `@redact-secret/adapter`, which it depends on)
 * imports nothing from Node, and `@redact-secret/core` selects its WebAssembly
 * build under the `browser` condition. This is the one package here that
 * intends a browser consumer, so it is the only one qualified. `adapter-pino`,
 * `adapter-otel-trace`, `adapter-otel-logs` and `adapter-mcp` are Node
 * integrations and are not bundled for a browser by this script or by any
 * claim in the documentation.
 *
 * What it does, from a clean install outside the checkout:
 *
 *   1. packs and installs `adapter` and `adapter-ai-context` tarballs with one
 *      pinned `@redact-secret/core` (no workspace symlinks);
 *   2. bundles a consumer with esbuild for `platform: "browser"` (an ES module
 *      bundle, the `browser` export condition, no Node built-ins allowed: a
 *      `node:` import fails the build);
 *   3. checks the bundle names no Node built-in and no native addon, copies the
 *      core's `.wasm` files beside it, as an application's asset pipeline does,
 *      and runs it with a `fetch` that serves `file:` URLs the way a browser
 *      serves them, asserting `artifact()` is "wasm" and the sanitized outputs
 *      for Unicode, key-aware values, an incremental stream split at every
 *      position, limits and block, with PII off and on (each its own process).
 *
 * What this does not show, and the docs say so: it runs the bundle on Node's
 * WebAssembly engine, not in a browser; it uses one bundler (esbuild); and it
 * does not exercise Cloudflare Workers, Deno, Bun or a framework's SSR build.
 *
 *   node scripts/smoke-test-browser-ai-context.mjs
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const manifestFor = (dir) => JSON.parse(readFileSync(join(repoRoot, "packages", dir, "package.json"), "utf-8"));

const NPM =
  typeof process.env.npm_execpath === "string" && process.env.npm_execpath.endsWith(".js")
    ? { file: process.execPath, prefix: [process.env.npm_execpath], shell: false }
    : { file: process.platform === "win32" ? "npm.cmd" : "npm", prefix: [], shell: process.platform === "win32" };

function npm(args, cwd, capture = false) {
  if (!capture) console.log(`+ npm ${args.join(" ")}`);
  return execFileSync(NPM.file, [...NPM.prefix, ...args], {
    cwd,
    encoding: "utf-8",
    shell: NPM.shell,
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
}

const CONSUMER = `import { artifact } from "@redact-secret/core";
import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";

const pii = globalThis.__PII === true ? ["pii:global"] : undefined;
const token = "ghp_SYNTHETICREVOKED" + "0".repeat(20);
const boundary = await createAiContextBoundary({
  wholeInputLimits: { maxInputBytes: 4096, maxFindings: 16 },
  incrementalLimits: { maxInputCodeUnits: 16384, maxBufferedCodeUnits: 2176, maxTokenCodeUnits: 1024, maxMultilineCodeUnits: 2048 },
  traversalLimits: { maxDepth: 4, maxNodes: 64 },
  ...(pii === undefined ? {} : { pii }),
});

const text = "progress 1\\nAPI_KEY=" + token + "\\n\\u{1F680} done\\n";
const splits = [];
for (let i = 0; i <= text.length; i += 1) {
  const stream = boundary.openStream({ boundary: "tool-result" });
  stream.append(text.slice(0, i));
  stream.append(text.slice(i));
  splits.push(stream.finalize());
}

globalThis.__RESULT = {
  artifact: artifact(),
  text: boundary.sanitizeText("토큰 " + token + " \\u{1F680} 끝"),
  keyAware: [
    boundary.sanitizeValue({ api_key: "synthetic-example-value-0001" }),
    boundary.sanitizeValue({ name: "synthetic-example-value-0001" }),
    boundary.sanitizeValue({ client_secret: "한국어-가짜-비밀번호-1234" }),
  ],
  email: boundary.sanitizeText("customer email: jane.doe@acme-corp.io please"),
  whole: boundary.sanitizeText(text),
  splits,
  limit: boundary.sanitizeText("ordinary text\\n".repeat(400)),
  blocked: boundary.sanitizeValue({ deep: { pem: "-----BEGIN PRIVATE KEY-----\\nU1lOVEhFVElDX1JFVk9LRURfQ09ORk9STUFOQ0U=\\n-----END PRIVATE KEY-----" } }),
};
`;

// Serves file: URLs to fetch() as a browser serves the same-origin asset, and runs the bundle.
const RUNNER = `import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
globalThis.__PII = process.env.PII === "1";
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (url.protocol !== "file:") return realFetch(input, init);
  return new Response(await readFile(fileURLToPath(url)), { headers: { "content-type": "application/wasm" } });
};
await import("./bundle.mjs");
process.stdout.write(JSON.stringify(globalThis.__RESULT) + "\\n");
`;

// esbuild's JS API, so the same script runs on every platform's binary.
const BUILD = `import { build } from "esbuild";
await build({
  entryPoints: ["consumer.mjs"],
  bundle: true,
  platform: "browser",
  format: "esm",
  outfile: "bundle.mjs",
  logLevel: "warning",
});
`;

function main() {
  const adapterManifest = manifestFor("adapter");
  const range = adapterManifest.peerDependencies["@redact-secret/core"];
  const coreVersion = [JSON.parse(npm(["view", `@redact-secret/core@${range}`, "version", "--json"], repoRoot, true))]
    .flat()
    .at(-1);
  const rootManifest = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf-8"));
  const esbuildVersion = rootManifest.devDependencies.esbuild;
  console.log(`identities: node ${process.versions.node}, core ${coreVersion}, esbuild ${esbuildVersion}`);

  const root = mkdtempSync(join(realpathSync(tmpdir()), "redact-secret-browser-"));
  const packsDir = join(root, "packs");
  const projectDir = join(root, "project");
  mkdirSync(packsDir);
  mkdirSync(projectDir);
  let ok = false;
  try {
    const tarballs = {};
    for (const dir of ["adapter", "adapter-ai-context"]) {
      const out = JSON.parse(
        npm(["pack", "--json", "--workspace", manifestFor(dir).name, "--pack-destination", packsDir], repoRoot, true),
      );
      tarballs[dir] = join(packsDir, out[0].filename);
    }
    writeFileSync(
      join(projectDir, "package.json"),
      JSON.stringify({ name: "redact-secret-adapters-browser-smoke", private: true, type: "module" }, null, 2),
    );
    npm(["install", tarballs.adapter], projectDir);
    npm(
      ["install", tarballs["adapter-ai-context"], `@redact-secret/core@${coreVersion}`, `esbuild@${esbuildVersion}`],
      projectDir,
    );

    writeFileSync(join(projectDir, "consumer.mjs"), CONSUMER);
    writeFileSync(join(projectDir, "runner.mjs"), RUNNER);
    writeFileSync(join(projectDir, "build.mjs"), BUILD);
    console.log("+ node build.mjs  (esbuild, platform browser, format esm)");
    execFileSync(process.execPath, ["build.mjs"], { cwd: projectDir, stdio: "inherit" });

    const bundle = readFileSync(join(projectDir, "bundle.mjs"), "utf-8");
    for (const forbidden of ["node:", "require(", '.node"', "@redact-secret/node-"]) {
      if (bundle.includes(forbidden)) throw new Error(`the browser bundle mentions ${JSON.stringify(forbidden)}`);
    }
    if (!/redact_secret_wasm/.test(bundle)) throw new Error("the browser bundle does not contain the WebAssembly glue");

    const wasmDir = join(projectDir, "node_modules", "@redact-secret", "wasm");
    for (const name of ["redact_secret_wasm_bg.wasm", "redact_secret_wasm_pii_bg.wasm"]) {
      copyFileSync(join(wasmDir, name), join(projectDir, name));
    }

    const results = {};
    for (const pii of ["0", "1"]) {
      console.log(`+ node runner.mjs  (PII=${pii})`);
      const printed = execFileSync(process.execPath, ["runner.mjs"], {
        cwd: projectDir,
        encoding: "utf-8",
        env: { ...process.env, PII: pii },
        stdio: ["ignore", "pipe", "inherit"],
        maxBuffer: 64 * 1024 * 1024,
      });
      if (printed.includes("SYNTHETICREVOKED")) throw new Error("a synthetic token reached the output in plaintext");
      results[pii] = JSON.parse(printed.trim().split("\n").at(-1));
      assertResult(pii, results[pii]);
    }
    console.log(
      "\nbrowser bundle smoke passed: adapter-ai-context runs on the core's WebAssembly artifact from a bundled clean install.",
    );
    ok = true;
  } finally {
    if (ok) rmSync(root, { recursive: true, force: true });
    else console.error(`\nbrowser bundle smoke failed: throwaway project left at ${root} for inspection`);
  }
}

function assertResult(pii, r) {
  const fail = (what) => {
    throw new Error(`PII=${pii}: ${what}: ${JSON.stringify(r).slice(0, 400)}`);
  };
  if (r.artifact !== "wasm") fail(`artifact() reported ${r.artifact}`);
  if (r.text.outcome !== "ok" || !/^토큰 <SECRET_\d+> \u{1F680} 끝$/u.test(r.text.value))
    fail("Unicode text not redacted");
  const [apiKey, benign, korean] = r.keyAware;
  if (
    apiKey.value?.api_key !== "<SECRET_1>" ||
    benign.value?.name !== "synthetic-example-value-0001" ||
    korean.value?.client_secret !== "<SECRET_1>"
  ) {
    fail("key-aware values");
  }
  const exposed = JSON.stringify(r.email).includes("jane.doe@acme-corp.io");
  if (pii === "0" && !exposed) fail("PII off changed the address");
  if (pii === "1" && exposed) fail("PII on did not redact the address");
  if (r.whole.outcome !== "ok" || !r.whole.value.includes("API_KEY=<SECRET_1>")) fail("whole-input redaction");
  r.splits.forEach((outcome, i) => {
    // A split inside the emoji's surrogate pair is the one boundary the core refuses.
    const refused = outcome.outcome === "blocked" && outcome.code === "UNPAIRED_SURROGATE";
    if (JSON.stringify(outcome) !== JSON.stringify(r.whole) && !refused) fail(`split ${i} differs from whole-input`);
  });
  if (r.splits.filter((o) => o.outcome === "blocked").length !== 1)
    fail("expected exactly one refused (surrogate) split");
  if (r.limit.reason !== "limit_exceeded") fail("limit");
  if (r.blocked.outcome !== "blocked") fail("block");
}

main();
