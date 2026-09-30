/**
 * Edge cases of the boundary that the everyday fake core never reaches:
 * keys over non-string values, a core that answers outside its contract in
 * the key-context view, a finding list holding primitives, a non-array
 * `buildContext` input, and the full error-code registry. Each case pins a
 * fail-closed branch that mutation testing showed to be unprotected
 * (redact-secret/redact-secret-adapters#89). Every value is synthetic.
 */

import type { ScanResult, SecretFinding, SecretScanErrorCode } from "@redact-secret/core";
import { describe, expect, test } from "vitest";

import { type AiContextCore, createAiContextBoundaryWith } from "../src/index.js";
import { createFakeCore, FakeScanError, LIMITS } from "./fake-core.js";

const SECRET = "SECRET_TOKEN_7";

function boundaryOver(core: AiContextCore) {
  return createAiContextBoundaryWith(core, LIMITS);
}

function finding(action: SecretFinding["action"], start: number, end: number): SecretFinding {
  return {
    id: "finding-1",
    type: "generic_token",
    detector: "fake",
    confidence: "high",
    obfuscation: "none",
    action,
    start,
    end,
  };
}

/** A core whose whole-input scan is scripted; the incremental session is the fake's. */
function scriptedCore(scan: (text: string) => ScanResult): AiContextCore {
  return { ...createFakeCore().core, scanAndRedact: (text) => scan(text) };
}

describe("keys over values that are not strings", () => {
  // A non-string value has no string leaf, so there is no key-context view
  // to catch the key: the key visitor alone must fail the value.
  test.each([
    ["a redact key over a number", { [SECRET]: 1 }, { reason: "policy" }],
    ["a block key over an object", { BLOCK_ME: {} }, { reason: "policy" }],
    ["a block key over an array", { BLOCK_ME: [1, true] }, { reason: "policy" }],
    ["a redact key over null", { [SECRET]: null }, { reason: "policy" }],
    ["a failing key over null", { BOOM: null }, { reason: "core_error", code: "DETECTOR_FAILURE" }],
    ["a failing key over a boolean", { BOOM: false }, { reason: "core_error", code: "DETECTOR_FAILURE" }],
  ])("%s blocks the value", (_name, value, expected) => {
    const outcome = boundaryOver(createFakeCore().core).sanitizeValue(value);
    expect(outcome).toEqual({ outcome: "blocked", ...expected });
  });

  test("a nested key over a non-string value blocks the whole value", () => {
    const outcome = boundaryOver(createFakeCore().core).sanitizeValue({ outer: [{ [SECRET]: 7 }] });
    expect(outcome).toEqual({ outcome: "blocked", reason: "policy" });
  });

  test("a warn key or a clean key over a non-string value passes unchanged", () => {
    const outcome = boundaryOver(createFakeCore().core).sanitizeValue({ WARN_ME: 1, plain: null });
    expect(outcome).toMatchObject({ outcome: "ok", value: { WARN_ME: 1, plain: null } });
  });
});

describe("a finding list that holds a primitive is core_error", () => {
  // A primitive has no `action`, so a `block` it stands for would be missed.
  test.each([
    ["a string", ["block"]],
    ["a number", [1]],
    ["a boolean after an object", [finding("redact", 0, 1), true]],
  ])("%s", (_name, findings) => {
    const core = scriptedCore((text) => ({ text, findings }) as unknown as ScanResult);
    expect(boundaryOver(core).sanitizeText("plain text")).toEqual({ outcome: "blocked", reason: "core_error" });
  });
});

describe("the key-context view", () => {
  // Leaf "abcdef" under key "k": the view is {"k":"abcdef"}, the leaf spans
  // view offsets 6..12, and the view is 14 code units long.
  const LEAF = "abcdef";
  const VIEW = `{"k":"${LEAF}"}`;

  function viewCore(onView: (text: string) => ScanResult, alone: SecretFinding[] = []): AiContextCore {
    return scriptedCore((text) => {
      if (text === "k") return { text, findings: [] };
      return text === LEAF ? { text, findings: alone } : onView(text);
    });
  }

  test("a redact finding exactly over the leaf is shifted to leaf offsets", () => {
    const core = viewCore(() => ({ text: `{"k":"<SECRET_1>"}`, findings: [finding("redact", 6, 12)] }));
    const outcome = boundaryOver(core).sanitizeValue({ k: LEAF });
    expect(outcome).toMatchObject({ outcome: "ok", value: { k: "<SECRET_1>" } });
    if (outcome.outcome !== "ok") throw new Error("expected ok");
    expect(outcome.findings.map((f) => [f.action, f.start, f.end])).toEqual([["redact", 0, 6]]);
  });

  test("a redact finding that starts in the leaf and ends past it blocks as policy", () => {
    const core = viewCore((text) => ({ text, findings: [finding("redact", 8, 14)] }));
    expect(boundaryOver(core).sanitizeValue({ k: LEAF })).toEqual({ outcome: "blocked", reason: "policy" });
  });

  test("a redact finding that starts before the leaf and ends in it blocks as policy", () => {
    const core = viewCore((text) => ({ text, findings: [finding("redact", 5, 12)] }));
    expect(boundaryOver(core).sanitizeValue({ k: LEAF })).toEqual({ outcome: "blocked", reason: "policy" });
  });

  test("a block finding outside the leaf blocks as policy", () => {
    const core = viewCore((text) => ({ text, findings: [finding("block", 0, 2)] }));
    expect(boundaryOver(core).sanitizeValue({ k: LEAF })).toEqual({ outcome: "blocked", reason: "policy" });
  });

  test("a warn finding outside the leaf is dropped and the leaf passes", () => {
    const core = viewCore((text) => ({ text, findings: [finding("warn", 0, 2)] }));
    expect(boundaryOver(core).sanitizeValue({ k: LEAF })).toEqual({
      outcome: "ok",
      value: { k: LEAF },
      findings: [],
    });
  });

  test("a view block inside the leaf replaces a leaf-alone warn result", () => {
    const core = viewCore((text) => ({ text, findings: [finding("block", 6, 12)] }), [finding("warn", 0, 6)]);
    expect(boundaryOver(core).sanitizeValue({ k: LEAF })).toEqual({ outcome: "blocked", reason: "policy" });
  });

  test("a view redact inside the leaf replaces a leaf-alone warn result", () => {
    const core = viewCore(
      () => ({ text: `{"k":"<SECRET_1>"}`, findings: [finding("redact", 6, 12)] }),
      [finding("warn", 0, 6)],
    );
    expect(boundaryOver(core).sanitizeValue({ k: LEAF })).toMatchObject({ outcome: "ok", value: { k: "<SECRET_1>" } });
  });

  test("a leaf redacted to the empty string passes as the empty string", () => {
    const core = viewCore(() => ({ text: `{"k":""}`, findings: [finding("redact", 6, 12)] }));
    expect(boundaryOver(core).sanitizeValue({ k: LEAF })).toMatchObject({ outcome: "ok", value: { k: "" } });
  });

  test.each([
    ["the prefix is missing", `"abcdef"}`],
    ["the suffix is missing", `{"k":"abcdef`],
    ["prefix and suffix overlap", `{"k":"}`],
  ])("a view text whose shape is broken is core_error: %s", (_name, viewText) => {
    const core = viewCore(() => ({ text: viewText, findings: [] }));
    expect(boundaryOver(core).sanitizeValue({ k: LEAF })).toEqual({ outcome: "blocked", reason: "core_error" });
  });

  test("the view is exactly the key and the leaf, verbatim", () => {
    const seen: string[] = [];
    const core = scriptedCore((text) => {
      seen.push(text);
      return { text, findings: [] };
    });
    boundaryOver(core).sanitizeValue({ k: LEAF });
    expect(seen).toEqual(["k", LEAF, VIEW]);
  });
});

