/**
 * The policy action truth table for pino (redact-secret/redact-secret-adapters#214,
 * `docs/action-semantics.md`): the exact JSON line a real pino logger writes
 * through `createRedactingHooks` for each of allow / warn / redact / block, for
 * a core failure, and for the line ceilings, on the real installed core with
 * the legacy callback `policy`. Every expected line is spelled out. Values are
 * synthetic and the credential is built at runtime.
 */

import pino from "pino";
import { describe, expect, test } from "vitest";

import {
  type ACTIONS,
  INVALID_POLICY,
  policyFor,
  SYNTHETIC_TOKEN,
  THROWING_POLICY,
} from "../../../fixtures/action-semantics.js";
import {
  createRedactingHooks,
  createRedactingStreamWrite,
  PINO_ERROR_LINE,
  PINO_LIMIT_LINE,
  type PinoLogOutcome,
} from "../src/index.js";

type Options = NonNullable<Parameters<typeof createRedactingHooks>[0]>;

/** One record through a real logger: a field, a message, a child binding and `mixin()` output. */
async function emit(options: Options = {}): Promise<{ line: string; outcome: PinoLogOutcome | undefined }> {
  const chunks: string[] = [];
  let outcome: PinoLogOutcome | undefined;
  const hooks = await createRedactingHooks({
    ...options,
    onOutcome: (o) => {
      outcome = o;
    },
  });
  const logger = pino(
    { base: null, timestamp: false, hooks, mixin: () => ({ mixed: `m ${SYNTHETIC_TOKEN}` }) },
    {
      write(chunk: string) {
        chunks.push(chunk);
        return true;
      },
    },
  );
  logger
    .child({ bound: `b ${SYNTHETIC_TOKEN}` })
    .info({ field: `x ${SYNTHETIC_TOKEN} y`, clean: "plain" }, `msg ${SYNTHETIC_TOKEN}`);
  return { line: chunks.join(""), outcome };
}

const T = SYNTHETIC_TOKEN;

describe("pino: one finding per value, one policy action", () => {
  test.each([
    // allow and warn leave every value in the line, bindings and mixin() included.
    ["allow", `{"level":30,"bound":"b ${T}","mixed":"m ${T}","field":"x ${T} y","clean":"plain","msg":"msg ${T}"}\n`],
    ["warn", `{"level":30,"bound":"b ${T}","mixed":"m ${T}","field":"x ${T} y","clean":"plain","msg":"msg ${T}"}\n`],
    [
      "redact",
      '{"level":30,"bound":"b <SECRET_1>","mixed":"m <SECRET_1>","field":"x <SECRET_1> y","clean":"plain","msg":"msg <SECRET_1>"}\n',
    ],
    // block replaces each WHOLE value, not just the matched part.
    [
      "block",
      '{"level":30,"bound":"[REDACTED:BLOCKED]","mixed":"[REDACTED:BLOCKED]","field":"[REDACTED:BLOCKED]","clean":"plain","msg":"[REDACTED:BLOCKED]"}\n',
    ],
  ] as const)("%s", async (action, line) => {
    expect((await emit({ policy: policyFor(action) })).line).toBe(line);
  });

  test("the outcome counts what each action did, and carries no value", async () => {
    const counts = async (action: (typeof ACTIONS)[number]) => (await emit({ policy: policyFor(action) })).outcome;
    // The message and the field are masked by logMethod, the three values again by streamWrite: counts are per record.
    for (const action of ["allow", "warn"] as const) {
      const outcome = await counts(action);
      expect(outcome?.values.findings).toBeGreaterThan(0);
      expect(outcome?.values.redacted).toBe(0);
      expect(outcome?.values.blocked).toBe(0);
    }
    expect((await counts("redact"))?.values.redacted).toBeGreaterThan(0);
    expect((await counts("block"))?.values.blocked).toBeGreaterThan(0);
  });

  test("observation mode: warn everywhere is a line equal to what pino would write without the hooks", async () => {
    const chunks: string[] = [];
    const plain = pino(
      { base: null, timestamp: false, mixin: () => ({ mixed: `m ${T}` }) },
      {
        write: (chunk: string) => {
          chunks.push(chunk);
          return true;
        },
      },
    );
    plain.child({ bound: `b ${T}` }).info({ field: `x ${T} y`, clean: "plain" }, `msg ${T}`);
    expect((await emit({ policy: policyFor("warn") })).line).toBe(chunks.join(""));
  });
});

describe("pino: failure never falls back to plaintext", () => {
  test.each([
    ["a throwing policy", THROWING_POLICY],
    ["a policy that returns a non-action", INVALID_POLICY],
  ] as const)("%s is the fixed error marker on every value with a finding", async (_name, policy) => {
    const { line, outcome } = await emit({ policy });
    expect(line).toBe(
      '{"level":30,"bound":"[REDACTED:ERROR]","mixed":"[REDACTED:ERROR]","field":"[REDACTED:ERROR]","clean":"plain","msg":"[REDACTED:ERROR]"}\n',
    );
    expect(line).not.toContain(T);
    expect(outcome?.values.failed).toBeGreaterThan(0);
  });

  test("a line past a ceiling is the fixed limit line, never the original", async () => {
    const streamWrite = await createRedactingStreamWrite({ lineLimits: { maxLineLength: 50 } });
    const out = streamWrite(`${JSON.stringify({ level: 30, k: `${T} ${"y".repeat(100)}` })}\n`);
    expect(out).toBe(`${PINO_LIMIT_LINE}\n`);
    expect(out).toBe('{"msg":"[REDACTED:LIMIT_EXCEEDED]"}\n');
  });

  test("a value past maxStringLength is the limit marker, not scanned and not passed through", async () => {
    const streamWrite = await createRedactingStreamWrite({ limits: { maxStringLength: 10 } });
    expect(streamWrite(`${JSON.stringify({ level: 30, k: T })}\n`)).toBe(
      '{"level":30,"k":"[REDACTED:LIMIT_EXCEEDED]"}\n',
    );
  });

  test("a line the lexer cannot read is the fixed error line, never the original", async () => {
    const streamWrite = await createRedactingStreamWrite();
    const out = streamWrite(`{"k":"\\q ${T}"}\n`);
    expect(out).toBe(`${PINO_ERROR_LINE}\n`);
    expect(out).not.toContain(T);
  });
});

describe("pino: keys", () => {
  test("a key is not scanned: a credential in a key reaches the line, its value is blocked (caller responsibility)", async () => {
    const chunks: string[] = [];
    const hooks = await createRedactingHooks();
    const logger = pino(
      { base: null, timestamp: false, hooks },
      {
        write: (chunk: string) => {
          chunks.push(chunk);
          return true;
        },
      },
    );
    logger.info({ [T]: "value" }, "m");
    expect(chunks.join("")).toBe(`{"level":30,"${T}":"[REDACTED:BLOCKED]","msg":"m"}\n`);
  });
});
