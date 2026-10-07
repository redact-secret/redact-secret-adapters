/**
 * Policy overlays on the AI-context boundary, PII off, through the real core
 * (redact-secret-adapters#215, `docs/policy-overlays.md`): the exact outcome
 * and findings for the default policy, a one-rule override that falls back to
 * the default, a full callback replacement and a partial callback, over a
 * credential, a lower-confidence emitted finding, a private key, PII (not
 * detected here) and a benign negative control. Also: the whole-input and
 * incremental paths agree under every overlay and every chunk partition,
 * `warn` is observable but releases the text while `block` releases nothing,
 * and configuration conflicts are explicit. Values are synthetic.
 *
 * Needs the `actionPolicy` floor of the core; below it the overlays that use it
 * are covered by `action-policy-live.test.ts` (explicit rejection), not here.
 */

import { describe, expect, test } from "vitest";

import { CORE_HAS_ACTION_POLICY } from "../../../fixtures/action-policy.js";
import { MIXED, OVERLAY_NAMES, OVERLAYS, PRIVATE_KEY, TOKEN, triple } from "../../../fixtures/policy-overlays.js";
import { createAiContextBoundary } from "../src/index.js";
import { checkOverlays, INPUTS, type Table, unchanged } from "./policy-overlays-cases.js";

const TOKEN_KEPT = `t ${TOKEN}; customer email: jane.doe@acme-corp.io; password=hunter2hunter2`;
const MIXED_DEFAULT = "t <SECRET_1>; customer email: jane.doe@acme-corp.io; password=hunter2hunter2";
const MIXED_ALL = "t <SECRET_1>; customer email: jane.doe@acme-corp.io; password=<SECRET_2>";
const PK_KEPT = PRIVATE_KEY;

const BLOCKED = { outcome: "blocked", reason: "policy" } as const;
const warnPassword = {
  outcome: "ok",
  value: "password=hunter2hunter2",
  findings: ["contextual_secret/medium/warn"],
} as const;
const redactPassword = {
  outcome: "ok",
  value: "password=<SECRET_1>",
  findings: ["contextual_secret/medium/redact"],
} as const;
const allowPassword = {
  outcome: "ok",
  value: "password=hunter2hunter2",
  findings: ["contextual_secret/medium/allow"],
} as const;
// PII is off: the email line has no finding under any overlay, and is released as written.
const EMAIL_PLAIN = unchanged("customer email: jane.doe@acme-corp.io");
const BENIGN_PLAIN = unchanged("build ok at 12:00, version 1.2.3");

const EXPECTED: Table = {
  default: {
    mixed: {
      outcome: "ok",
      value: MIXED_DEFAULT,
      findings: ["github_token/high/redact", "contextual_secret/medium/warn"],
    },
    password: warnPassword,
    email: EMAIL_PLAIN,
    privateKey: BLOCKED,
    benign: BENIGN_PLAIN,
  },
  "rule-token-warn": {
    mixed: { outcome: "ok", value: TOKEN_KEPT, findings: ["github_token/high/warn", "contextual_secret/medium/warn"] },
    password: warnPassword,
    email: EMAIL_PLAIN,
    privateKey: BLOCKED, // the unmatched private key keeps the default block
    benign: BENIGN_PLAIN,
  },
  "rule-password-redact": {
    mixed: {
      outcome: "ok",
      value: MIXED_ALL,
      findings: ["github_token/high/redact", "contextual_secret/medium/redact"],
    },
    password: redactPassword,
    email: EMAIL_PLAIN,
    privateKey: BLOCKED,
    benign: BENIGN_PLAIN,
  },
  "callback-redact-all": {
    mixed: {
      outcome: "ok",
      value: MIXED_ALL,
      findings: ["github_token/high/redact", "contextual_secret/medium/redact"],
    },
    password: redactPassword,
    email: EMAIL_PLAIN,
    // The callback replaced the default: the private key is redacted, no longer blocked.
    privateKey: { outcome: "ok", value: "<SECRET_1>", findings: ["private_key/high/redact"] },
    benign: BENIGN_PLAIN,
  },
  "callback-token-only": {
    mixed: {
      outcome: "ok",
      value: MIXED_DEFAULT,
      findings: ["github_token/high/redact", "contextual_secret/medium/allow"],
    },
    password: allowPassword,
    email: EMAIL_PLAIN,
    // The trap: a partial callback allows what the default blocks. The key is released as written.
    privateKey: { outcome: "ok", value: PK_KEPT, findings: ["private_key/high/allow"] },
    benign: BENIGN_PLAIN,
  },
};

