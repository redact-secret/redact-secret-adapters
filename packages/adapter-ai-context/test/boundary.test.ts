/**
 * The boundary over a fake core (`fake-core.ts`): outcome mapping, the
 * safe-metadata allowlist, fixed input-free failures, traversal limits,
 * cancellation, and the stream lifecycle. Every value is synthetic.
 * `conformance*.test.ts` and `e2e.test.ts` run the same boundary on the real
 * core.
 */

import { describe, expect, test } from "vitest";

import {
  type AiContextBoundaryOptions,
  type AiContextOutcome,
  BLOCK_REASONS,
  createAiContextBoundaryWith,
  SAFE_FINDING_FIELDS,
  type SafeFinding,
} from "../src/index.js";
import { createFakeCore, FakeScanError, LIMITS } from "./fake-core.js";

const SECRET = "SECRET_TOKEN_7";

function setup(overrides: Partial<AiContextBoundaryOptions> = {}, fake = createFakeCore()) {
  const events: { finding: SafeFinding; context: object }[] = [];
  const boundary = createAiContextBoundaryWith(fake.core, {
    ...LIMITS,
    onFinding: (finding, context) => events.push({ finding, context }),
    ...overrides,
  });
  return { boundary, events, calls: fake.calls };
}

/** No plaintext marker may reach metadata, and a non-ok outcome carries nothing but its shape. */
function expectInputFree(outcome: AiContextOutcome<unknown>, events: unknown[] = []): void {
  const metadata = JSON.stringify({ ...outcome, value: undefined }) + JSON.stringify(events);
  for (const marker of [SECRET, "BLOCK_ME", "BOOM", "fake core failure", "near"]) {
    expect(metadata.includes(marker), marker).toBe(false);
  }
  if (outcome.outcome !== "ok") {
    for (const key of Object.keys(outcome)) expect(["outcome", "reason", "code"]).toContain(key);
  }
}

describe("sanitizeText", () => {
  test("allow, redact, warn and block map onto ok / ok / ok / blocked-policy", () => {
    const { boundary } = setup();
    expect(boundary.sanitizeText("plain text")).toEqual({ outcome: "ok", value: "plain text", findings: [] });

    const redacted = boundary.sanitizeText(`token ${SECRET} end`);
    expect(redacted.outcome).toBe("ok");
    if (redacted.outcome !== "ok") throw new Error("unreachable");
    expect(redacted.value).toBe("token <SECRET_1> end");
    expect(redacted.findings.map((f) => f.action)).toEqual(["redact"]);

    const warned = boundary.sanitizeText("WARN_ME here");
    expect(warned).toMatchObject({ outcome: "ok", value: "WARN_ME here" });

    const blockedOutcome = boundary.sanitizeText("BLOCK_ME here");
    expect(blockedOutcome).toEqual({ outcome: "blocked", reason: "policy" });
    expectInputFree(blockedOutcome);
  });

  test("findings are copied by allowlist: extra core fields, including plaintext, never cross", () => {
    const { boundary, events } = setup();
    const outcome = boundary.sanitizeText(`token ${SECRET}`, { boundary: "user-input" });
    if (outcome.outcome !== "ok") throw new Error("expected ok");
    for (const finding of [...outcome.findings, ...events.map((e) => e.finding)]) {
      expect(Object.keys(finding).sort()).toEqual([...SAFE_FINDING_FIELDS].sort());
      expect(Object.isFrozen(finding)).toBe(true);
    }
    expectInputFree(outcome, events);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.findings)).toBe(true);
  });

  test("a non-string input is unsupported_value and never reaches the core", () => {
    const { boundary, calls } = setup();
    for (const input of [undefined, null, 42, {}, ["x"]]) {
      expect(boundary.sanitizeText(input as unknown as string)).toEqual({
        outcome: "blocked",
        reason: "unsupported_value",
      });
    }
    expect(calls.scans).toEqual([]);
  });
});

