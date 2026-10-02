/**
 * Occurrence provenance (redact-secret-adapters#177): every finding in a
 * flattened result, and every `onFinding` call, says which part, leaf or key
 * and which range scope it belongs to, so findings that repeat an `id` can be
 * told apart and a range is read against what it indexes. Additive: the
 * outcome's JSON and `start`/`end` are unchanged. Fake core here; the real core
 * is in `occurrence-live.test.ts`.
 */

import { describe, expect, test } from "vitest";

import {
  attachFindingOccurrences,
  createAiContextBoundaryWith,
  FINDING_OCCURRENCE_FIELDS,
  type FindingOccurrence,
  findingOccurrences,
  type SafeFinding,
} from "../src/index.js";
import { createFakeCore, LIMITS } from "./fake-core.js";

function setup() {
  const fake = createFakeCore();
  const events: { finding: SafeFinding; context: object; occurrence: FindingOccurrence }[] = [];
  const boundary = createAiContextBoundaryWith(fake.core, {
    ...LIMITS,
    traversalLimits: { maxDepth: 6, maxNodes: 200 },
    onFinding: (finding, context, occurrence) => events.push({ finding, context, occurrence }),
  });
  return { boundary, events, calls: fake.calls };
}

const T = "SECRET_TOKEN_1";

function okOutcome<V>(outcome: { outcome: string } & Partial<{ value: V; findings: readonly SafeFinding[] }>) {
  if (outcome.outcome !== "ok") throw new Error(`expected ok, got ${outcome.outcome}`);
  return outcome as { outcome: "ok"; value: V; findings: readonly SafeFinding[] };
}

/** The tuple that is unique within one operation. */
const tuple = (finding: SafeFinding, occurrence: FindingOccurrence): string =>
  JSON.stringify([
    occurrence.partIndex,
    occurrence.rangeScope,
    "leafOrdinal" in occurrence ? occurrence.leafOrdinal : "keyOrdinal" in occurrence ? occurrence.keyOrdinal : null,
    finding.id,
  ]);

describe("multiple parts and leaves with repeated finding ids", () => {
  test("buildContext: the same id from different parts and leaves is distinguished by occurrence, deterministically", () => {
    const { boundary } = setup();
    const outcome = okOutcome(
      boundary.buildContext([
        { role: "user", text: `use ${T}` },
        { role: "tool", value: { a: T, nested: [T, "plain", T] } },
        { role: "user", text: `again ${T}` },
      ]),
    );
    const occurrences = findingOccurrences(outcome) as readonly FindingOccurrence[];
    expect(outcome.findings.map((finding) => finding.id)).toEqual(Array(5).fill("finding-1"));
    expect(occurrences.map((occurrence) => ({ ...occurrence }))).toEqual([
      { partIndex: 0, rangeScope: "text", rangeUnit: "utf16-code-units" },
      { partIndex: 1, rangeScope: "leaf", rangeUnit: "utf16-code-units", leafOrdinal: 0 },
      { partIndex: 1, rangeScope: "leaf", rangeUnit: "utf16-code-units", leafOrdinal: 1 },
      { partIndex: 1, rangeScope: "leaf", rangeUnit: "utf16-code-units", leafOrdinal: 3 },
      { partIndex: 2, rangeScope: "text", rangeUnit: "utf16-code-units" },
    ]);
    // Leaf 2 ("plain") had no finding but still advanced the ordinal.
    expect(occurrences.length).toBe(outcome.findings.length);
    const seen = new Set(
      outcome.findings.map((finding, index) => tuple(finding, occurrences[index] as FindingOccurrence)),
    );
    // Two text parts share (partIndex differs) — all five tuples are distinct.
    expect(seen.size).toBe(5);
    // Deterministic: the same call gives the same occurrences.
    const again = findingOccurrences(
      okOutcome(
        setup().boundary.buildContext([
          { role: "user", text: `use ${T}` },
          { role: "tool", value: { a: T, nested: [T, "plain", T] } },
          { role: "user", text: `again ${T}` },
        ]),
      ),
    );
    expect(JSON.stringify(again)).toBe(JSON.stringify(occurrences));
  });

  test("sanitizeText and sanitizeValue are single-part operations: partIndex 0", () => {
    const { boundary } = setup();
    const text = okOutcome(boundary.sanitizeText(`x ${T}`));
    expect(findingOccurrences(text)).toEqual([{ partIndex: 0, rangeScope: "text", rangeUnit: "utf16-code-units" }]);
    const value = okOutcome(boundary.sanitizeValue({ k: T }));
    expect(findingOccurrences(value)).toEqual([
      { partIndex: 0, rangeScope: "leaf", rangeUnit: "utf16-code-units", leafOrdinal: 0 },
    ]);
  });
});

