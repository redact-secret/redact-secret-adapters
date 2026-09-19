/**
 * Exercises the live wrapper against the real installed core. It
 * deliberately masks no secret-shaped value — detection is the core's job
 * and is tested there — and asserts only that the wiring (`initialize()`
 * order, dynamic import) carries clean data through unchanged.
 */

import { expect, test } from "vitest";

import { createMaskSecrets } from "../src/index.js";

test("createMaskSecrets initializes the real core and returns a working masking function", async () => {
  const maskSecrets = await createMaskSecrets();
  const data = { role: "user", content: ["hello", "world"], count: 2 };
  expect(maskSecrets(data)).toEqual(data);
  expect(maskSecrets(data)).not.toBe(data);
});
