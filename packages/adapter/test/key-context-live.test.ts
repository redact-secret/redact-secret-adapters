/**
 * The shared synthetic key/value pairs through the logging walker with the
 * real core (redact-secret-adapters#172). CI runs this at both ends of the
 * declared core range. Detection is the core's; these assert only that the
 * walker asks the core for the key-context view and applies its answer.
 */

import * as core from "@redact-secret/core";
import { beforeAll, expect, test } from "vitest";

import { expectedLeaf, loadKeyContextCases } from "../../../fixtures/key-context.js";
import { createMaskSecrets, type Policy } from "../src/index.js";

beforeAll(async () => {
  await core.initialize();
});

const cases = loadKeyContextCases();

test.each(cases)(
  "$id: a leaf under its key is masked the way the core masks its key-context view",
  async (testCase) => {
    const maskSecrets = await createMaskSecrets();
    expect(maskSecrets({ [testCase.key]: testCase.value })).toEqual({ [testCase.key]: expectedLeaf(testCase) });
  },
);

test("benign siblings are untouched next to a context-dependent credential, and the key set is unchanged", async () => {
  const maskSecrets = await createMaskSecrets();
  const input = { api_key: "synthetic-example-value-0001", name: "synthetic-example-value-0001", count: 3 };
  const out = maskSecrets(input) as Record<string, unknown>;
  expect(out).toEqual({ api_key: "<SECRET_1>", name: "synthetic-example-value-0001", count: 3 });
  expect(Object.keys(out)).toEqual(Object.keys(input));
});

test("a context-dependent credential outside a direct key is not given key context", async () => {
  const maskSecrets = await createMaskSecrets();
  expect(maskSecrets({ list: ["synthetic-example-value-0001"] })).toEqual({ list: ["synthetic-example-value-0001"] });
});

test("a throwing getter beside a context-dependent credential fails only that key", async () => {
  const maskSecrets = await createMaskSecrets();
  const input = {
    password: "synthetic example passphrase 1",
    get boom(): string {
      throw new Error("synthetic-example-value-0001");
    },
  };
  const out = JSON.stringify(maskSecrets(input));
  expect(out).toContain("<SECRET_1>");
  expect(out).toContain("[REDACTED:ERROR]");
  expect(out).not.toContain("synthetic");
});

test("unsupported values pass the way they always have", async () => {
  const maskSecrets = await createMaskSecrets();
  const out = maskSecrets({ api_key: 12, password: null, client_secret: undefined, big: 1n }) as Record<
    string,
    unknown
  >;
  expect(out).toEqual({ api_key: 12, password: null, client_secret: undefined, big: 1n });
});

test.each([
  ["block", "[REDACTED:BLOCKED]"],
  ["warn", "synthetic-example-value-0001"],
  ["allow", "synthetic-example-value-0001"],
  ["redact", "<SECRET_1>"],
] as const)("policy %s applies to a key-context finding", async (action, expected) => {
  const policy: Policy = { evaluate: () => action };
  const maskSecrets = await createMaskSecrets({ policy });
  expect(maskSecrets({ api_key: "synthetic-example-value-0001" })).toEqual({ api_key: expected });
});

test("a throwing policy fails the key-context leaf closed without the message", async () => {
  const policy: Policy = {
    evaluate: () => {
      throw new Error("synthetic-example-value-0001");
    },
  };
  const maskSecrets = await createMaskSecrets({ policy });
  const out = JSON.stringify(maskSecrets({ api_key: "synthetic-example-value-0001" }));
  expect(out).toBe('{"api_key":"[REDACTED:ERROR]"}');
});
