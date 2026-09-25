/**
 * The package depends only on documented core APIs and the shared adapter
 * primitive: its manifest names nothing else, its built output imports
 * nothing else, the core is loaded only on call (a dynamic `import()`), and
 * the only core members it reads are the ones the AI-context contract
 * documents.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const pkg = fileURLToPath(new URL("../", import.meta.url));
const manifest = JSON.parse(readFileSync(`${pkg}package.json`, "utf-8"));

function builtSources(): [string, string][] {
  const files = readdirSync(`${pkg}dist`).filter((name) => name.endsWith(".js"));
  expect(files.length).toBeGreaterThan(0);
  // Doc comments legitimately show imports in usage examples.
  return files.map((name) => [name, readFileSync(`${pkg}dist/${name}`, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "")]);
}

test("the manifest depends on the shared adapter and peers on the core, nothing else", () => {
  expect(Object.keys(manifest.dependencies ?? {})).toEqual(["@redact-secret/adapter"]);
  expect(Object.keys(manifest.peerDependencies ?? {})).toEqual(["@redact-secret/core"]);
  expect(manifest.optionalDependencies).toBeUndefined();
});

test("the built output imports only the shared adapter statically, and the core only on call", () => {
  for (const [name, source] of builtSources()) {
    const specifiers = [...source.matchAll(/(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g)].map((m) => m[1]);
    for (const specifier of specifiers) {
      expect(
        specifier?.startsWith("./") || specifier === "@redact-secret/adapter" || specifier === "@redact-secret/core",
        `${name}: ${specifier}`,
      ).toBe(true);
    }
    expect(source, name).not.toMatch(/from\s+["']@redact-secret\/core["']/);
  }
});

test("the only core members read are initialize, scanAndRedact and createIncrementalSanitizer", () => {
  const index = builtSources().find(([name]) => name === "index.js")?.[1] ?? "";
  expect(index).toMatch(/import\(["']@redact-secret\/core["']\)/);
  const boundary = builtSources().find(([name]) => name === "boundary.js")?.[1] ?? "";
  const coreMembers = new Set([...boundary.matchAll(/\bcore\.(\w+)/g)].map((m) => m[1]));
  expect([...coreMembers].sort()).toEqual(["createIncrementalSanitizer", "scanAndRedact"]);
  const loadedMembers = new Set([...index.matchAll(/\bloaded\.(\w+)/g)].map((m) => m[1]));
  expect([...loadedMembers].sort()).toEqual(["initialize"]);
});