describe("fixed, input-free failures", () => {
  const cases: [string, unknown, object][] = [
    [
      "a limit code",
      new FakeScanError("INPUT_LIMIT_EXCEEDED", SECRET),
      { reason: "limit_exceeded", code: "INPUT_LIMIT_EXCEEDED" },
    ],
    [
      "FINDING_LIMIT_EXCEEDED",
      new FakeScanError("FINDING_LIMIT_EXCEEDED", SECRET),
      { reason: "limit_exceeded", code: "FINDING_LIMIT_EXCEEDED" },
    ],
    [
      "BUFFER_LIMIT_EXCEEDED",
      new FakeScanError("BUFFER_LIMIT_EXCEEDED", SECRET),
      { reason: "limit_exceeded", code: "BUFFER_LIMIT_EXCEEDED" },
    ],
    [
      "TOKEN_LIMIT_EXCEEDED",
      new FakeScanError("TOKEN_LIMIT_EXCEEDED", SECRET),
      { reason: "limit_exceeded", code: "TOKEN_LIMIT_EXCEEDED" },
    ],
    [
      "MULTILINE_LIMIT_EXCEEDED",
      new FakeScanError("MULTILINE_LIMIT_EXCEEDED", SECRET),
      { reason: "limit_exceeded", code: "MULTILINE_LIMIT_EXCEEDED" },
    ],
    ["INVALID_STATE", new FakeScanError("INVALID_STATE", SECRET), { reason: "lifecycle", code: "INVALID_STATE" }],
    [
      "NOT_INITIALIZED",
      new FakeScanError("NOT_INITIALIZED", SECRET),
      { reason: "core_error", code: "NOT_INITIALIZED" },
    ],
    [
      "INITIALIZATION_FAILED",
      new FakeScanError("INITIALIZATION_FAILED", SECRET),
      { reason: "core_error", code: "INITIALIZATION_FAILED" },
    ],
    ["INVALID_LIMITS", new FakeScanError("INVALID_LIMITS", SECRET), { reason: "core_error", code: "INVALID_LIMITS" }],
    ["a code outside the registry", new FakeScanError(`LEAK_${SECRET}`, SECRET), { reason: "core_error" }],
    ["an error with no code", new Error(`plain failure near ${SECRET}`), { reason: "core_error" }],
    ["a thrown string", `thrown ${SECRET}`, { reason: "core_error" }],
    ["a thrown null", null, { reason: "core_error" }],
    [
      "an error whose code getter throws",
      Object.defineProperty(new Error(SECRET), "code", {
        get() {
          throw new Error(SECRET);
        },
      }),
      { reason: "core_error" },
    ],
  ];
  test.each(cases)("%s maps to a fixed outcome and never forwards a message", (_name, error, expected) => {
    const { boundary } = setup({}, createFakeCore({ scanFailures: { FAIL_HERE: error } }));
    const outcome = boundary.sanitizeText(`FAIL_HERE ${SECRET}`);
    expect(outcome).toEqual({ outcome: "blocked", ...expected });
    expectInputFree(outcome);
  });

  test("a result not shaped like { text, findings } is core_error, never passed on", () => {
    for (const malformed of [
      undefined,
      null,
      "text",
      { text: 1, findings: [] },
      { text: "x" },
      { text: "x", findings: [null] },
    ]) {
      const { boundary } = setup({}, createFakeCore({ malformed: { ODD: malformed } }));
      expect(boundary.sanitizeText(`ODD ${SECRET}`)).toEqual({ outcome: "blocked", reason: "core_error" });
    }
  });

  test("a throwing policy fails closed as core_error / POLICY_FAILURE", () => {
    const { boundary, events } = setup({
      policy: {
        evaluate() {
          throw new Error(`policy saw ${SECRET}`);
        },
      },
    });
    const outcome = boundary.sanitizeText(`token ${SECRET}`);
    expect(outcome).toEqual({ outcome: "blocked", reason: "core_error", code: "POLICY_FAILURE" });
    expect(events).toEqual([]);
    expectInputFree(outcome);
  });

  test("a throwing placeholder formatter fails closed as core_error / PLACEHOLDER_FAILURE", () => {
    const { boundary } = setup({
      placeholderFormatter() {
        throw new Error(`formatter saw ${SECRET}`);
      },
    });
    expect(boundary.sanitizeText(`token ${SECRET}`)).toEqual({
      outcome: "blocked",
      reason: "core_error",
      code: "PLACEHOLDER_FAILURE",
    });
  });

  test("every reason this package can produce is in the frozen reason set", () => {
    expect(BLOCK_REASONS).toEqual(["policy", "limit_exceeded", "unsupported_value", "lifecycle", "core_error"]);
    expect(Object.isFrozen(BLOCK_REASONS)).toBe(true);
    expect(Object.isFrozen(SAFE_FINDING_FIELDS)).toBe(true);
  });
});

