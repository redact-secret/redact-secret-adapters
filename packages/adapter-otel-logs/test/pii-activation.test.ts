/**
 * The live log-record-processor factory against a mocked core, for the
 * process-wide PII activation contract (redact-secret/redact-secret-adapters#51,
 * #178).
 *
 * Mocked rather than live: the selection cell is one-shot per process, so a
 * real core could serve exactly one of these orderings per run. The real core,
 * with PII off and on, is covered one process each in `./pii-live.test.ts`.
 *
 * Secrets are the deterministic fake's magic strings, built at runtime.
 */

import { beforeEach, expect, test, vi } from "vitest";

import { memoryExporter, providerWith, settle, simpleProcessor } from "./host.js";

const core = vi.hoisted(() => ({
  calls: [] as unknown[],
  rejectWith: undefined as (() => Error) | undefined,
  identity: undefined as string | undefined,
}));

vi.mock("@redact-secret/core", async () => {
  const { fakeScanAndRedact } = await import("../../../fixtures/fake-scanner.js");
  const module: Record<string, unknown> = {
    initialize: async (options?: unknown) => {
      core.calls.push(options);
      if (core.rejectWith !== undefined) throw core.rejectWith();
    },
    scanAndRedact: (text: string) => fakeScanAndRedact(text),
    createIncrementalSanitizer: () => {
      throw new Error("must not be reached");
    },
  };
  Object.defineProperty(module, "piiActivation", {
    configurable: true,
    enumerable: true,
    get: () => (core.identity === undefined ? undefined : () => core.identity),
  });
  return module;
});

const { createRedactingLogRecordProcessor } = await import("../src/index.js");

const PII_ON = "credentials=full;selectors=pii:global;families=pii:global:email;vocabulary=pii-context/v2";
const PII_OFF = "credentials=full;selectors=off;families=;vocabulary=pii-context/v2";

function conflict(): Error {
  return Object.assign(new Error("a different PII selection is already active"), {
    code: "PII_ACTIVATION_CONFLICT",
  });
}

beforeEach(() => {
  core.calls.length = 0;
  core.rejectWith = undefined;
  core.identity = undefined;
});

/** One record through a real SDK pipeline over the processor under test. */
async function exportOne(options: Parameters<typeof createRedactingLogRecordProcessor>[1]) {
  const exporter = memoryExporter();
  const processor = await createRedactingLogRecordProcessor(simpleProcessor(exporter), options);
  const provider = providerWith(processor);
  provider.getLogger("adapter-otel-logs-pii-activation-test").emit({ body: "call SECRET_TOKEN_1" });
  await settle();
  const body = exporter.records[0]?.body;
  await provider.shutdown();
  return body;
}

test("application first: the adapter absorbs the conflict and still masks", async () => {
  core.identity = PII_ON;
  core.rejectWith = conflict;
  expect(await exportOne({})).toBe("call <SECRET_1>");
  expect(core.calls).toEqual([undefined]);
});

test("adapter first: pii is forwarded to initialize", async () => {
  core.identity = PII_ON;
  expect(await exportOne({ pii: ["pii:global"] })).toBe("call <SECRET_1>");
  expect(core.calls).toEqual([{ pii: ["pii:global"] }]);
});

test("an activation that does not reflect the request is refused with a fixed code", async () => {
  core.identity = PII_OFF;
  const refusal = await createRedactingLogRecordProcessor(simpleProcessor(memoryExporter()), {
    pii: ["pii:global"],
  }).catch((error: unknown) => error);
  expect((refusal as { code?: string }).code).toBe("PII_ACTIVATION_NOT_ACTIVE");
  expect((refusal as Error).message).not.toContain("pii:global");
});

test("a core without piiActivation fails clearly when pii is passed, and is never initialized", async () => {
  const refusal = await createRedactingLogRecordProcessor(simpleProcessor(memoryExporter()), {
    pii: ["pii:global"],
  }).catch((error: unknown) => error);
  expect((refusal as { code?: string }).code).toBe("PII_ACTIVATION_UNSUPPORTED");
  expect(core.calls).toEqual([]);
});

test("a core without piiActivation is unchanged when pii is omitted: the declared floor still works", async () => {
  expect(await exportOne({})).toBe("call <SECRET_1>");
  expect(core.calls).toEqual([undefined]);
});

test("every other initialization failure still rejects, exactly as before", async () => {
  const failure = Object.assign(new Error("artifact missing near SECRET_TOKEN_1"), {
    code: "INITIALIZATION_FAILED",
  });
  core.rejectWith = () => failure;
  await expect(createRedactingLogRecordProcessor(simpleProcessor(memoryExporter()))).rejects.toBe(failure);
});
