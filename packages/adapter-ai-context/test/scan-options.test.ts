/**
 * The AI-context boundary names, and rejects, the scan options it cannot
 * honor for every operation (redact-secret-adapters#175): the core has no
 * ruleset for an incremental session, and its whole-input limits are
 * `wholeInputLimits` here. They are never silently ignored.
 */

import { expect, test } from "vitest";

import { createAiContextBoundary, createAiContextBoundaryWith, withDefaultLimits } from "../src/index.js";
import { createFakeCore, LIMITS } from "./fake-core.js";

test("ruleset and scanLimits are rejected by name by the injected API", () => {
  const { core } = createFakeCore();
  for (const options of [{ ruleset: "ruleset-revision: 1\n" }, { scanLimits: { maxInputBytes: 1, maxFindings: 1 } }]) {
    expect(() => createAiContextBoundaryWith(core, { ...LIMITS, ...options } as never)).toThrow(TypeError);
    const name = Object.keys(options)[0] as string;
    expect(() => createAiContextBoundaryWith(core, { ...LIMITS, ...options } as never)).toThrow(name);
  }
});

test("a rejection reaches the live factory, and an inherited option is rejected as well", async () => {
  await expect(createAiContextBoundary({ ruleset: "x" } as never)).rejects.toBeInstanceOf(TypeError);
  const base = { ruleset: "x" };
  const layered = Object.create(base) as object;
  expect(() => createAiContextBoundaryWith(createFakeCore().core, withDefaultLimits(layered as never))).toThrow(
    TypeError,
  );
});

test("the options it does take are unchanged: wholeInputLimits, incrementalLimits and placeholderFormatter", () => {
  const { core } = createFakeCore();
  expect(() => createAiContextBoundaryWith(core, { ...LIMITS, placeholderFormatter: () => "[x]" })).not.toThrow();
});
