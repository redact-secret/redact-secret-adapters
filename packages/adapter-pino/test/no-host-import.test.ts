/**
 * Guards the absolute constraint that a host package is never imported at
 * runtime: every `pino` import in `src/` must be `import type`, which
 * TypeScript erases, so the built output must not mention the module.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const dist = fileURLToPath(new URL("../dist/", import.meta.url));

test("the built package has no runtime import of pino", () => {
  const files = readdirSync(dist).filter((name) => name.endsWith(".js"));
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) {
    // Doc comments legitimately show `import pino from "pino"` in usage examples.
    const source = readFileSync(`${dist}${name}`, "utf-8").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(source, name).not.toMatch(/(from\s+|import\s*\(?\s*)["']pino["']/);
  }
});
