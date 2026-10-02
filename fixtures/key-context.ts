import { readFileSync } from "node:fs";

export interface KeyContextCase {
  readonly id: string;
  readonly key: string;
  readonly value: string;
  /** What the real core makes of the leaf in its key-context view; `null` leaves it unchanged. */
  readonly masked: string | null;
}

/** The synthetic key/value pairs every adapter's key-context test replays. */
export function loadKeyContextCases(): KeyContextCase[] {
  const url = new URL("./key-context-cases.json", import.meta.url);
  return (JSON.parse(readFileSync(url, "utf-8")) as { cases: KeyContextCase[] }).cases;
}

/** The expected masked leaf for a case: the core's answer, or the unchanged value. */
export function expectedLeaf(testCase: KeyContextCase): string {
  return testCase.masked ?? testCase.value;
}
