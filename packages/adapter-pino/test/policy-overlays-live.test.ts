/**
 * Policy overlays through a real pino logger and the real core
 * (redact-secret-adapters#215, `docs/policy-overlays.md`): the exact JSON line a
 * host writes for one record holding a credential (the message), a lower-confidence
 * `warn`, a private key and a benign field, under the default policy, a one-rule
 * override with default fallback, a full callback replacement and a partial
 * callback. Also what the counters say, so a warn-only observation (`findings`
 * above `redacted` and `blocked`, the text released) is told apart from a
 * rejection (`[REDACTED:BLOCKED]`) and a redaction. Values are synthetic.
 */

import pino from "pino";
import { describe, expect, test } from "vitest";

import { CORE_HAS_ACTION_POLICY } from "../../../fixtures/action-policy.js";
import { OVERLAYS, type OverlayName, PASSWORD_LINE, PRIVATE_KEY, TOKEN } from "../../../fixtures/policy-overlays.js";
import { createRedactingHooks, type PinoLogOutcome } from "../src/index.js";

const line = (fields: { pw: string; k: string; msg: string }) =>
  `${JSON.stringify({ level: 30, pw: fields.pw, k: fields.k, benign: "build ok", msg: fields.msg })}\n`;

type Row = { line: string; redacted: number; blocked: number; failed: number };
const EXPECTED: Record<OverlayName, Row> = {
  default: {
    line: line({ pw: PASSWORD_LINE, k: "[REDACTED:BLOCKED]", msg: "t <SECRET_1>" }),
    redacted: 1,
    blocked: 1,
    failed: 0,
  },
  "rule-token-warn": {
    // The token is warn-only: released as written. The private key keeps the default block.
    line: line({ pw: PASSWORD_LINE, k: "[REDACTED:BLOCKED]", msg: `t ${TOKEN}` }),
    redacted: 0,
    blocked: 1,
    failed: 0,
  },
  "rule-password-redact": {
    line: line({ pw: "password=<SECRET_1>", k: "[REDACTED:BLOCKED]", msg: "t <SECRET_1>" }),
    redacted: 2,
    blocked: 1,
    failed: 0,
  },
  "callback-redact-all": {
    line: line({ pw: "password=<SECRET_1>", k: "<SECRET_1>", msg: "t <SECRET_1>" }),
    redacted: 3,
    blocked: 0,
    failed: 0,
  },
  "callback-token-only": {
    // The trap: the private key is released as written because the callback replaced the default block.
    line: line({ pw: PASSWORD_LINE, k: PRIVATE_KEY, msg: "t <SECRET_1>" }),
    redacted: 1,
    blocked: 0,
    failed: 0,
  },
};

async function emit(options: Record<string, unknown>): Promise<{ written: string; outcome: PinoLogOutcome }> {
  let written = "";
  let outcome: PinoLogOutcome | undefined;
  const hooks = await createRedactingHooks({
    ...options,
    onOutcome: (o: PinoLogOutcome) => {
      outcome = o;
    },
  } as never);
  const logger = pino(
    { base: null, timestamp: false, hooks },
    {
      write(chunk: string) {
        written += chunk;
      },
    },
  );
  logger.info({ pw: PASSWORD_LINE, k: PRIVATE_KEY, benign: "build ok" }, `t ${TOKEN}`);
  if (outcome === undefined) throw new Error("no outcome reported");
  return { written, outcome };
}

describe.skipIf(!CORE_HAS_ACTION_POLICY)("pino overlays, PII off", () => {
  test.each(Object.keys(OVERLAYS) as OverlayName[])("%s: the exact line and the outcome counters", async (name) => {
    const { written, outcome } = await emit(OVERLAYS[name]());
    expect(written).toBe(EXPECTED[name].line);
    expect(outcome.values.redacted).toBe(EXPECTED[name].redacted);
    expect(outcome.values.blocked).toBe(EXPECTED[name].blocked);
    expect(outcome.values.failed).toBe(0);
    expect(outcome.values.limited).toBe(0);
  });

  test("warn-only observation: findings are reported while nothing is redacted or blocked", async () => {
    const { written, outcome } = await emit({
      actionPolicy: {
        actionPolicyRevision: 1,
        base: "default",
        rules: [{ id: "w", match: { type: ["github_token"] }, action: "warn" }],
      },
    });
    expect(written).toContain(TOKEN);
    expect(outcome.values.findings).toBeGreaterThan(0);
  });

  test("a benign record is unchanged with no finding under every overlay", async () => {
    for (const make of Object.values(OVERLAYS)) {
      let outcome: PinoLogOutcome | undefined;
      let written = "";
      const hooks = await createRedactingHooks({
        ...make(),
        onOutcome: (o: PinoLogOutcome) => {
          outcome = o;
        },
      } as never);
      pino(
        { base: null, timestamp: false, hooks },
        {
          write(c: string) {
            written += c;
          },
        },
      ).info({ n: 1 }, "build ok at 12:00");
      expect(written).toBe('{"level":30,"n":1,"msg":"build ok at 12:00"}\n');
      expect(outcome?.values).toMatchObject({ findings: 0, redacted: 0, blocked: 0, failed: 0 });
    }
  });
});
