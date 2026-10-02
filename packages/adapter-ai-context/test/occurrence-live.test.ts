/**
 * Occurrence provenance on the real core (redact-secret-adapters#177): emoji
 * and Korean text, repeated strings, key-aware offset mapping and absolute
 * incremental offsets. CI runs this at both ends of the declared core range.
 * Tokens are synthetic and built at runtime.
 */

import { beforeAll, expect, test } from "vitest";

import {
  type AiContextBoundary,
  createAiContextBoundary,
  type FindingOccurrence,
  findingOccurrences,
  type SafeFinding,
} from "../src/index.js";

const TOKEN = `ghp_${"x".repeat(36)}`;
const KEYED = "synthetic-example-value-0001";
const OPTIONS = {
  wholeInputLimits: { maxInputBytes: 65_536, maxFindings: 256 },
  incrementalLimits: {
    maxInputCodeUnits: 65_536,
    maxBufferedCodeUnits: 8192,
    maxTokenCodeUnits: 1024,
    maxMultilineCodeUnits: 2048,
  },
  traversalLimits: { maxDepth: 8, maxNodes: 256 },
};

let boundary: AiContextBoundary;
const events: { finding: SafeFinding; occurrence: FindingOccurrence }[] = [];

beforeAll(async () => {
  boundary = await createAiContextBoundary({
    ...OPTIONS,
    onFinding: (finding, _context, occurrence) => events.push({ finding, occurrence }),
  });
});

function found(outcome: { outcome: string }) {
  if (outcome.outcome !== "ok") throw new Error(`expected ok, got ${outcome.outcome}`);
  const ok = outcome as unknown as { value: unknown; findings: readonly SafeFinding[] };
  return { ...ok, occurrences: findingOccurrences(outcome) as readonly FindingOccurrence[] };
}

test("leaf offsets are UTF-16 units of the leaf: emoji and Korean before the secret", () => {
  for (const prefix of ["😀 ", "한국어 ", "😀한국어😀 ", "é "]) {
    const leaf = `${prefix}${TOKEN}`;
    const { findings, occurrences } = found(boundary.sanitizeValue({ note: leaf }));
    expect(findings).toHaveLength(1);
    const [finding] = findings as [SafeFinding];
    expect(leaf.slice(finding.start, finding.end)).toBe(TOKEN);
    expect(occurrences).toEqual([{ partIndex: 0, rangeScope: "leaf", rangeUnit: "utf16-code-units", leafOrdinal: 0 }]);
  }
});

test("the same range means different things in different scopes: leaf-relative, not document-relative", () => {
  const { findings, occurrences } = found(
    boundary.buildContext([
      { role: "user", text: `한국어 ${TOKEN}` },
      { role: "tool", value: ["😀😀😀", `😀 ${TOKEN}`, { deep: `${TOKEN}` }] },
    ]),
  );
  expect(findings).toHaveLength(3);
  expect(occurrences.map((occurrence) => occurrence.rangeScope)).toEqual(["text", "leaf", "leaf"]);
  expect(occurrences.map((occurrence) => ("leafOrdinal" in occurrence ? occurrence.leafOrdinal : null))).toEqual([
    null,
    1,
    2,
  ]);
  // Every finding repeats the core's per-scan id; the occurrence tells them apart.
  expect(new Set(findings.map((finding) => finding.id)).size).toBe(1);
  expect(findings.map((finding) => [finding.start, finding.end])).toEqual([
    [4, 4 + TOKEN.length],
    [3, 3 + TOKEN.length],
    [0, TOKEN.length],
  ]);
});

test("repeated strings: memoized scans, distinct occurrences", () => {
  const leaf = `repeat ${TOKEN}`;
  const { findings, occurrences } = found(boundary.sanitizeValue([leaf, leaf, leaf]));
  expect(findings).toHaveLength(3);
  expect(occurrences.map((occurrence) => ("leafOrdinal" in occurrence ? occurrence.leafOrdinal : null))).toEqual([
    0, 1, 2,
  ]);
  expect(new Set(findings.map((finding) => `${finding.start}:${finding.end}`)).size).toBe(1);
});

test("key-aware offset mapping: a finding from the key-context view is leaf-relative, scope leaf, key never in the range", () => {
  const { findings, value, occurrences } = found(boundary.sanitizeValue({ api_key: KEYED, name: KEYED }));
  expect(value).toEqual({ api_key: "<SECRET_1>", name: KEYED });
  expect(findings).toHaveLength(1);
  const [finding] = findings as [SafeFinding];
  expect([finding.start, finding.end]).toEqual([0, KEYED.length]);
  expect(KEYED.slice(finding.start, finding.end)).toBe(KEYED);
  expect(occurrences).toEqual([{ partIndex: 0, rangeScope: "leaf", rangeUnit: "utf16-code-units", leafOrdinal: 0 }]);
  expect(JSON.stringify(occurrences)).not.toContain("api_key");
});

test("absolute incremental offsets: a streamed secret split across chunks reports offsets over the whole logical text", () => {
  const text = `한국어 😀 ${TOKEN} 끝`;
  const whole = found(boundary.sanitizeText(text));
  for (const cut of [1, 5, 8, 10, 20, text.length - 3]) {
    if (cut > 0 && text.charCodeAt(cut - 1) >= 0xd800 && text.charCodeAt(cut - 1) <= 0xdbff) continue;
    const stream = boundary.openStream();
    stream.append(text.slice(0, cut));
    stream.append(text.slice(cut));
    const streamed = found(stream.finalize());
    expect(streamed.findings).toHaveLength(1);
    const [finding] = streamed.findings as [SafeFinding];
    expect(text.slice(finding.start, finding.end)).toBe(TOKEN);
    expect(streamed.occurrences).toEqual([{ partIndex: 0, rangeScope: "stream", rangeUnit: "utf16-code-units" }]);
    // Same range as the whole-input scan of the same text.
    expect([finding.start, finding.end]).toEqual([whole.findings[0]?.start, whole.findings[0]?.end]);
  }
  expect(whole.occurrences).toEqual([{ partIndex: 0, rangeScope: "text", rangeUnit: "utf16-code-units" }]);
});

test("onFinding and the result agree on the real core", () => {
  events.length = 0;
  const { findings, occurrences } = found(
    boundary.buildContext([
      { role: "user", text: TOKEN },
      { role: "tool", value: { api_key: KEYED, list: [TOKEN] } },
    ]),
  );
  const nonKey = events.filter((event) => event.occurrence.rangeScope !== "key");
  expect(nonKey.map((event) => event.finding)).toEqual([...findings]);
  expect(nonKey.map((event) => event.occurrence)).toEqual([...occurrences]);
});
