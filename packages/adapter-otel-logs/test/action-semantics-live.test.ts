/**
 * The policy action truth table for the OpenTelemetry log record processor
 * (redact-secret/redact-secret-adapters#214, `docs/action-semantics.md`): the
 * exact body and attributes a real exporter receives for each of allow / warn /
 * redact / block, for a core failure, and for a limit, on the real installed
 * core and a real logger provider with the legacy callback `policy`. Every
 * expected value is spelled out. Values are synthetic and the credential is
 * built at runtime.
 */

import { describe, expect, test } from "vitest";

import { INVALID_POLICY, policyFor, SYNTHETIC_TOKEN, THROWING_POLICY } from "../../../fixtures/action-semantics.js";
import { createRedactingLogRecordProcessor, type OtelLogRecordOutcome } from "../src/index.js";
import { memoryExporter, providerWith, settle, simpleProcessor } from "./host.js";

type Options = NonNullable<Parameters<typeof createRedactingLogRecordProcessor>[1]>;

const T = SYNTHETIC_TOKEN;

async function exportRecord(options: Options): Promise<{
  body: unknown;
  attributes: unknown;
  outcome: OtelLogRecordOutcome | undefined;
}> {
  const exporter = memoryExporter();
  let outcome: OtelLogRecordOutcome | undefined;
  const processor = await createRedactingLogRecordProcessor(simpleProcessor(exporter), {
    ...options,
    onOutcome: (o) => {
      outcome = o;
    },
  });
  const provider = providerWith(processor);
  provider.getLogger("action-semantics").emit({ body: `b ${T}`, attributes: { k: `x ${T} y`, clean: "plain" } });
  await settle();
  const [record] = exporter.records;
  if (record === undefined) throw new Error("no record exported");
  const exported = { body: record.body, attributes: { ...record.attributes }, outcome };
  await provider.shutdown();
  return exported;
}

describe("log record processor: one finding per value, one policy action", () => {
  test.each([
    // allow and warn leave every value in the exported record.
    ["allow", `b ${T}`, { k: `x ${T} y`, clean: "plain" }],
    ["warn", `b ${T}`, { k: `x ${T} y`, clean: "plain" }],
    ["redact", "b <SECRET_1>", { k: "x <SECRET_1> y", clean: "plain" }],
    // block replaces each WHOLE value, not just the matched part.
    ["block", "[REDACTED:BLOCKED]", { k: "[REDACTED:BLOCKED]", clean: "plain" }],
  ] as const)("%s", async (action, body, attributes) => {
    const exported = await exportRecord({ policy: policyFor(action) });
    expect(exported.body).toBe(body);
    expect(exported.attributes).toEqual(attributes);
  });

  test("the outcome counts what each action did; allow and warn are findings with no redaction", async () => {
    const values = async (action: Parameters<typeof policyFor>[0]) =>
      (await exportRecord({ policy: policyFor(action) })).outcome?.values;
    expect(await values("allow")).toEqual({ scanned: 3, findings: 2, redacted: 0, blocked: 0, limited: 0, failed: 0 });
    expect(await values("warn")).toEqual({ scanned: 3, findings: 2, redacted: 0, blocked: 0, limited: 0, failed: 0 });
    expect(await values("redact")).toEqual({ scanned: 3, findings: 2, redacted: 2, blocked: 0, limited: 0, failed: 0 });
    expect(await values("block")).toEqual({ scanned: 3, findings: 2, redacted: 0, blocked: 2, limited: 0, failed: 0 });
  });
});

describe("log record processor: failure and limits never fall back to plaintext", () => {
  test.each([
    ["a throwing policy", THROWING_POLICY],
    ["a policy that returns a non-action", INVALID_POLICY],
  ] as const)("%s is the fixed error marker; the record is still forwarded", async (_name, policy) => {
    const exported = await exportRecord({ policy });
    expect(exported.body).toBe("[REDACTED:ERROR]");
    expect(exported.attributes).toEqual({ k: "[REDACTED:ERROR]", clean: "plain" });
    expect(exported.outcome?.values.failed).toBe(2);
    expect(exported.outcome?.dropped).toBe(false);
  });

  test("a value past maxStringLength is the limit marker and is not scanned", async () => {
    const exported = await exportRecord({ limits: { maxStringLength: 12 } });
    expect(exported.body).toBe("[REDACTED:LIMIT_EXCEEDED]");
    expect(exported.attributes).toEqual({ k: "[REDACTED:LIMIT_EXCEEDED]", clean: "plain" });
    expect(exported.outcome?.values).toMatchObject({ limited: 2, scanned: 1 });
  });
});

describe("log record processor: observation mode", () => {
  test("warn everywhere changes nothing in the exported record and counts every finding", async () => {
    const exported = await exportRecord({ policy: policyFor("warn") });
    expect(exported.body).toBe(`b ${T}`);
    expect(exported.outcome?.values).toEqual({
      scanned: 3,
      findings: 2,
      redacted: 0,
      blocked: 0,
      limited: 0,
      failed: 0,
    });
  });
});
