/**
 * The package against the core's AI-context boundary contract
 * (redact-secret/redact-secret#610), on the real installed core, after
 * `initialize()`. The uninitialized cases run in
 * `conformance-uninitialized.test.ts`, in their own module graph.
 */

import * as core from "@redact-secret/core";
import { expect, test } from "vitest";

import { loadFixture, runConformance } from "./conformance.js";

test("every initialized-phase case of the pinned core fixture reaches the core's expected outcome", async () => {
  await core.initialize();
  const fixture = loadFixture();
  const summary = runConformance(core, fixture, "initialized");
  const expectedCases = fixture.cases.filter(
    (c) => (c.phase ?? "initialized") === "initialized" && (!c.runtimes || c.runtimes.includes("javascript")),
  ).length;
  expect(summary.cases).toBe(expectedCases);
  expect(summary.partitions).toBeGreaterThan(0);
  expect(summary.telemetryEvents).toBeGreaterThan(0);
});
