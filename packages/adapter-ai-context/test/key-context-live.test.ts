/**
 * The AI-context boundary on the shared key-context primitive
 * (redact-secret-adapters#172): the same synthetic key/value pairs as the
 * logging and tracing adapters, through the real core, must come out the same,
 * and the boundary's own offset contract must be unchanged.
 */

import { expect, test } from "vitest";

import { expectedLeaf, loadKeyContextCases } from "../../../fixtures/key-context.js";
import { createAiContextBoundary } from "../src/index.js";

const cases = loadKeyContextCases();
const OPTIONS = {
  wholeInputLimits: { maxInputBytes: 4096, maxFindings: 16 },
  incrementalLimits: {
    maxInputCodeUnits: 16384,
    maxBufferedCodeUnits: 2176,
    maxTokenCodeUnits: 1024,
    maxMultilineCodeUnits: 2048,
  },
  traversalLimits: { maxDepth: 4, maxNodes: 64 },
};

test.each(cases)("$id: sanitizeValue agrees with the logging and tracing adapters", async (testCase) => {
  const boundary = await createAiContextBoundary(OPTIONS);
  const outcome = boundary.sanitizeValue({ [testCase.key]: testCase.value });
  expect(outcome).toMatchObject({ outcome: "ok", value: { [testCase.key]: expectedLeaf(testCase) } });
});

test("findings keep leaf-relative offsets across emoji and Korean", async () => {
  const boundary = await createAiContextBoundary(OPTIONS);
  for (const { key, value, masked } of cases.filter((testCase) => testCase.masked !== null)) {
    const outcome = boundary.sanitizeValue({ [key]: value });
    if (outcome.outcome !== "ok") throw new Error("expected ok");
    expect(outcome.findings).toHaveLength(1);
    const [finding] = outcome.findings;
    expect(finding?.start).toBe(0);
    expect(finding?.end).toBe(value.length);
    expect(masked).toBe("<SECRET_1>");
  }
});

test("buildContext applies key context to a value part and none to a text part", async () => {
  const boundary = await createAiContextBoundary(OPTIONS);
  const outcome = boundary.buildContext([
    { role: "user", text: "synthetic-example-value-0001" },
    { role: "tool", value: { api_key: "synthetic-example-value-0001" } },
  ]);
  expect(outcome).toMatchObject({
    outcome: "ok",
    value: [
      { role: "user", content: "synthetic-example-value-0001" },
      { role: "tool", content: { api_key: "<SECRET_1>" } },
    ],
  });
});
