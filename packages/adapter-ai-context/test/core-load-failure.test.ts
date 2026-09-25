/**
 * The live factory when `@redact-secret/core` cannot even be imported: an
 * error that is not the core's own carries no code across the boundary.
 */

import { expect, test, vi } from "vitest";

vi.mock("@redact-secret/core", () => {
  throw new Error("cannot load module near SECRET_TOKEN_1");
});

const { createAiContextBoundary } = await import("../src/index.js");

test("a core that cannot be loaded fails every operation closed as core_error with no code", async () => {
  const boundary = await createAiContextBoundary({
    wholeInputLimits: { maxInputBytes: 256, maxFindings: 4 },
    incrementalLimits: {
      maxInputCodeUnits: 256,
      maxBufferedCodeUnits: 192,
      maxTokenCodeUnits: 64,
      maxMultilineCodeUnits: 64,
    },
    traversalLimits: { maxDepth: 3, maxNodes: 16 },
  });
  expect(boundary.sanitizeText("SECRET_TOKEN_1")).toEqual({ outcome: "blocked", reason: "core_error" });
  const stream = boundary.openStream();
  stream.append("SECRET_TOKEN_1");
  expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "core_error" });
});
