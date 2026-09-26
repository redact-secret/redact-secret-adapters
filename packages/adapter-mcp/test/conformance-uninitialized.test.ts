/**
 * The MCP fixture's `uninitialized` phase: an operation before the core's
 * `initialize()` fails closed with the core's own `NOT_INITIALIZED`, which
 * maps to the fixed blocked result. Kept in its own file so no other test
 * has initialized this module graph's core first.
 */

import * as core from "@redact-secret/core";
import { expect, test } from "vitest";

import {
  createAdapterBoundary,
  loadMcpFixture,
  loadResourceFixture,
  loadResourceRunner,
  loadRunner,
} from "./conformance.js";

test("every uninitialized-phase case of the pinned MCP fixture fails closed as NOT_INITIALIZED", async () => {
  const fixture = loadMcpFixture();
  const { runMcpBoundaryConformance } = await loadRunner();
  const summary = await runMcpBoundaryConformance(core, fixture, {
    phase: "uninitialized",
    createBoundary: (api, options) => createAdapterBoundary(api, options),
  });
  expect(summary.cases).toBe(fixture.cases.filter((c) => c.phase === "uninitialized").length);
  expect(summary.cases).toBeGreaterThan(0);
});

test("every uninitialized-phase case of the pinned resources/read fixture fails closed as NOT_INITIALIZED", async () => {
  const fixture = loadResourceFixture();
  const { runMcpResourcesReadConformance } = await loadResourceRunner();
  const summary = await runMcpResourcesReadConformance(core, fixture, {
    phase: "uninitialized",
    createBoundary: (api, options) => createAdapterBoundary(api, options),
  });
  expect(summary.cases).toBe(fixture.cases.filter((c) => c.phase === "uninitialized").length);
  expect(summary.cases).toBeGreaterThan(0);
});
