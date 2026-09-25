/**
 * The package is a thin specialization of `@redact-secret/adapter-ai-context`
 * (redact-secret-adapters#13): its manifest depends on nothing else, its
 * built output imports nothing else (no core, no shared walker, no MCP SDK),
 * and it contains no scan, walk, policy, or core-error mapping of its own.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(`${pkg}package.json`, "utf-8"));

function builtSources(): [string, string][] {
  const files = readdirSync(`${pkg}dist`).filter((name) => name.endsWith(".js"));
  expect(files.length).toBeGreaterThan(0);
  return files.map((name) => [name, readFileSync(`${pkg}dist/${name}`, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "")]);
}

test("the manifest depends on adapter-ai-context only; the core is a required peer and the SDKs optional peers", () => {
  expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@redact-secret/adapter-ai-context"]);
  expect(Object.keys(manifest.peerDependencies ?? {}).sort()).toEqual([
    "@modelcontextprotocol/client",
    "@modelcontextprotocol/sdk",
    "@modelcontextprotocol/server",
    "@redact-secret/core",
  ]);
  expect(manifest.peerDependenciesMeta).toEqual({
    "@modelcontextprotocol/client": { optional: true },
    "@modelcontextprotocol/sdk": { optional: true },
    "@modelcontextprotocol/server": { optional: true },
  });
  expect(manifest.optionalDependencies).toBeUndefined();
});

test("the built output imports only adapter-ai-context: no core, no shared walker, no MCP SDK", () => {
  for (const [name, source] of builtSources()) {
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      expect(
        specifier?.startsWith("./") || specifier === "@redact-secret/adapter-ai-context",
        `${name}: ${specifier}`,
      ).toBe(true);
    }
  }
});

test("no detection, walker, policy, or error-mapping logic: every scan goes through the AI-context boundary", () => {
  const boundary = builtSources().find(([name]) => name === "boundary.js")?.[1] ?? "";
  const members = new Set([...boundary.matchAll(/\bboundary\.(\w+)/g)].map((m) => m[1]));
  expect([...members].sort()).toEqual(["openStream", "sanitizeText", "sanitizeValue"]);
  for (const forbidden of [
    "scanAndRedact",
    "createIncrementalSanitizer",
    "walkStrict",
    "walkValue",
    "failureFrom",
    "LIMIT_EXCEEDED",
    "evaluate(",
  ]) {
    expect(boundary.includes(forbidden), forbidden).toBe(false);
  }
  const index = builtSources().find(([name]) => name === "index.js")?.[1] ?? "";
  expect(index).toMatch(/createAiContextBoundary\(/);
});