describe("memoization and shared references", () => {
  test("repeated strings are scanned once but each occurrence has its own ordinal", () => {
    const { boundary, calls } = setup();
    const outcome = okOutcome(boundary.sanitizeValue([T, T, T]));
    expect(calls.scans.filter((text) => text === T)).toHaveLength(1);
    const ordinals = (findingOccurrences(outcome) ?? []).map((occurrence) =>
      "leafOrdinal" in occurrence ? occurrence.leafOrdinal : -1,
    );
    expect(ordinals).toEqual([0, 1, 2]);
  });

  test("a shared reference is a leaf at every path", () => {
    const { boundary } = setup();
    const shared = { v: T };
    const outcome = okOutcome(boundary.sanitizeValue({ first: shared, second: shared }));
    const ordinals = (findingOccurrences(outcome) ?? []).map((occurrence) =>
      "leafOrdinal" in occurrence ? occurrence.leafOrdinal : -1,
    );
    expect(ordinals).toEqual([0, 1]);
  });

  test("ordinals count clean leaves and ignore memo hits: they depend only on document order", () => {
    const { boundary } = setup();
    const outcome = okOutcome(boundary.sanitizeValue(["a", "a", "a", T, "a"]));
    expect(findingOccurrences(outcome)).toEqual([
      { partIndex: 0, rangeScope: "leaf", rangeUnit: "utf16-code-units", leafOrdinal: 3 },
    ]);
  });
});

describe("onFinding and the result agree", () => {
  test("the leaf and text events, in order, are exactly the result's findings with their occurrences", () => {
    const { boundary, events } = setup();
    const outcome = okOutcome(
      boundary.buildContext([
        { role: "user", text: T },
        { role: "tool", value: { plain: T, WARN_ME: "WARN_ME", list: [T] } },
      ]),
    );
    const occurrences = findingOccurrences(outcome) as readonly FindingOccurrence[];
    const nonKey = events.filter((event) => event.occurrence.rangeScope !== "key");
    expect(nonKey.map((event) => event.finding)).toEqual([...outcome.findings]);
    expect(nonKey.map((event) => event.occurrence)).toEqual([...occurrences]);
    // Key scans are events with their own scope and ordinal, never in the result.
    const keyEvents = events.filter((event) => event.occurrence.rangeScope === "key");
    expect(keyEvents.length).toBeGreaterThan(0);
    expect(keyEvents.map((event) => event.occurrence)).toContainEqual({
      partIndex: 1,
      rangeScope: "key",
      rangeUnit: "utf16-code-units",
      keyOrdinal: 1,
    });
    for (const event of events) expect(Object.keys(event.context)).toEqual(["boundary"]);
  });

  test("a throwing onFinding changes nothing, including the occurrences", () => {
    const fake = createFakeCore();
    const boundary = createAiContextBoundaryWith(fake.core, {
      ...LIMITS,
      onFinding: () => {
        throw new Error("synthetic telemetry failure");
      },
    });
    const outcome = okOutcome(boundary.sanitizeValue({ k: T }));
    expect(findingOccurrences(outcome)).toHaveLength(1);
  });
});

describe("compatibility", () => {
  test("the outcome's JSON and the finding fields are unchanged: occurrences live beside the outcome", () => {
    const { boundary } = setup();
    const outcome = okOutcome(boundary.sanitizeText(`x ${T}`));
    expect(Object.keys(outcome).sort()).toEqual(["findings", "outcome", "value"]);
    expect(Object.keys(JSON.parse(JSON.stringify(outcome)))).toEqual(["outcome", "value", "findings"]);
    expect(JSON.stringify(outcome)).not.toContain("rangeScope");
    expect(Object.keys(outcome.findings[0] ?? {})).toEqual([
      "id",
      "type",
      "detector",
      "confidence",
      "action",
      "obfuscation",
      "start",
      "end",
    ]);
  });

  test("occurrences are frozen, aligned with findings, and carry only the documented non-sensitive fields", () => {
    const { boundary } = setup();
    const outcome = okOutcome(boundary.sanitizeValue({ "private-field-name": [T] }));
    const occurrences = findingOccurrences(outcome) as readonly FindingOccurrence[];
    expect(Object.isFrozen(occurrences)).toBe(true);
    expect(Object.isFrozen(occurrences[0])).toBe(true);
    expect(occurrences).toHaveLength(outcome.findings.length);
    for (const occurrence of occurrences) {
      for (const field of Object.keys(occurrence))
        expect(FINDING_OCCURRENCE_FIELDS as readonly string[]).toContain(field);
    }
    const everything = JSON.stringify([occurrences, ...setup().events]);
    expect(everything).not.toContain("SECRET_TOKEN");
    expect(everything).not.toContain("private-field-name");
  });

  test("non-ok outcomes and foreign objects have none, and attachFindingOccurrences forwards them", () => {
    const { boundary } = setup();
    expect(findingOccurrences(boundary.sanitizeText("BLOCK_ME"))).toBeUndefined();
    expect(findingOccurrences({ outcome: "ok", value: "", findings: [] })).toBeUndefined();
    expect(findingOccurrences(null)).toBeUndefined();
    const source = okOutcome(boundary.sanitizeText(`x ${T}`));
    const target = Object.freeze({ outcome: "ok", value: "x", findings: source.findings });
    attachFindingOccurrences(target, source);
    expect(findingOccurrences(target)).toEqual(findingOccurrences(source));
    expect(attachFindingOccurrences({}, {})).toEqual({});
  });

  test("the stream: scope stream, partIndex 0, one occurrence per finding", () => {
    const { boundary } = setup();
    const stream = boundary.openStream();
    stream.append("hello ");
    stream.append(`${T} bye`);
    const outcome = okOutcome(stream.finalize());
    expect(findingOccurrences(outcome)).toEqual([
      { partIndex: 0, rangeScope: "stream", rangeUnit: "utf16-code-units" },
    ]);
  });
});
