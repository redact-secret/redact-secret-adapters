/**
 * The same overlays with PII on (`pii: ["pii:global"]`), through the real core
 * (redact-secret-adapters#215, `docs/policy-overlays.md`). PII activation is
 * process-wide and one-shot, so this is its own file: vitest runs each file in
 * its own process, and the PII-off cases live in `policy-overlays-live.test.ts`.
 * The only difference from that table is the email line: with PII on it is a
 * high-confidence finding that every overlay handles by its own rule. A
 * callback that allows everything but the token also allows the address.
 */

import { describe, test } from "vitest";

import { CORE_HAS_ACTION_POLICY } from "../../../fixtures/action-policy.js";
import { PRIVATE_KEY, TOKEN } from "../../../fixtures/policy-overlays.js";
import { checkOverlays, type Table, unchanged } from "./policy-overlays-cases.js";

const BLOCKED = { outcome: "blocked", reason: "policy" } as const;
const PII = ["pii:global"] as const;
const BENIGN_PLAIN = unchanged("build ok at 12:00, version 1.2.3");
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
const emailRedacted = {
  outcome: "ok",
  value: "customer email: <SECRET_1>",
  findings: ["pii_global_email/high/redact"],
} as const;
const emailAllowed = {
  outcome: "ok",
  value: "customer email: jane.doe@acme-corp.io",
  findings: ["pii_global_email/high/allow"],
} as const;

const EXPECTED: Table = {
  default: {
    mixed: {
      outcome: "ok",
      value: "t <SECRET_1>; customer email: <SECRET_2>; password=hunter2hunter2",
      findings: ["github_token/high/redact", "pii_global_email/high/redact", "contextual_secret/medium/warn"],
    },
    password: warnPassword,
    email: emailRedacted,
    privateKey: BLOCKED,
    benign: BENIGN_PLAIN,
  },
  "rule-token-warn": {
    mixed: {
      outcome: "ok",
      value: `t ${TOKEN}; customer email: <SECRET_1>; password=hunter2hunter2`,
      findings: ["github_token/high/warn", "pii_global_email/high/redact", "contextual_secret/medium/warn"],
    },
    password: warnPassword,
    email: emailRedacted,
    privateKey: BLOCKED,
    benign: BENIGN_PLAIN,
  },
  "rule-password-redact": {
    mixed: {
      outcome: "ok",
      value: "t <SECRET_1>; customer email: <SECRET_2>; password=<SECRET_3>",
      findings: ["github_token/high/redact", "pii_global_email/high/redact", "contextual_secret/medium/redact"],
    },
    password: redactPassword,
    email: emailRedacted,
    privateKey: BLOCKED,
    benign: BENIGN_PLAIN,
  },
  "callback-redact-all": {
    mixed: {
      outcome: "ok",
      value: "t <SECRET_1>; customer email: <SECRET_2>; password=<SECRET_3>",
      findings: ["github_token/high/redact", "pii_global_email/high/redact", "contextual_secret/medium/redact"],
    },
    password: redactPassword,
    email: emailRedacted,
    privateKey: { outcome: "ok", value: "<SECRET_1>", findings: ["private_key/high/redact"] },
    benign: BENIGN_PLAIN,
  },
  "callback-token-only": {
    mixed: {
      outcome: "ok",
      value: "t <SECRET_1>; customer email: jane.doe@acme-corp.io; password=hunter2hunter2",
      findings: ["github_token/high/redact", "pii_global_email/high/allow", "contextual_secret/medium/allow"],
    },
    password: allowPassword,
    email: emailAllowed,
    privateKey: { outcome: "ok", value: PRIVATE_KEY, findings: ["private_key/high/allow"] },
    benign: BENIGN_PLAIN,
  },
};

describe.skipIf(!CORE_HAS_ACTION_POLICY)("overlays, PII on", () => {
  test("exact outcome, value and findings for every overlay and input, equal to the core's own text", async () => {
    await checkOverlays(EXPECTED, PII);
  });
});
