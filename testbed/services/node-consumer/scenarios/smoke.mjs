/**
 * Smoke scenarios for the Node consumer (#192/#193): the installed artifacts
 * are the ones the install manifest promises, they load from outside any
 * workspace, and the real core is active. They assert nothing about logging
 * or AI-context behavior; #194 and #195 add that in their own modules.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const SYNTHETIC_TOKEN = `ghp_SYNTHETICREVOKED${"0".repeat(20)}`;
const CODE_MARKERS = ["__control", "testbed"];
const PATH_MARKERS = ["__control", "testbed", "fixtures"];
const CODE_FILE = /\.(?:c?js|mjs|ts|json)$/;
const EXPECTED_EXPORTS = {
  "@redact-secret/adapter": ["createMaskSecrets"],
  "@redact-secret/adapter-pino": ["createRedactingHooks"],
  "@redact-secret/adapter-ai-context": ["createAiContextBoundary"],
};

function installedAdapters(ctx) {
  return ctx.install.adapters.map((a) => a.name);
}

function walk(dir, out = [], budget = { files: 2000 }) {
  for (const name of readdirSync(dir)) {
    if (budget.files-- <= 0) return out;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out, budget);
    else out.push(full);
  }
  return out;
}

export const scenarios = [
  {
    id: "smoke.node-public-imports",
    title: "Installed adapters load through their public entry points",
    classification: "install-check",
    async run(ctx, rec) {
      for (const name of installedAdapters(ctx)) {
        let mod;
        try {
          mod = await import(name);
        } catch (err) {
          rec.check(`import ${name}`, false, `import failed: ${err?.code ?? err?.name}`);
          continue;
        }
        rec.check(`import ${name}`, true);
        for (const symbol of EXPECTED_EXPORTS[name] ?? []) {
          rec.check(`${name} exports ${symbol}`, typeof mod[symbol] === "function");
        }
      }
      rec.evidence.adapters = ctx.install.adapters.map((a) => ({ name: a.name, version: a.version }));
    },
  },
  {
    id: "smoke.node-install-isolation",
    title: "Adapters resolve from the clean install, not a workspace, and ship no control or fixture code",
    classification: "install-check",
    async run(ctx, rec) {
      const root = realpathSync(join(ctx.appDir, "node_modules"));
      rec.check("NODE_PATH is unset", process.env.NODE_PATH === undefined);
      for (const name of installedAdapters(ctx)) {
        const entry = fileURLToPath(import.meta.resolve(name));
        const real = realpathSync(entry);
        rec.check(`${name} resolves inside the install`, real.startsWith(root + sep), "path outside install");
        rec.check(`${name} is not a symlink to a workspace`, real === entry, "resolved path differs from realpath");
        const pkgDir = join(root, name);
        const markers = [];
        for (const file of walk(pkgDir)) {
          const rel = file.slice(pkgDir.length);
          for (const marker of PATH_MARKERS) if (rel.includes(marker)) markers.push(marker);
          if (!CODE_FILE.test(file) || file.endsWith("package.json")) continue;
          const text = readFileSync(file, "utf-8");
          for (const marker of CODE_MARKERS) if (text.includes(marker)) markers.push(marker);
        }
        rec.check(`${name} contains no control or fixture code`, markers.length === 0, [...new Set(markers)].join(","));
      }
      rec.evidence.installRoot = root;
    },
  },
  {
    id: "smoke.node-core-active",
    title: "The real core is loaded and masks a synthetic token; the runtime artifact is reported",
    classification: "install-check",
    async run(ctx, rec) {
      const core = await import("@redact-secret/core");
      const { createAiContextBoundary } = await import("@redact-secret/adapter-ai-context");
      const boundary = await createAiContextBoundary(); // initializes the core
      const artifact = typeof core.artifact === "function" ? core.artifact() : null;
      rec.evidence.core = ctx.install.core;
      rec.evidence.artifact = artifact;
      rec.check("core exposes its runtime artifact", artifact !== null);
      const out = boundary.sanitizeText(`deploy ${SYNTHETIC_TOKEN}`);
      const text = typeof out === "string" ? out : JSON.stringify(out);
      rec.check("the synthetic token does not survive", !text.includes(SYNTHETIC_TOKEN));
      rec.check(
        "something was redacted",
        text.includes("<SECRET_") || text.includes("[REDACTED"),
        "no redaction marker",
      );
    },
  },
];
