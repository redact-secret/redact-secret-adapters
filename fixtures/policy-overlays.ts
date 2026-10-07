/**
 * Synthetic controls for the policy-overlay consumer recipes
 * (redact-secret-adapters#215, `docs/policy-overlays.md`).
 *
 * One overlay per row of the matrix: the core's default policy, a declarative
 * one-rule override that falls back to the default for everything else, a full
 * callback replacement, and a callback that is partial by mistake. The tests
 * spell the expected host output out for every overlay and input; nothing is
 * computed here. Every value is synthetic and built at runtime, so the source
 * holds no token-shaped literal.
 */

import type { SecretAction } from "@redact-secret/core";

/** A GitHub-token-shaped, obviously synthetic value: a high-confidence credential. */
export const TOKEN = `ghp_${"x".repeat(36)}`;
/** A synthetic PEM-shaped block: the core's default policy blocks a private key. */
export const PRIVATE_KEY = `-----BEGIN PRIVATE KEY-----\n${"A".repeat(64)}\n-----END PRIVATE KEY-----`;
/** A credential-shaped assignment the core reports at medium confidence, action `warn` by default. */
export const PASSWORD_LINE = "password=hunter2hunter2";
/** A synthetic address with a context word: detected only when PII is on. */
export const EMAIL_VALUE = "jane.doe@acme-corp.io";
export const EMAIL_LINE = `customer email: ${EMAIL_VALUE}`;
/** Benign negative control: nothing here is a secret, a finding, or changed by any overlay. */
export const BENIGN = "build ok at 12:00, version 1.2.3";
/** One record holding a credential, PII and a lower-confidence assignment. */
export const MIXED = `t ${TOKEN}; ${EMAIL_LINE}; ${PASSWORD_LINE}`;

export type OverlayName =
  | "default"
  | "rule-token-warn"
  | "rule-password-redact"
  | "callback-redact-all"
  | "callback-token-only";

/** A revision 1 declarative document with one rule on one finding type. */
function oneRule(type: string, action: SecretAction | "default") {
  return {
    actionPolicyRevision: 1,
    base: "default",
    rules: [{ id: "overlay-rule", match: { type: [type] }, action }],
  } as const;
}

/**
 * The options each overlay passes to a factory (never `pii`: the PII-on files add it).
 * `callback-token-only` is the documented trap: a callback REPLACES the built-in policy for every
 * finding, so a partial one silently allows what the default would have blocked.
 */
export const OVERLAYS: Record<OverlayName, () => Record<string, unknown>> = {
  default: () => ({}),
  "rule-token-warn": () => ({ actionPolicy: oneRule("github_token", "warn") }),
  "rule-password-redact": () => ({ actionPolicy: oneRule("contextual_secret", "redact") }),
  "callback-redact-all": () => ({ policy: { evaluate: (): SecretAction => "redact" } }),
  "callback-token-only": () => ({
    policy: {
      evaluate: (finding: { type: string }): SecretAction => (finding.type === "github_token" ? "redact" : "allow"),
    },
  }),
};

export const OVERLAY_NAMES = Object.keys(OVERLAYS) as OverlayName[];

/** `type/confidence/action`, the only part of a finding the recipes compare: input-free by construction. */
export const triple = (f: { type: string; confidence: string; action: string }): string =>
  `${f.type}/${f.confidence}/${f.action}`;
