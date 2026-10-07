/**
 * The declarative `actionPolicy` through a real logger provider and the real
 * core (redact-secret-adapters#217): the exact body and attributes a real
 * exporter receives for each action, equal to the same action as a callback
 * policy (`action-semantics-live.test.ts`, #214), and unchanged by a later
 * mutation of the caller's document. The processor forwards the whole resolved
 * scan configuration (policy, actionPolicy and the core's other scan options)
 * to every leaf, which it did not before. Below the verified core floor the
 * option is rejected explicitly. Values are synthetic.
 */

import { CoreOptionsError } from "@redact-secret/adapter";
import { describe, expect, test } from "vitest";

import {
  actionPolicyForms,
  CORE_HAS_ACTION_POLICY,
  MALFORMED_MARKER,
  MALFORMED_POLICY,
  UNMATCHED_POLICY,
} from "../../../fixtures/action-policy.js";
import { SYNTHETIC_TOKEN } from "../../../fixtures/action-semantics.js";
import { createRedactingLogRecordProcessor } from "../src/index.js";
import { memoryExporter, providerWith, settle, simpleProcessor } from "./host.js";

type Options = NonNullable<Parameters<typeof createRedactingLogRecordProcessor>[1]>;

const T = SYNTHETIC_TOKEN;

async function exportRecord(options: Options) {
  const exporter = memoryExporter();
  const provider = providerWith(await createRedactingLogRecordProcessor(simpleProcessor(exporter), options));
  provider.getLogger("action-policy").emit({ body: `b ${T}`, attributes: { k: `x ${T} y`, clean: "plain" } });
  await settle();
  const [record] = exporter.records;
  if (record === undefined) throw new Error("no record exported");
  const exported = { body: record.body, attributes: { ...record.attributes } };
  await provider.shutdown();
  return exported;
}

const KEPT = { body: `b ${T}`, attributes: { k: `x ${T} y`, clean: "plain" } };
const REDACTED = { body: "b <SECRET_1>", attributes: { k: "x <SECRET_1> y", clean: "plain" } };
const BLOCKED = { body: "[REDACTED:BLOCKED]", attributes: { k: "[REDACTED:BLOCKED]", clean: "plain" } };

describe.skipIf(!CORE_HAS_ACTION_POLICY)("a core with actionPolicy", () => {
  test.each([
    ["allow", KEPT],
    ["warn", KEPT],
    ["redact", REDACTED],
    ["block", BLOCKED],
    ["default", REDACTED],
  ] as const)("%s: the exported record, from an object, text and bytes", async (action, expected) => {
    const forms = actionPolicyForms(action);
    for (const actionPolicy of [forms.object, forms.text, forms.bytes]) {
      expect(await exportRecord({ actionPolicy })).toEqual(expected);
    }
  });

  test("a finding no rule matches keeps the default action", async () => {
    expect(await exportRecord({ actionPolicy: UNMATCHED_POLICY })).toEqual(REDACTED);
  });

  test("it is a snapshot: a later mutation of the document changes nothing", async () => {
    const object = structuredClone(actionPolicyForms("warn").object);
    const exporter = memoryExporter();
    const processor = await createRedactingLogRecordProcessor(simpleProcessor(exporter), { actionPolicy: object });
    (object.rules[0] as { action: string }).action = "block";
    const provider = providerWith(processor);
    provider.getLogger("t").emit({ body: `b ${T}` });
    await settle();
    expect(exporter.records[0]?.body).toBe(`b ${T}`);
    await provider.shutdown();
  });

  test("the other scan options now reach every leaf too: a placeholder formatter shapes the exported body", async () => {
    const exported = await exportRecord({
      actionPolicy: actionPolicyForms("redact").object,
      placeholderFormatter: (finding) => `[${finding.type}]`,
    });
    expect(exported.body).toBe("b [github_token]");
  });

  test("a malformed policy rejects with INVALID_ACTION_POLICY and nothing of the document", async () => {
    const error = await createRedactingLogRecordProcessor(simpleProcessor(memoryExporter()), {
      actionPolicy: MALFORMED_POLICY,
    }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CoreOptionsError);
    expect((error as CoreOptionsError).coreCode).toBe("INVALID_ACTION_POLICY");
    expect(JSON.stringify({ ...(error as object), message: (error as Error).message })).not.toContain(MALFORMED_MARKER);
  });

  test("a callback policy beside an actionPolicy rejects before the core is touched", async () => {
    await expect(
      createRedactingLogRecordProcessor(simpleProcessor(memoryExporter()), {
        policy: { evaluate: () => "redact" },
        actionPolicy: actionPolicyForms("warn").object,
      }),
    ).rejects.toThrow("mutually exclusive");
  });
});

describe.skipIf(CORE_HAS_ACTION_POLICY)("a core older than actionPolicy", () => {
  test("a requested actionPolicy is rejected by name; the callback policy still works", async () => {
    const error = await exportRecord({ actionPolicy: actionPolicyForms("block").object }).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect((error as CoreOptionsError).code).toBe("CORE_OPTION_UNSUPPORTED");
    expect((error as CoreOptionsError).options).toEqual(["actionPolicy"]);
    expect(await exportRecord({ policy: { evaluate: () => "block" } })).toEqual(BLOCKED);
  });
});
