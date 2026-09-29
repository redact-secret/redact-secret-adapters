/**
 * The workspace directory names under `packages/`.
 *
 * Every script here walks `packages/` to find the workspaces and then reads a
 * `package.json` out of each entry. A plain `readdirSync` also returns files,
 * and reading `package.json` "inside" one fails with `ENOTDIR` before the
 * script does any of its work. In practice the file is `.DS_Store`, which
 * macOS writes into any directory opened in Finder and which `.gitignore`
 * already ignores — so it never reaches a commit, and CI, running on a clean
 * Linux checkout, never sees it. That is exactly why it surfaces in the
 * documented local procedures in RELEASING.md instead.
 */

import { readdirSync } from "node:fs";

/**
 * @param {URL} packagesDir the `packages/` directory
 * @returns {string[]} directory names only, in `readdir` order
 */
export function workspaceDirs(packagesDir) {
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}
