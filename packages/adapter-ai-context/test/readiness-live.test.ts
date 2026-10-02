/** The readiness check on the real installed core (redact-secret/redact-secret-adapters#182). */

import { expect, test } from "vitest";

import { checkAiContextReady } from "../src/index.js";

test("the real core is ready, and the result carries only fixed fields", async () => {
  const outcome = await checkAiContextReady();
  expect(outcome).toMatchObject({ ready: true, status: "ready", core: "ok", pii: "skipped", probe: "ok" });
  expect(Object.keys(outcome).every((key) => ["ready", "status", "core", "pii", "probe", "activation"].includes(key))).toBe(
    true,
  );
  expect(JSON.stringify(outcome)).not.toContain("ghp_");
});