describe("telemetry", () => {
  test("one call per finding, in scan order, with exactly { boundary }; defaults to context", () => {
    const { boundary, events } = setup();
    boundary.sanitizeText(`a ${SECRET}`, { boundary: "user-input" });
    boundary.sanitizeText("WARN_ME");
    expect(events.map((e) => e.context)).toEqual([{ boundary: "user-input" }, { boundary: "context" }]);
    expect(events.map((e) => e.finding.action)).toEqual(["redact", "warn"]);
    for (const event of events) expect(Object.isFrozen(event.context)).toBe(true);
  });

  test("tool-arguments is a telemetry label like any other and never changes an outcome", () => {
    const { boundary, events } = setup();
    const args = { query: `deploy ${SECRET}` };
    const labelled = boundary.sanitizeValue(args, { boundary: "tool-arguments" });
    const unlabelled = boundary.sanitizeValue(args);
    expect(labelled).toEqual(unlabelled);
    expect(boundary.sanitizeValue({ query: "BLOCK_ME" }, { boundary: "tool-arguments" })).toEqual({
      outcome: "blocked",
      reason: "policy",
    });
    expect(events.map((e) => e.context)).toEqual([
      { boundary: "tool-arguments" },
      { boundary: "context" },
      { boundary: "tool-arguments" },
    ]);
  });

  test("a blocked scan still reports its findings to telemetry, never in the outcome", () => {
    const { boundary, events } = setup();
    const outcome = boundary.sanitizeText("BLOCK_ME");
    expect(outcome).toEqual({ outcome: "blocked", reason: "policy" });
    expect(events.map((e) => e.finding.action)).toEqual(["block"]);
  });

  test("a throwing callback is swallowed and never changes the outcome", () => {
    const fake = createFakeCore();
    let calls = 0;
    const boundary = createAiContextBoundaryWith(fake.core, {
      ...LIMITS,
      onFinding() {
        calls += 1;
        throw new Error(`telemetry saw ${SECRET}`);
      },
    });
    expect(boundary.sanitizeText(`a ${SECRET}`)).toMatchObject({ outcome: "ok", value: "a <SECRET_1>" });
    expect(boundary.sanitizeValue({ k: `a ${SECRET}` })).toMatchObject({ outcome: "ok" });
    const stream = boundary.openStream();
    stream.append(`a ${SECRET}`);
    expect(stream.finalize()).toMatchObject({ outcome: "ok", value: "a <SECRET_1>" });
    expect(calls).toBe(3);
  });
});

