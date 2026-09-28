/**
 * `workspaceDirs` (scripts/workspace-dirs.mjs): the guard that keeps a stray
 * file beside the workspaces from crashing every script that walks
 * `packages/`.
 *
 * The file that actually happens is `.DS_Store`, which macOS writes into any
 * directory opened in Finder. `.gitignore` ignores it, so it never reaches a
 * commit and CI — a clean Linux checkout — never sees one. That is why this
 * only ever broke the documented local procedures in RELEASING.md, and why
 * the regression has to be pinned here rather than left to CI.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { expect, test } from "vitest";

import { workspaceDirs } from "../workspace-dirs.mjs";

/** A `packages/`-shaped directory, plus whatever stray files a case needs. */
function packagesDir(dirs, files = []) {
  const root = mkdtempSync(join(tmpdir(), "workspace-dirs-"));
  for (const dir of dirs) mkdirSync(join(root, dir));
  for (const file of files) writeFileSync(join(root, file), "");
  return pathToFileURL(`${root}/`);
}

test("returns every workspace directory", () => {
  const dir = packagesDir(["adapter", "adapter-pino", "adapter-otel"]);
  expect(workspaceDirs(dir).sort()).toEqual(["adapter", "adapter-otel", "adapter-pino"]);
});

test("skips a stray .DS_Store instead of reading a package.json inside it", () => {
  const dir = packagesDir(["adapter", "adapter-pino"], [".DS_Store"]);
  expect(workspaceDirs(dir).sort()).toEqual(["adapter", "adapter-pino"]);
});

test("skips any stray file, not just the one that prompted this", () => {
  const dir = packagesDir(["adapter"], [".DS_Store", "README.md", "Thumbs.db", ".keep"]);
  expect(workspaceDirs(dir)).toEqual(["adapter"]);
});

test("an empty directory yields no workspaces rather than throwing", () => {
  expect(workspaceDirs(packagesDir([]))).toEqual([]);
});
