/**
 * Exercises the live wrapper against the real installed core: `initialize()`
 * order, the dynamic import, and that a secret the real core detects is
 * actually masked, so a wrapper that returned its input would fail. The
 * token is synthetic and built at runtime.
 */

import { expect, test } from "vitest";

import { createMaskSecrets } from "../src/index.js";

const SYNTHETIC_GITHUB_TOKEN = `ghp_${"x".repeat(36)}`;

test("createMaskSecrets initializes the real core and returns a working masking function", async () => {
  const maskSecrets = await createMaskSecrets();
  const data = { role: "user", content: ["hello", "world"], count: 2 };
  expect(maskSecrets(data)).toEqual(data);
  expect(maskSecrets(data)).not.toBe(data);
});

test("a custom policy reaches the real core", async () => {
  const maskSecrets = await createMaskSecrets({ policy: { evaluate: () => "block" } });
  expect(maskSecrets({ note: `token ${SYNTHETIC_GITHUB_TOKEN} here`, clean: "plain" })).toEqual({
    note: "[REDACTED:BLOCKED]",
    clean: "plain",
  });
});

test("the real core masks a synthetic token anywhere in the tree", async () => {
  const maskSecrets = await createMaskSecrets();
  const error = Object.assign(new Error("request failed"), {
    config: { headers: { Authorization: `Bearer ${SYNTHETIC_GITHUB_TOKEN}` } },
  });
  const masked = maskSecrets({ content: [`token ${SYNTHETIC_GITHUB_TOKEN} here`], error });
  expect(JSON.stringify(masked)).not.toContain(SYNTHETIC_GITHUB_TOKEN);
  expect(masked).toMatchObject({
    content: ["token <SECRET_1> here"],
    error: { config: { headers: { Authorization: "Bearer <SECRET_1>" } } },
  });
});
