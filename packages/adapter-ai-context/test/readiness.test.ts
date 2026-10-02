/**
 * The explicit readiness check (redact-secret/redact-secret-adapters#182)
 * against a mocked core, so each failure the real core cannot be made to
 * produce on demand is covered. The real core is covered in
 * `readiness-live.test.ts`.
 */

import { beforeEach, expect, test, vi } from "vitest";

const SENTINEL = "SENTINEL_SECRET_VALUE_123 /Users/sentinel/path";

const core = vi.hoisted(() => ({
  importFails: false,
  calls: [] as unknown[],
  scans: [] as string[],
  initializeError: undefined as (() => unknown) | undefined,
  identity: undefined as string | undefined,
  hasIdentity: true,
  scan: undefined as ((text: string) => unknown) | undefined,
  noInitialize: false,
}));

vi.mock("@redact-secret/core", () => {
  const module: Record<string, unknown> = {};
  Object.defineProperty(module, "initialize", {
    enumerable: true,
    get: () =>
      core.importFails || core.noInitialize
        ? undefined
        : async (options?: unknown) => {
            core.calls.push(options);
            if (core.initializeError !== undefined) throw core.initializeError();
          },
  });
  Object.defineProperty(module, "scanAndRedact", {
    enumerable: true,
    get: () => (text: string) => {
      core.scans.push(text);
      if (core.scan !== undefined) return core.scan(text);
      return { text: text.replace(/ghp_\w+/, "<SECRET_1>"), findings: [{ action: "redact" }] };
    },
  });
  Object.defineProperty(module, "piiActivation", {
    enumerable: true,
    get: () => (core.hasIdentity ? () => core.identity : undefined),
  });
  return module;
});

const { checkAiContextReady, createAiContextBoundary, READINESS_STATUSES } = await import("../src/index.js");

const PII_ON = "credentials=full;selectors=pii:global;families=pii:global:email;vocabulary=pii-context/v2";
const PII_OFF = "credentials=full;selectors=off;families=;vocabulary=pii-context/v2";

beforeEach(() => {
  core.importFails = false;
  core.noInitialize = false;
  core.calls.length = 0;
  core.scans.length = 0;
  core.initializeError = undefined;
  core.identity = undefined;
  core.hasIdentity = true;
  core.scan = undefined;
});

function leaks(value: unknown): boolean {
  const text = JSON.stringify(value);
  return text.includes("SENTINEL") || text.includes("/Users") || text.includes("ghp_");
}

test("success: ready, with the core's public activation identity", async () => {
  core.identity = PII_ON;
  const outcome = await checkAiContextReady({ pii: ["pii:global"] });
  expect(outcome).toEqual({ ready: true, status: "ready", core: "ok", pii: "ok", probe: "ok", activation: PII_ON });
  expect(core.calls).toEqual([{ pii: ["pii:global"] }]);
  expect(core.scans).toHaveLength(1);
  expect(Object.isFrozen(outcome)).toBe(true);
});

test("success without pii: an application's own activation is accepted and reported", async () => {
  core.identity = PII_OFF;
  core.initializeError = () => Object.assign(new Error(SENTINEL), { code: "PII_ACTIVATION_CONFLICT" });
  expect(await checkAiContextReady()).toEqual({
    ready: true,
    status: "ready",
    core: "ok",
    pii: "skipped",
    probe: "ok",
    activation: PII_OFF,
  });
});

test("a core that reports no activation is ready without one", async () => {
  core.hasIdentity = false;
  expect(await checkAiContextReady()).toEqual({
    ready: true,
    status: "ready",
    core: "ok",
    pii: "skipped",
    probe: "ok",
  });
});

test("an activation identity outside the documented shape is not reported", async () => {
  core.identity = `credentials=full;selectors=off;${SENTINEL}`;
  const outcome = await checkAiContextReady();
  expect(outcome.status).toBe("ready");
  expect(outcome).not.toHaveProperty("activation");
});

