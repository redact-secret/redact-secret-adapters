/**
 * The package against the core's MCP boundary contract
 * (redact-secret/redact-secret#612), on the real installed core, after
 * `initialize()`, replayed in process through the public API. The same
 * fixture is replayed over real MCP SDK transports in `transport.test.ts`;
 * the uninitialized cases run in `conformance-uninitialized.test.ts`.
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

test("every initialized-phase case of the pinned MCP fixture reaches the contract's outcome through the adapter", async () => {
  await core.initialize();
  const fixture = loadMcpFixture();
  const { runMcpBoundaryConformance } = await loadRunner();
  const summary = await runMcpBoundaryConformance(core, fixture, {
    phase: "initialized",
    createBoundary: (api, options) => createAdapterBoundary(api, options),
  });
  expect(summary.cases).toBe(fixture.cases.filter((c) => (c.phase ?? "initialized") === "initialized").length);
  expect(summary.pulledChunks).toBeGreaterThan(0);
  expect(summary.telemetryEvents).toBeGreaterThan(0);
});

test("every initialized-phase case of the pinned resources/read fixture reaches the contract's outcome through the adapter", async () => {
  await core.initialize();
  const fixture = loadResourceFixture();
  const { runMcpResourcesReadConformance } = await loadResourceRunner();
  const summary = await runMcpResourcesReadConformance(core, fixture, {
    phase: "initialized",
    createBoundary: (api, options) => createAdapterBoundary(api, options),
  });
  expect(summary.cases).toBe(fixture.cases.filter((c) => (c.phase ?? "initialized") === "initialized").length);
  expect(summary.reads).toBeGreaterThan(0);
  expect(summary.telemetryEvents).toBeGreaterThan(0);
});
