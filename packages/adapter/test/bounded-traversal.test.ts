/**
 * Bounded traversal of pathological value trees (#11), from the shared
 * `fixtures/bounded-traversal-cases.json` that `python/tests/test_bounded_traversal.py`
 * also reads. Each case builds its shape from parameters, walks it, and checks
 * that the walk terminates, never passes the planted synthetic secret through,
 * and calls the scanner no more often than the case's bound.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { type Limits, maskSecretsWith, type ScanAndRedact } from "../src/index.js";

interface Shape {
  readonly kind: string;
  readonly leaf: string;
  readonly depth?: number;
  readonly width?: number;
  readonly side?: number;
  readonly length?: number;
}

interface BoundedCase {
  readonly name: string;
  readonly shape: Shape;
  readonly limits: Partial<Limits>;
  readonly maxScannerCalls: number;
  readonly mustContain: string;
}

const path = fileURLToPath(new URL("../../../fixtures/bounded-traversal-cases.json", import.meta.url));
const cases = (JSON.parse(readFileSync(path, "utf-8")) as { cases: BoundedCase[] }).cases;

/** Builds a case's shape iteratively, so building never recurses as deep as the shape. */
function buildShape(shape: Shape): unknown {
  const { kind, leaf } = shape;
  if (kind === "nested-arrays" || kind === "nested-objects" || kind === "nested-objects-with-leaves") {
    let value: unknown = leaf;
    for (let level = 0; level < (shape.depth ?? 0); level += 1) {
      if (kind === "nested-arrays") value = [value];
      else if (kind === "nested-objects") value = { child: value };
      else value = { leaf, child: value };
    }
    return value;
  }
  if (kind === "wide-array") return Array.from({ length: shape.width ?? 0 }, () => leaf);
  if (kind === "wide-object") {
    return Object.fromEntries(Array.from({ length: shape.width ?? 0 }, (_, index) => [`k${index}`, leaf]));
  }
  if (kind === "cube") {
    const side = shape.side ?? 0;
    return Array.from({ length: side }, () =>
      Array.from({ length: side }, () => Array.from({ length: side }, () => leaf)),
    );
  }
  if (kind === "long-string") return `${"x".repeat(shape.length ?? 0)} ${leaf}`;
  throw new Error(`unknown shape kind: ${kind}`);
}

test("the shared bounded-traversal cases cover every shape kind", () => {
  expect(new Set(cases.map((c) => c.shape.kind))).toEqual(
    new Set([
      "nested-arrays",
      "nested-objects",
      "nested-objects-with-leaves",
      "wide-array",
      "wide-object",
      "cube",
      "long-string",
    ]),
  );
});

for (const boundedCase of cases) {
  test(`bounded traversal: ${boundedCase.name}`, () => {
    let calls = 0;
    const counting: ScanAndRedact = (text) => {
      calls += 1;
      return fakeScanAndRedact(text);
    };
    const result = maskSecretsWith(counting, buildShape(boundedCase.shape), { limits: boundedCase.limits });
    const serialized = JSON.stringify(result);
    expect(calls).toBeLessThanOrEqual(boundedCase.maxScannerCalls);
    expect(serialized).not.toContain(boundedCase.shape.leaf);
    expect(serialized).toContain(boundedCase.mustContain);
  });
}
