import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface FixtureCase {
  readonly name: string;
  readonly input: unknown;
  readonly expected: unknown;
}

/** Reads one shared, cross-language case file from the root `fixtures/`. */
export function loadCases(fileName: string): readonly FixtureCase[] {
  const path = fileURLToPath(new URL(`../../../fixtures/${fileName}`, import.meta.url));
  return (JSON.parse(readFileSync(path, "utf-8")) as { cases: FixtureCase[] }).cases;
}