describe("cancellation", () => {
  test("an already-aborted signal ends every operation before any scan or session", () => {
    const { boundary, calls } = setup();
    const signal = AbortSignal.abort();
    expect(boundary.sanitizeText(SECRET, { signal })).toEqual({ outcome: "aborted" });
    expect(boundary.sanitizeValue({ a: SECRET }, { signal })).toEqual({ outcome: "aborted" });
    expect(boundary.sanitizeToolResult(SECRET, { signal })).toEqual({ outcome: "aborted" });
    expect(boundary.buildContext([{ role: "user", text: SECRET }], { signal })).toEqual({ outcome: "aborted" });
    const stream = boundary.openStream({ signal });
    stream.append(SECRET);
    expect(stream.finalize()).toEqual({ outcome: "aborted" });
    expect(calls.scans).toEqual([]);
    expect(calls.sessions).toEqual([]);
  });

  test("a signal that fires during a scan is checked again after it: the result is discarded", () => {
    const controller = new AbortController();
    const { boundary } = setup({
      policy: {
        evaluate() {
          controller.abort();
          return "redact";
        },
      },
    });
    expect(boundary.sanitizeText(`a ${SECRET}`, { signal: controller.signal })).toEqual({ outcome: "aborted" });
  });

  test("a signal that fires between context parts discards the parts already sanitized", () => {
    const controller = new AbortController();
    const fake = createFakeCore();
    const boundary = createAiContextBoundaryWith(fake.core, {
      ...LIMITS,
      onFinding: () => controller.abort(),
    });
    const outcome = boundary.buildContext(
      [
        { role: "user", text: `a ${SECRET}` },
        { role: "tool", text: "second part" },
      ],
      { signal: controller.signal },
    );
    expect(outcome).toEqual({ outcome: "aborted" });
    expect(fake.calls.scans).toEqual([`a ${SECRET}`]);
  });

  test("a signal whose aborted flag cannot be read is treated as aborted", () => {
    const { boundary, calls } = setup();
    const signal = {
      get aborted(): boolean {
        throw new Error("unreadable");
      },
    };
    expect(boundary.sanitizeText(SECRET, { signal })).toEqual({ outcome: "aborted" });
    expect(calls.scans).toEqual([]);
  });
});