describe.skipIf(!CORE_HAS_ACTION_POLICY)("overlays, PII off", () => {
  test("exact outcome, value and findings for every overlay and input, equal to the core's own text", async () => {
    await checkOverlays(EXPECTED, undefined);
  });

  test("the benign control is unchanged and finding-free under every overlay", async () => {
    for (const name of OVERLAY_NAMES) {
      const boundary = await createAiContextBoundary(OVERLAYS[name]() as never);
      const outcome = boundary.sanitizeText(INPUTS.benign);
      expect(outcome).toEqual({ outcome: "ok", value: INPUTS.benign, findings: [] });
    }
  });

  test("whole-input and incremental agree under every overlay and chunk partition", async () => {
    for (const name of OVERLAY_NAMES) {
      const boundary = await createAiContextBoundary(OVERLAYS[name]() as never);
      for (const input of [MIXED, INPUTS.privateKey, INPUTS.benign]) {
        const whole = boundary.sanitizeText(input);
        for (const size of [1, 2, 7, 64, input.length]) {
          const stream = boundary.openStream();
          for (let i = 0; i < input.length; i += size) stream.append(input.slice(i, i + size));
          const done = stream.finalize();
          expect(done.outcome, `${name} size ${size}`).toBe(whole.outcome);
          if (whole.outcome === "ok" && done.outcome === "ok") {
            expect(done.value, `${name} size ${size}`).toBe(whole.value);
            expect(done.findings.map(triple), `${name} size ${size}`).toEqual(whole.findings.map(triple));
          } else {
            expect(done).toEqual(whole);
          }
        }
      }
    }
  });

  test("incremental lifecycle: nothing is released before finalize, and a finished stream accepts no more", async () => {
    const boundary = await createAiContextBoundary(OVERLAYS["rule-token-warn"]() as never);
    const stream = boundary.openStream();
    stream.append(`t ${TOKEN}`);
    expect(stream.accepting).toBe(true);
    const done = stream.finalize();
    expect(done).toMatchObject({ outcome: "ok", value: `t ${TOKEN}` });
    expect(stream.accepting).toBe(false);
    const again = boundary.openStream();
    again.abort();
    expect(again.accepting).toBe(false);
    expect(again.finalize()).toEqual({ outcome: "aborted" });
  });

  test("warn is observable and releases the text; block (the default for a private key) releases nothing", async () => {
    const warn = await createAiContextBoundary(OVERLAYS["rule-token-warn"]() as never);
    const seen: string[] = [];
    const observed = await createAiContextBoundary({
      ...OVERLAYS["rule-token-warn"](),
      onFinding: (finding: { action: string }) => seen.push(finding.action),
    } as never);
    expect(warn.sanitizeText(`t ${TOKEN}`)).toMatchObject({ outcome: "ok", value: `t ${TOKEN}` });
    observed.sanitizeText(`t ${TOKEN}`);
    expect(seen).toEqual(["warn"]);
    expect(warn.sanitizeText(PRIVATE_KEY)).toEqual(BLOCKED);
  });

  test("a callback policy beside an actionPolicy is rejected before anything is scanned", async () => {
    await expect(
      createAiContextBoundary({ ...OVERLAYS["rule-token-warn"](), policy: { evaluate: () => "redact" } } as never),
    ).rejects.toThrow("policy and actionPolicy are mutually exclusive");
  });
});
