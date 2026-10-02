#!/usr/bin/env node
/**
 * Clean-tarball smoke test on one platform, and the Node WASM-fallback
 * parity check (redact-secret/redact-secret-adapters#179).
 *
 *   node scripts/smoke-test-platform.mjs [addon|wasm|parity]   (default: addon)
 *
 * It packs the Node packages (`adapter`, `adapter-pino`, `adapter-otel-trace`,
 * `adapter-otel-logs`, `adapter-ai-context`, `adapter-mcp`), installs the
 * tarballs into a throwaway project OUTSIDE the checkout with their real hosts
 * (pino, `@opentelemetry/sdk-trace-base`, `@opentelemetry/sdk-logs`) and one
 * pinned `@redact-secret/core`, and runs `scripts/platform-probe.mjs` there
 * against every public factory, so a wrong `exports` entry, a missing `dist`
 * file or a workspace symlink papering over either fails here. It deliberately
 * does not repeat `npm run smoke-test` (README examples, typechecking) or the
 * core's own native-artifact matrix; it is the small set that has to hold on
 * each platform.
 *
 * Lanes. The core loads its native addon when it can and falls back to a
 * WebAssembly artifact when it cannot, and `artifact()` reports which. The
 * lanes are:
 *
 *   addon   a normal install. `artifact()` MUST be "addon". On a platform with
 *           no addon this fails rather than quietly testing the fallback.
 *   wasm    the same install with `omit=optional` in the project's `.npmrc`.
 *           That is a supported, documented way to end up on the fallback (the
 *           core's README: "a failed optional-dependency install"): npm leaves
 *           out the platform addon packages, `initialize()` falls back, and
 *           `artifact()` MUST be "wasm". No private core hook is touched and
 *           nothing in a public API changes for this lane.
 *   parity  both lanes, then the sanitized outputs are compared document for
 *           document, with PII off and with PII on (each its own process,
 *           because the core's PII selection is one-shot and process-wide).
 *
 * Every lane asserts the artifact it actually got, so an intended WASM lane
 * cannot silently run the addon, and the output records the core, host and
 * runtime identities it ran against.
 *
 * Synthetic values only.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] ?? "addon";
if (!["addon", "wasm", "parity"].includes(mode)) {
  console.error("usage: smoke-test-platform.mjs [addon|wasm|parity]");
  process.exit(2);
}
const lanes = mode === "parity" ? ["addon", "wasm"] : [mode];

const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const scriptsDir = fileURLToPath(new URL(".", import.meta.url));
const manifestFor = (dir) => JSON.parse(readFileSync(join(repoRoot, "packages", dir, "package.json"), "utf-8"));

// `npm run` sets npm_execpath to npm-cli.js, which runs the same way on every
// platform without a shell; otherwise fall back to the `npm` on PATH.
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

function resolveHighest(name, range) {
  const versions = [JSON.parse(npm(["view", `${name}@${range}`, "version", "--json"], repoRoot, true))].flat();
  return versions.at(-1);
}

const PACKAGES = [
  "adapter",
  "adapter-pino",
  "adapter-otel-trace",
  "adapter-otel-logs",
  "adapter-ai-context",
  "adapter-mcp",
];

function main() {
  const adapterManifest = manifestFor("adapter");
  const hosts = {
    pino: manifestFor("adapter-pino").peerDependencies.pino,
    "@opentelemetry/sdk-trace-base":
      manifestFor("adapter-otel-trace").peerDependencies["@opentelemetry/sdk-trace-base"],
    "@opentelemetry/sdk-logs": manifestFor("adapter-otel-logs").peerDependencies["@opentelemetry/sdk-logs"],
  };
  const pinned = Object.fromEntries(Object.entries(hosts).map(([name, range]) => [name, resolveHighest(name, range)]));
  const coreVersion = resolveHighest("@redact-secret/core", adapterManifest.peerDependencies["@redact-secret/core"]);
  console.log(
    `identities: node ${process.versions.node} ${process.platform}-${process.arch}, core ${coreVersion}, hosts ${JSON.stringify(pinned)}`,
  );

  const root = mkdtempSync(join(realpathSync(tmpdir()), "redact-secret-platform-"));
  const packsDir = join(root, "packs");
  mkdirSync(packsDir);
  let ok = false;
  try {
    const tarballs = {};
    for (const dir of PACKAGES) {
      const out = JSON.parse(
        npm(["pack", "--json", "--workspace", manifestFor(dir).name, "--pack-destination", packsDir], repoRoot, true),
      );
      tarballs[dir] = join(packsDir, out[0].filename);
    }

    const documents = {};
    for (const lane of lanes) {
      const projectDir = join(root, `project-${lane}`);
      mkdirSync(projectDir);
      writeFileSync(
        join(projectDir, "package.json"),
        JSON.stringify({ name: `redact-secret-adapters-${lane}-smoke`, private: true, type: "module" }, null, 2),
      );
      // The lane's whole difference: leave the platform addon packages out.
      if (lane === "wasm") writeFileSync(join(projectDir, ".npmrc"), "omit=optional\n");

      // The sibling first, so npm never resolves it from the registry.
      npm(["install", tarballs.adapter], projectDir);
      npm(
        [
          "install",
          ...PACKAGES.filter((dir) => dir !== "adapter").map((dir) => tarballs[dir]),
          `@redact-secret/core@${coreVersion}`,
          ...Object.entries(pinned).map(([name, version]) => `${name}@${version}`),
        ],
        projectDir,
      );

      const scopeDir = join(projectDir, "node_modules", "@redact-secret");
      const addonPackages = readdirSync(scopeDir).filter((name) => name.startsWith("node-"));
      if (lane === "wasm" && addonPackages.length > 0) {
        throw new Error(`wasm lane: a native addon package was installed (${addonPackages.join(", ")})`);
      }
      if (lane === "addon" && addonPackages.length === 0) {
        throw new Error(`addon lane: no native addon package for ${process.platform}-${process.arch} was installed`);
      }
      const installedCore = JSON.parse(readFileSync(join(scopeDir, "core", "package.json"), "utf-8")).version;
      if (installedCore !== coreVersion) throw new Error(`expected core ${coreVersion}, installed ${installedCore}`);

      copyFileSync(join(scriptsDir, "platform-probe.mjs"), join(projectDir, "probe.mjs"));
      copyFileSync(join(repoRoot, "fixtures", "key-context-cases.json"), join(projectDir, "key-context-cases.json"));

      for (const pii of ["0", "1"]) {
        console.log(`+ node probe.mjs  (lane ${lane}, PII=${pii})`);
        const printed = execFileSync(process.execPath, ["probe.mjs"], {
          cwd: projectDir,
          encoding: "utf-8",
          env: { ...process.env, PII: pii },
          stdio: ["ignore", "pipe", "inherit"],
          maxBuffer: 64 * 1024 * 1024,
        });
        const document = JSON.parse(printed.trim().split("\n").at(-1));
        assertDocument(lane, pii, document, printed);
        documents[lane] = { ...documents[lane], [pii]: document };
        console.log(`  artifact() = ${document.artifact}, ${document.incremental.length} incremental splits ok`);
      }
    }

    if (mode === "parity") {
      for (const pii of ["0", "1"]) {
        const { artifact: _a, ...addon } = documents.addon[pii];
        const { artifact: _w, ...wasm } = documents.wasm[pii];
        for (const key of Object.keys(addon)) {
          if (JSON.stringify(addon[key]) !== JSON.stringify(wasm[key])) {
            throw new Error(
              `addon and wasm differ for ${key} (PII=${pii}): ${JSON.stringify(addon[key]).slice(0, 300)} vs ${JSON.stringify(wasm[key]).slice(0, 300)}`,
            );
          }
        }
        console.log(`addon and wasm agree on every case (PII=${pii}, ${Object.keys(addon).length} sections)`);
      }
    }
    console.log(
      `\nplatform smoke passed (${mode}) on ${process.platform}-${process.arch}, node ${process.versions.node}.`,
    );
    ok = true;
  } finally {
    if (ok) rmSync(root, { recursive: true, force: true });
    else console.error(`\nplatform smoke failed: throwaway projects left at ${root} for inspection`);
  }
}

/** What every lane must show, whatever the artifact. */
function assertDocument(lane, pii, document, printed) {
  const expected = lane === "wasm" ? "wasm" : "addon";
  if (document.artifact !== expected) {
    throw new Error(`${lane} lane: core.artifact() reported "${document.artifact}", expected "${expected}"`);
  }
  if (printed.includes("SYNTHETICREVOKED"))
    throw new Error(`${lane}: a synthetic token reached an output in plaintext`);
  const first = document.unicode[0];
  if (first?.outcome !== "ok" || !first.value.startsWith("토큰 <SECRET_")) {
    throw new Error(`${lane}: the Korean token case was not redacted: ${JSON.stringify(first)}`);
  }
  const email = document.unicode[7];
  const exposed = JSON.stringify(email).includes("jane.doe@acme-corp.io");
  if (pii === "0" && !exposed) throw new Error(`${lane}: PII is off but the email address was changed`);
  if (pii === "1" && exposed) throw new Error(`${lane}: PII is on but the email address was not redacted`);
  if (document.block[0]?.outcome !== "blocked" || document.limits[0]?.reason !== "limit_exceeded") {
    throw new Error(`${lane}: block or limit behavior is not what the boundary documents`);
  }
  // Every split of the stream must give the whole-input answer, except a split inside a
  // surrogate pair, which the core refuses with a fixed code.
  document.incremental.forEach((outcome, split) => {
    const inside = document.surrogateSplits.includes(split);
    const want = inside
      ? { outcome: "blocked", reason: "core_error", code: "UNPAIRED_SURROGATE" }
      : document.incrementalWhole;
    if (JSON.stringify(outcome) !== JSON.stringify(want)) {
      throw new Error(`${lane}: the split at ${split} gave ${JSON.stringify(outcome).slice(0, 200)}`);
    }
  });
}

main();