describe("sanitizeValue", () => {
  test("redacts every string leaf and keeps the shape; findings are per leaf", () => {
    const { boundary } = setup();
    const input = { a: `x ${SECRET}`, b: [1, true, null, { c: "WARN_ME" }] };
    const outcome = boundary.sanitizeValue(input, { boundary: "tool-result" });
    expect(outcome).toMatchObject({
      outcome: "ok",
      value: { a: "x <SECRET_1>", b: [1, true, null, { c: "WARN_ME" }] },
    });
    if (outcome.outcome !== "ok") throw new Error("unreachable");
    expect(outcome.findings.map((f) => f.action)).toEqual(["redact", "warn"]);
    expect(outcome.value).not.toBe(input);
    expect(input.a).toBe(`x ${SECRET}`);
  });

  test("any block leaf blocks the whole value", () => {
    const { boundary } = setup();
    expect(boundary.sanitizeValue({ ok: "fine", nested: ["BLOCK_ME"] })).toEqual({
      outcome: "blocked",
      reason: "policy",
    });
  });

  test("keys are scanned: a redact or block key blocks the value; a warn key passes unchanged", () => {
    const { boundary, events } = setup();
    expect(boundary.sanitizeValue({ [SECRET]: "value" })).toEqual({ outcome: "blocked", reason: "policy" });
    expect(boundary.sanitizeValue({ BLOCK_ME: "value" })).toEqual({ outcome: "blocked", reason: "policy" });
    expect(boundary.sanitizeValue({ WARN_ME: "value" })).toMatchObject({ outcome: "ok", value: { WARN_ME: "value" } });
    expect(events.map((e) => e.finding.action)).toEqual(["redact", "block", "warn"]);
  });

  test("a core failure on any leaf or key fails the whole value with the mapped reason", () => {
    const { boundary } = setup();
    expect(boundary.sanitizeValue({ a: "fine", b: "BOOM" })).toEqual({
      outcome: "blocked",
      reason: "core_error",
      code: "DETECTOR_FAILURE",
    });
    expect(boundary.sanitizeValue({ BOOM: "fine" })).toEqual({
      outcome: "blocked",
      reason: "core_error",
      code: "DETECTOR_FAILURE",
    });
    expect(boundary.sanitizeValue({ a: "x".repeat(300) })).toEqual({
      outcome: "blocked",
      reason: "limit_exceeded",
      code: "INPUT_LIMIT_EXCEEDED",
    });
  });

  class Custom {
    field = SECRET;
  }
  const revoked = Proxy.revocable({}, {});
  revoked.revoke();
  const unsupported: [string, unknown][] = [
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["a bigint", 10n],
    ["a symbol", Symbol("s")],
    ["a function", () => SECRET],
    ["a Date", new Date(0)],
    ["a Map", new Map([["k", SECRET]])],
    ["a class instance", new Custom()],
    ["a boxed string", new String(SECRET)],
    ["an Error", new Error(SECRET)],
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test.
    ["an array hole", [1, , 3]],
    ["a nested undefined", { a: { b: undefined } }],
    ["a revoked Proxy", revoked.proxy],
    [
      "a throwing getter",
      Object.defineProperty({}, "k", {
        enumerable: true,
        get() {
          throw new Error(SECRET);
        },
      }),
    ],
  ];
  test.each(unsupported)("%s is unsupported_value, never passed through", (_name, value) => {
    const { boundary } = setup();
    const outcome = boundary.sanitizeValue(value);
    expect(outcome).toEqual({ outcome: "blocked", reason: "unsupported_value" });
    expectInputFree(outcome);
  });

  test("a cycle is unsupported_value; the same object reached twice without a cycle is fine", () => {
    const { boundary } = setup();
    const cyclic: Record<string, unknown> = { a: "x" };
    cyclic.self = cyclic;
    expect(boundary.sanitizeValue(cyclic)).toEqual({ outcome: "blocked", reason: "unsupported_value" });
    const shared = { s: "y" };
    expect(boundary.sanitizeValue({ one: shared, two: shared })).toMatchObject({
      outcome: "ok",
      value: { one: { s: "y" }, two: { s: "y" } },
    });
  });

  test("maxDepth counts containers including the root, exactly", () => {
    const { boundary } = setup(); // maxDepth 3
    expect(boundary.sanitizeValue({ a: { b: { c: "leaf" } } })).toMatchObject({ outcome: "ok" });
    expect(boundary.sanitizeValue({ a: { b: { c: { d: "leaf" } } } })).toEqual({
      outcome: "blocked",
      reason: "limit_exceeded",
    });
    expect(boundary.sanitizeValue([[[[]]]])).toEqual({ outcome: "blocked", reason: "limit_exceeded" });
    expect(boundary.sanitizeValue("a bare string has depth 0")).toMatchObject({ outcome: "ok" });
  });

  test("maxNodes counts every visited value, exactly, and fails before scanning past it", () => {
    const { boundary, calls } = setup(); // maxNodes 16: the root array plus 15 items
    expect(boundary.sanitizeValue(Array.from({ length: 15 }, () => "x"))).toMatchObject({ outcome: "ok" });
    const before = calls.scans.length;
    expect(boundary.sanitizeValue(Array.from({ length: 16 }, () => "x"))).toEqual({
      outcome: "blocked",
      reason: "limit_exceeded",
    });
    expect(calls.scans.length - before).toBe(15);
  });

  test("a __proto__ key is copied as data, never as a prototype", () => {
    const { boundary } = setup();
    const input = JSON.parse('{"__proto__": {"polluted": "yes"}}');
    const outcome = boundary.sanitizeValue(input);
    if (outcome.outcome !== "ok") throw new Error("expected ok");
    expect(Object.getPrototypeOf(outcome.value)).toBe(Object.prototype);
    expect(Object.keys(outcome.value as object)).toEqual(["__proto__"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("sanitizeToolResult", () => {
  test("a string goes through sanitizeText and a structured result through sanitizeValue, labelled tool-result", () => {
    const { boundary, events } = setup();
    expect(boundary.sanitizeToolResult(`out ${SECRET}`)).toMatchObject({ outcome: "ok", value: "out <SECRET_1>" });
    expect(boundary.sanitizeToolResult({ content: [{ type: "text", text: `out ${SECRET}` }] })).toMatchObject({
      outcome: "ok",
      value: { content: [{ type: "text", text: "out <SECRET_1>" }] },
    });
    expect(boundary.sanitizeToolResult(undefined)).toEqual({ outcome: "blocked", reason: "unsupported_value" });
    expect(events.map((e) => e.context)).toEqual([{ boundary: "tool-result" }, { boundary: "tool-result" }]);
  });
});

describe("buildContext", () => {
  test("returns ordered { role, content } messages built only from sanitized parts", () => {
    const { boundary, events } = setup();
    const outcome = boundary.buildContext([
      { role: "system", text: "be brief" },
      { role: "user", boundary: "user-input", text: `use ${SECRET}` },
      { role: "tool", boundary: "tool-result", value: { rows: [`row ${SECRET}`] } },
    ]);
    expect(outcome).toMatchObject({
      outcome: "ok",
      value: [
        { role: "system", content: "be brief" },
        { role: "user", content: "use <SECRET_1>" },
        { role: "tool", content: { rows: ["row <SECRET_1>"] } },
      ],
    });
    expect(events.map((e) => e.context)).toEqual([{ boundary: "user-input" }, { boundary: "tool-result" }]);
    if (outcome.outcome !== "ok") throw new Error("unreachable");
    expect(Object.isFrozen(outcome.value)).toBe(true);
    expect(outcome.findings).toHaveLength(2);
  });

  test("is all-or-nothing: one non-ok part is the whole context's outcome", () => {
    const { boundary, calls } = setup();
    expect(
      boundary.buildContext([
        { role: "user", text: `use ${SECRET}` },
        { role: "tool", text: "BLOCK_ME" },
        { role: "tool", text: "never scanned" },
      ]),
    ).toEqual({ outcome: "blocked", reason: "policy" });
    expect(calls.scans).not.toContain("never scanned");
    expect(boundary.buildContext([{ role: "tool", value: { a: new Date(0) } }])).toEqual({
      outcome: "blocked",
      reason: "unsupported_value",
    });
    expect(boundary.buildContext([{ role: "tool", text: "BOOM" }])).toEqual({
      outcome: "blocked",
      reason: "core_error",
      code: "DETECTOR_FAILURE",
    });
  });

  test("malformed parts, and a non-string role, are unsupported_value", () => {
    const { boundary } = setup();
    for (const parts of [
      "not an array",
      [null],
      ["text"],
      [{ role: "user" }],
      [{ role: 1, text: "x" }],
      [{ text: "x" }],
      [{ role: "user", text: 42 }],
    ]) {
      expect(boundary.buildContext(parts as never)).toEqual({ outcome: "blocked", reason: "unsupported_value" });
    }
    expect(boundary.buildContext([])).toEqual({ outcome: "ok", value: [], findings: [] });
  });
});

describe("openStream", () => {
  test("stages everything: text the core releases from append is held until a successful finalize", () => {
    const fake = createFakeCore({ emitOnAppend: true });
    const { boundary } = setup({}, fake);
    const stream = boundary.openStream({ boundary: "tool-result" });
    stream.append("clean first chunk ");
    stream.append(`then ${SECRET}`);
    expect(stream.finalize()).toMatchObject({ outcome: "ok", value: `clean first chunk then <SECRET_1>` });
  });

  test("a block finding mid-stream aborts the core session at once; later appends are never scanned", () => {
    const fake = createFakeCore({ emitOnAppend: true });
    const { boundary } = setup({}, fake);
    const stream = boundary.openStream();
    stream.append("released text ");
    stream.append("BLOCK_ME");
    const session = fake.calls.sessions[0];
    expect(session?.aborted).toBe(true);
    stream.append(`late ${SECRET}`);
    expect(session?.appended).toEqual(["released text ", "BLOCK_ME"]);
    const outcome = stream.finalize();
    expect(outcome).toEqual({ outcome: "blocked", reason: "policy" });
    expectInputFree(outcome);
  });

  test.each([
    "INPUT_LIMIT_EXCEEDED",
    "BUFFER_LIMIT_EXCEEDED",
    "TOKEN_LIMIT_EXCEEDED",
    "MULTILINE_LIMIT_EXCEEDED",
  ] as const)("%s from append fails the stream closed and aborts the session", (code) => {
    const fake = createFakeCore({ appendFailures: { OVER: code } });
    const { boundary } = setup({}, fake);
    const stream = boundary.openStream();
    stream.append("ok so far ");
    stream.append(`OVER ${SECRET}`);
    stream.append("never scanned");
    expect(fake.calls.sessions[0]?.aborted).toBe(true);
    expect(fake.calls.sessions[0]?.appended).not.toContain("never scanned");
    const outcome = stream.finalize();
    expect(outcome).toEqual({ outcome: "blocked", reason: "limit_exceeded", code });
    expectInputFree(outcome);
  });

  test("a throwing policy mid-stream fails closed as core_error / POLICY_FAILURE", () => {
    const { boundary } = setup(
      {
        policy: {
          evaluate() {
            throw new Error(`policy saw ${SECRET}`);
          },
        },
      },
      createFakeCore({ emitOnAppend: true }),
    );
    const stream = boundary.openStream();
    stream.append(`a ${SECRET}`);
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "core_error", code: "POLICY_FAILURE" });
  });

  test("finalize is single-use: a second finalize is blocked / lifecycle and never re-releases", () => {
    const { boundary } = setup();
    const stream = boundary.openStream();
    stream.append(`a ${SECRET}`);
    expect(stream.finalize()).toMatchObject({ outcome: "ok", value: "a <SECRET_1>" });
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "lifecycle" });
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "lifecycle" });
  });

  test("append after finalize is discarded and never scanned; abort after finalize does nothing", () => {
    const fake = createFakeCore();
    const { boundary } = setup({}, fake);
    const stream = boundary.openStream();
    stream.append("first");
    const first = stream.finalize();
    stream.append(`late ${SECRET}`);
    stream.abort();
    expect(first).toEqual({ outcome: "ok", value: "first", findings: [] });
    expect(fake.calls.sessions[0]?.appended).toEqual(["first"]);
    expect(fake.calls.sessions[0]?.aborted).toBe(false);
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "lifecycle" });
  });

  test("abort discards staged text and aborts the core session; the next finalize is aborted", () => {
    const fake = createFakeCore();
    const { boundary } = setup({}, fake);
    const stream = boundary.openStream();
    stream.append(`staged ${SECRET}`);
    stream.abort();
    expect(fake.calls.sessions[0]?.aborted).toBe(true);
    stream.append("after abort");
    expect(fake.calls.sessions[0]?.appended).toEqual([`staged ${SECRET}`]);
    expect(stream.finalize()).toEqual({ outcome: "aborted" });
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "lifecycle" });
  });

  test("a real AbortSignal aborts the core session when it fires, not only on the next call", () => {
    const fake = createFakeCore();
    const { boundary } = setup({}, fake);
    const controller = new AbortController();
    const stream = boundary.openStream({ signal: controller.signal });
    stream.append(`staged ${SECRET}`);
    controller.abort();
    expect(fake.calls.sessions[0]?.aborted).toBe(true);
    expect(stream.finalize()).toEqual({ outcome: "aborted" });
  });

  test("a signal that fires after a successful finalize changes nothing", () => {
    const fake = createFakeCore();
    const { boundary } = setup({}, fake);
    const controller = new AbortController();
    const stream = boundary.openStream({ signal: controller.signal });
    stream.append("done");
    expect(stream.finalize()).toMatchObject({ outcome: "ok", value: "done" });
    controller.abort();
    expect(fake.calls.sessions[0]?.aborted).toBe(false);
  });

  test("a session that cannot be opened fails every finalize closed, input-free", () => {
    const fake = createFakeCore({ openFailure: new FakeScanError("INVALID_LIMITS", SECRET) });
    const { boundary } = setup({}, fake);
    const stream = boundary.openStream();
    stream.append(SECRET);
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "core_error", code: "INVALID_LIMITS" });
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "lifecycle" });
  });

  test("accepting is true until the stream fails, is aborted, or is finalized, and never says why", () => {
    const fake = createFakeCore({ emitOnAppend: true, appendFailures: { OVER: "INPUT_LIMIT_EXCEEDED" } });
    const { boundary } = setup({}, fake);
    const cases: [string, (stream: ReturnType<typeof boundary.openStream>) => void][] = [
      ["block", (stream) => stream.append("BLOCK_ME")],
      ["limit", (stream) => stream.append(`OVER ${SECRET}`)],
      ["non-string chunk", (stream) => stream.append(7 as unknown as string)],
      ["abort", (stream) => stream.abort()],
      ["finalize", (stream) => void stream.finalize()],
    ];
    for (const [name, end] of cases) {
      const stream = boundary.openStream();
      expect(stream.accepting, name).toBe(true);
      stream.append("clean ");
      expect(stream.accepting, name).toBe(true);
      end(stream);
      expect(stream.accepting, name).toBe(false);
      expect(Object.getOwnPropertyDescriptor(stream, "accepting")?.get, name).toBeTypeOf("function");
      expect(JSON.stringify(stream), name).not.toContain(SECRET);
    }
  });

  test("accepting turns false the moment a real AbortSignal fires, and is false for a pre-aborted or unopenable stream", () => {
    const { boundary } = setup();
    const controller = new AbortController();
    const stream = boundary.openStream({ signal: controller.signal });
    expect(stream.accepting).toBe(true);
    controller.abort();
    expect(stream.accepting).toBe(false);
    expect(boundary.openStream({ signal: { aborted: true } }).accepting).toBe(false);
    const unopenable = setup({}, createFakeCore({ openFailure: new FakeScanError("INVALID_LIMITS") })).boundary;
    expect(unopenable.openStream().accepting).toBe(false);
  });

  test("a non-string chunk fails the stream as unsupported_value", () => {
    const fake = createFakeCore();
    const { boundary } = setup({}, fake);
    const stream = boundary.openStream();
    stream.append(42 as unknown as string);
    expect(fake.calls.sessions[0]?.aborted).toBe(true);
    expect(stream.finalize()).toEqual({ outcome: "blocked", reason: "unsupported_value" });
  });
});