describe("buildContext over a value that is not an array", () => {
  test.each([
    ["an object", {}],
    ["null", null],
    ["a string", "parts"],
    ["an iterable that is not an array", new Set([{ role: "user", text: "hi" }])],
  ])("%s is unsupported_value and never throws", (_name, parts) => {
    const { core, calls } = createFakeCore();
    expect(boundaryOver(core).buildContext(parts as never)).toEqual({
      outcome: "blocked",
      reason: "unsupported_value",
    });
    expect(calls.scans).toEqual([]);
  });
});

describe("the core error-code registry", () => {
  const LIMIT: SecretScanErrorCode[] = [
    "INPUT_LIMIT_EXCEEDED",
    "FINDING_LIMIT_EXCEEDED",
    "BUFFER_LIMIT_EXCEEDED",
    "TOKEN_LIMIT_EXCEEDED",
    "MULTILINE_LIMIT_EXCEEDED",
  ];
  const OTHER: SecretScanErrorCode[] = [
    "INVALID_INPUT",
    "INVALID_OPTIONS",
    "INVALID_DETECTOR",
    "DETECTOR_FAILURE",
    "INVALID_CANDIDATE",
    "POLICY_FAILURE",
    "INVALID_POLICY_ACTION",
    "INVALID_FINDINGS",
    "PLACEHOLDER_FAILURE",
    "INVALID_PLACEHOLDER",
    "INVALID_LIMITS",
    "INVALID_RULESET",
    "NOT_INITIALIZED",
    "INITIALIZATION_FAILED",
    "INVALID_CHUNK",
    "INVALID_UTF8",
    "UNPAIRED_SURROGATE",
  ];

  function outcomeFor(error: unknown) {
    const core = createFakeCore({ scanFailures: { FAIL_HERE: error } }).core;
    return boundaryOver(core).sanitizeText("FAIL_HERE");
  }

  test.each(LIMIT)("%s is forwarded as limit_exceeded", (code) => {
    expect(outcomeFor(new FakeScanError(code, SECRET))).toEqual({ outcome: "blocked", reason: "limit_exceeded", code });
  });

  test("INVALID_STATE is forwarded as lifecycle", () => {
    expect(outcomeFor(new FakeScanError("INVALID_STATE", SECRET))).toEqual({
      outcome: "blocked",
      reason: "lifecycle",
      code: "INVALID_STATE",
    });
  });

  test.each(OTHER)("%s is forwarded as core_error", (code) => {
    expect(outcomeFor(new FakeScanError(code, SECRET))).toEqual({ outcome: "blocked", reason: "core_error", code });
  });

  test.each([
    ["an unknown code", "NOT_A_CODE"],
    ["a code carrying input", `INVALID_INPUT ${SECRET}`],
    ["an empty code", ""],
    ["a registry code in lower case", "invalid_input"],
  ])("%s is not forwarded", (_name, code) => {
    const outcome = outcomeFor(new FakeScanError(code, SECRET));
    expect(outcome).toEqual({ outcome: "blocked", reason: "core_error" });
    expect(Object.keys(outcome)).toEqual(["outcome", "reason"]);
    expect(JSON.stringify(outcome)).not.toContain(SECRET);
  });

  test("a code getter that throws is core_error without a code, and nothing escapes", () => {
    const error = Object.defineProperty(new Error("synthetic"), "code", {
      get() {
        throw new Error(SECRET);
      },
    });
    expect(() => outcomeFor(error)).not.toThrow();
    expect(outcomeFor(error)).toEqual({ outcome: "blocked", reason: "core_error" });
  });
});
