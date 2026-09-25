/**
 * The fixture's `uninitialized` phase: an operation before the core's
 * `initialize()` fails closed with the core's own `NOT_INITIALIZED`, with no
 * separate adapter branch. Kept in its own file so no other test has
 * initialized this module graph's core first; nothing here calls
 * `initialize()`.
 */

import * as core from "@redact-secret/core";
import { expect, test } from "vitest";

import { loadFixture, runConformance } from "./conformance.js";

test("every uninitialized-phase case of the pinned core fixture fails closed as NOT_INITIALIZED", () => {
  const fixture = loadFixture();
  const summary = runConformance(core, fixture, "uninitialized");
  expect(summary.cases).toBe(fixture.cases.filter((c) => c.phase === "uninitialized").length);
});
