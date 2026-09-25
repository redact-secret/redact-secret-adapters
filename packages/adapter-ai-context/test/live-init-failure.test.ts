/**
 * The live factory when the core cannot be initialized: it does not reject,
 * and every operation fails closed with the fixed outcome the core's error
 * maps to, never falling back to returning input.
 */

import { expect, test, vi } from "vitest";

vi.mock("@redact-secret/core", () => ({
  initialize: () =>
    Promise.reject(Object.assign(new Error("artifact missing near SECRET_TOKEN_1"), { code: "INITIALIZATION_FAILED" })),
  scanAndRedact: () => {
    throw new Error("must not be reached");
  },
  createIncrementalSanitizer: () => {
    throw new Error("must not be reached");
  },
}));

const { createAiContextBoundary } = await import("../src/index.js");

const LIMITS = {
  wholeInputLimits: { maxInputBytes: 256, maxFindings: 4 },
  incrementalLimits: {
    maxInputCodeUnits: 256,
    maxBufferedCodeUnits: 192,
    maxTokenCodeUnits: 64,
    maxMultilineCodeUnits: 64,
  },
  traversalLimits: { maxDepth: 3, maxNodes: 16 },
};
const FAILED = { outcome: "blocked", reason: "core_error", code: "INITIALIZATION_FAILED" };

test("an initialization failure fails every operation closed as core_error / INITIALIZATION_FAILED", async () => {
  const boundary = await createAiContextBoundary(LIMITS);
  expect(boundary.sanitizeText("SECRET_TOKEN_1")).toEqual(FAILED);
  expect(boundary.sanitizeValue({ a: "SECRET_TOKEN_1" })).toEqual(FAILED);
  expect(boundary.sanitizeToolResult("SECRET_TOKEN_1")).toEqual(FAILED);
  expect(boundary.buildContext([{ role: "user", text: "SECRET_TOKEN_1" }])).toEqual(FAILED);
  const stream = boundary.openStream();
  stream.append("SECRET_TOKEN_1");
  expect(stream.finalize()).toEqual(FAILED);
  expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "lifecycle" });
});

test("malformed options still reject, with a fixed message", async () => {
  await expect(createAiContextBoundary({ ...LIMITS, traversalLimits: undefined } as never)).rejects.toThrow(TypeError);
});
