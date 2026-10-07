/**
 * The declarative `actionPolicy` through a real pino logger and the real core
 * (redact-secret-adapters#217): the exact JSON line written for each action, in
 * each input form, equal to what the same action as a callback policy writes
 * (`action-semantics-live.test.ts`, #214), and unchanged by a later mutation of
 * the caller's document. Below the verified core floor the option is rejected
 * explicitly and the legacy options still work. Values are synthetic.
 */

import { CoreOptionsError } from "@redact-secret/adapter";
import pino from "pino";
import { describe, expect, test } from "vitest";

import {
  actionPolicyForms,
  CORE_HAS_ACTION_POLICY,
  MALFORMED_MARKER,
  MALFORMED_POLICY,
  UNMATCHED_POLICY,
} from "../../../fixtures/action-policy.js";
import { SYNTHETIC_TOKEN } from "../../../fixtures/action-semantics.js";
import { createRedactingHooks, createRedactingLogMethod, createRedactingStreamWrite } from "../src/index.js";

type Options = NonNullable<Parameters<typeof createRedactingHooks>[0]>;

const T = SYNTHETIC_TOKEN;

async function emit(options: Options = {}): Promise<string> {
  const chunks: string[] = [];
  const logger = pino(
    { base: null, timestamp: false, hooks: await createRedactingHooks(options), mixin: () => ({ mixed: `m ${T}` }) },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  logger.child({ bound: `b ${T}` }).info({ field: `x ${T} y`, clean: "plain" }, `msg ${T}`);
  return chunks.join("");
}

const KEPT = `{"level":30,"bound":"b ${T}","mixed":"m ${T}","field":"x ${T} y","clean":"plain","msg":"msg ${T}"}\n`;
const REDACTED =
  '{"level":30,"bound":"b <SECRET_1>","mixed":"m <SECRET_1>","field":"x <SECRET_1> y","clean":"plain","msg":"msg <SECRET_1>"}\n';
const BLOCKED =
  '{"level":30,"bound":"[REDACTED:BLOCKED]","mixed":"[REDACTED:BLOCKED]","field":"[REDACTED:BLOCKED]","clean":"plain","msg":"[REDACTED:BLOCKED]"}\n';

describe.skipIf(!CORE_HAS_ACTION_POLICY)("a core with actionPolicy", () => {
  test.each([
    ["allow", KEPT],
    ["warn", KEPT],
    ["redact", REDACTED],
    ["block", BLOCKED],
    ["default", REDACTED],
  ] as const)("%s: the final line, from an object, text and bytes", async (action, line) => {
    const forms = actionPolicyForms(action);
    for (const actionPolicy of [forms.object, forms.text, forms.bytes]) {
      expect(await emit({ actionPolicy })).toBe(line);
    }
  });

  test("a finding no rule matches keeps the default action", async () => {
    expect(await emit({ actionPolicy: UNMATCHED_POLICY })).toBe(REDACTED);
  });

  test("it is a snapshot shared by both hooks: a later mutation of the document changes nothing", async () => {
    const object = structuredClone(actionPolicyForms("warn").object);
    const bytes = actionPolicyForms("warn").bytes.slice();
    const hooks = await createRedactingHooks({ actionPolicy: object });
    const stream = await createRedactingStreamWrite({ actionPolicy: bytes });
    (object.rules[0] as { action: string }).action = "block";
    bytes.fill(0);
    const chunks: string[] = [];
    const sink = {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    };
    pino({ base: null, timestamp: false, hooks }, sink).info({ f: T }, "m");
    expect(chunks.join("")).toBe(`{"level":30,"f":"${T}","msg":"m"}\n`);
    expect(stream(`{"f":"${T}"}\n`)).toBe(`{"f":"${T}"}\n`);
  });

  test("the single-hook factory applies it as well", async () => {
    const written: unknown[] = [];
    const logMethod = await createRedactingLogMethod({ actionPolicy: actionPolicyForms("block").object });
    logMethod.call({} as never, [{ f: T }, `m ${T}`] as never, (...args: unknown[]) => written.push(args), 30);
    expect(JSON.stringify(written)).not.toContain(T);
    expect(JSON.stringify(written)).toContain("[REDACTED:BLOCKED]");
  });

  test("a malformed policy rejects every factory with INVALID_ACTION_POLICY and nothing of the document", async () => {
    for (const make of [createRedactingHooks, createRedactingLogMethod, createRedactingStreamWrite]) {
      const error = await make({ actionPolicy: MALFORMED_POLICY }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(CoreOptionsError);
      expect((error as CoreOptionsError).coreCode).toBe("INVALID_ACTION_POLICY");
      expect(JSON.stringify({ ...(error as object), message: (error as Error).message })).not.toContain(
        MALFORMED_MARKER,
      );
    }
  });

  test("a callback policy beside an actionPolicy rejects before the core is touched", async () => {
    await expect(
      createRedactingHooks({ policy: { evaluate: () => "redact" }, actionPolicy: actionPolicyForms("warn").object }),
    ).rejects.toThrow("mutually exclusive");
  });
});

describe.skipIf(CORE_HAS_ACTION_POLICY)("a core older than actionPolicy", () => {
  test("every factory rejects a requested actionPolicy by name; the legacy options still work", async () => {
    for (const make of [createRedactingHooks, createRedactingLogMethod, createRedactingStreamWrite]) {
      const error = await make({ actionPolicy: actionPolicyForms("block").object }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect((error as CoreOptionsError).code).toBe("CORE_OPTION_UNSUPPORTED");
      expect((error as CoreOptionsError).options).toEqual(["actionPolicy"]);
    }
    expect(
      await emit({ policy: { evaluate: () => "block" }, scanLimits: { maxInputBytes: 4096, maxFindings: 8 } }),
    ).toBe(BLOCKED);
  });
});