describe("options", () => {
  const { core } = createFakeCore();
  test.each([
    ["no options", undefined],
    ["no wholeInputLimits", { ...LIMITS, wholeInputLimits: undefined }],
    ["no incrementalLimits", { ...LIMITS, incrementalLimits: undefined }],
    ["no traversalLimits", { ...LIMITS, traversalLimits: undefined }],
    ["a fractional maxDepth", { ...LIMITS, traversalLimits: { maxDepth: 1.5, maxNodes: 4 } }],
    ["a negative maxNodes", { ...LIMITS, traversalLimits: { maxDepth: 1, maxNodes: -1 } }],
    ["a NaN maxNodes", { ...LIMITS, traversalLimits: { maxDepth: 1, maxNodes: Number.NaN } }],
    ["a non-function onFinding", { ...LIMITS, onFinding: "log" }],
  ])("%s throws a TypeError with a fixed message", (_name, options) => {
    expect(() => createAiContextBoundaryWith(core, options as never)).toThrow(TypeError);
  });

  test("the returned boundary and its streams are frozen", () => {
    const boundary = createAiContextBoundaryWith(core, LIMITS);
    expect(Object.isFrozen(boundary)).toBe(true);
    expect(Object.isFrozen(boundary.openStream())).toBe(true);
  });
});