test("initialization failure: fixed status, no exception text", async () => {
  core.initializeError = () => Object.assign(new Error(SENTINEL), { code: "INITIALIZATION_FAILED" });
  const outcome = await checkAiContextReady();
  expect(outcome).toEqual({
    ready: false,
    status: "initialization_failed",
    core: "failed",
    pii: "skipped",
    probe: "skipped",
  });
  expect(leaks(outcome)).toBe(false);
  expect(core.scans).toEqual([]);
});

test("unsupported explicit PII selection", async () => {
  core.hasIdentity = false;
  const outcome = await checkAiContextReady({ pii: ["pii:global"] });
  expect(outcome).toEqual({
    ready: false,
    status: "pii_activation_unsupported",
    core: "ok",
    pii: "failed",
    probe: "skipped",
  });
  expect(core.calls).toEqual([]);
});

test("conflicting explicit PII selection", async () => {
  core.identity = PII_OFF;
  core.initializeError = () => Object.assign(new Error(SENTINEL), { code: "PII_ACTIVATION_CONFLICT" });
  const outcome = await checkAiContextReady({ pii: ["pii:global"] });
  expect(outcome.status).toBe("pii_activation_not_active");
  expect(outcome.ready).toBe(false);
  expect(leaks(outcome)).toBe(false);
});

test.each([
  ["not an object", () => "text"],
  ["null", () => null],
  ["no findings array", () => ({ text: "x" })],
  ["no text", () => ({ findings: [] })],
])("malformed core response (%s)", async (_name, scan) => {
  core.scan = scan;
  const outcome = await checkAiContextReady();
  expect(outcome).toMatchObject({ ready: false, status: "malformed_response", probe: "failed" });
});

test("a core without initialize is a malformed response, not a throw", async () => {
  core.noInitialize = true;
  expect(await checkAiContextReady()).toMatchObject({ ready: false, status: "malformed_response", core: "skipped" });
});

test("a probe the core cannot scan, or leaves in plaintext, is not ready", async () => {
  core.scan = () => {
    throw Object.assign(new Error(SENTINEL), { code: "INPUT_TOO_LARGE" });
  };
  const failed = await checkAiContextReady();
  expect(failed).toMatchObject({ ready: false, status: "probe_failed" });
  expect(leaks(failed)).toBe(false);

  core.scan = (text) => ({ text, findings: [] });
  expect(await checkAiContextReady()).toMatchObject({ ready: false, status: "probe_not_redacted" });
  core.scan = (text) => ({ text, findings: [{ action: "warn" }] });
  expect(await checkAiContextReady()).toMatchObject({ ready: false, status: "probe_not_redacted" });
});

test("malformed options are a fixed status and never touch the core", async () => {
  for (const options of [
    null,
    "x",
    { pii: "pii:global" },
    { pii: [1] },
    {
      get pii(): never {
        throw new Error(SENTINEL);
      },
    },
  ]) {
    const outcome = await checkAiContextReady(options as never);
    expect(outcome).toMatchObject({ ready: false, status: "invalid_options" });
    expect(leaks(outcome)).toBe(false);
  }
  expect(core.calls).toEqual([]);
});

test("every result uses a documented status, whatever the core throws", async () => {
  core.initializeError = () => ({
    get code(): never {
      throw new Error(SENTINEL);
    },
  });
  const outcome = await checkAiContextReady();
  expect(READINESS_STATUSES).toContain(outcome.status);
  expect(leaks(outcome)).toBe(false);
});

test("a failed check never makes later operations pass plaintext", async () => {
  core.initializeError = () => Object.assign(new Error(SENTINEL), { code: "INITIALIZATION_FAILED" });
  expect((await checkAiContextReady()).ready).toBe(false);
  const boundary = await createAiContextBoundary();
  const text = "ghp_SYNTHETICREVOKED00000000000000000000";
  expect(boundary.sanitizeText(text)).toMatchObject({ outcome: "blocked", reason: "core_error" });
  // And a retry is simply another call; once the cause clears it is ready.
  core.initializeError = undefined;
  expect((await checkAiContextReady()).ready).toBe(true);
});
