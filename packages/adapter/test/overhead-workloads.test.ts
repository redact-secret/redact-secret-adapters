/**
 * The adapter-overhead workloads (#11) are built, not committed. This pins
 * the JavaScript builder to the digest recorded in
 * `fixtures/overhead-profiles.json`, which `python/tests/test_overhead_workloads.py`
 * pins the Python builder to as well, so both harnesses measure one input.
 */

import { expect, test } from "vitest";

// @ts-expect-error -- a plain .mjs script with no declaration file
import { buildEvents, loadProfiles, syntheticSecret, workloadDigest } from "../../../scripts/overhead-workloads.mjs";

const HARNESS_HOSTS = new Set([
  "pino",
  "pino-streamwrite",
  "otel-js",
  "mask-js",
  "ai-context-js",
  "python-logging",
  "otel-python",
  "mask-python",
]);

test("the JavaScript workload builder reproduces the pinned digest", () => {
  const document = loadProfiles();
  expect(workloadDigest(document)).toBe(document.workloadDigest);
});

test("every profile names only hosts a harness measures, and plants the synthetic token only where declared", () => {
  const document = loadProfiles();
  const secret: string = syntheticSecret(document);
  expect(secret).toMatch(/^ghp_x+$/);
  for (const profile of document.profiles) {
    for (const host of profile.hosts) expect(HARNESS_HOSTS.has(host), `${profile.id}: ${host}`).toBe(true);
    const events: unknown[] = buildEvents(document, profile);
    expect(events).toHaveLength(document.distinctEvents);
    events.forEach((event, index) => {
      expect(JSON.stringify(event).includes(secret), `${profile.id}#${index}`).toBe(
        index % profile.params.secretEvery === 0,
      );
    });
  }
});
