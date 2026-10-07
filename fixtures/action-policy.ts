/**
 * Synthetic declarative action policies for the live tests
 * (redact-secret-adapters#217). Nothing here is a credential, and nothing here
 * evaluates a policy: each document is data the real core parses and applies,
 * and the tests compare what an adapter emits with what the core itself does.
 *
 * `CORE_HAS_ACTION_POLICY` is whether the installed `@redact-secret/core` is at
 * the verified `actionPolicy` floor. CI runs the live tests at both ends of the
 * declared core range, so a test that needs the option skips below the floor,
 * and a test that needs the explicit rejection skips at or above it.
 */

import type { SecretAction } from "@redact-secret/core";

import { coreVersionAtLeast, SCAN_OPTION_CORE_FLOORS } from "../packages/adapter/src/scan-options.js";

const core = await import("@redact-secret/core");

export const CORE_HAS_ACTION_POLICY = coreVersionAtLeast(core.VERSION, SCAN_OPTION_CORE_FLOORS.actionPolicy);

/** A revision 1 document with one rule: every `github_token` finding gets `action` (`"default"` keeps the core's). */
export function actionPolicyFor(action: SecretAction | "default"): {
  actionPolicyRevision: 1;
  base: "default";
  rules: { id: string; match: { type: string[] }; action: SecretAction | "default" }[];
} {
  return {
    actionPolicyRevision: 1,
    base: "default",
    rules: [{ id: "synthetic-rule", match: { type: ["github_token"] }, action }],
  };
}

/** A well-formed document whose only rule matches a type the synthetic text does not hold: every finding is unmatched. */
export const UNMATCHED_POLICY = {
  actionPolicyRevision: 1,
  base: "default",
  rules: [{ id: "other-type", match: { type: ["jwt"] }, action: "block" }],
} as const;

/** The three input forms of one document: the object, its UTF-8 JSON text, and its UTF-8 bytes. */
export function actionPolicyForms(action: SecretAction | "default") {
  const object = actionPolicyFor(action);
  const text = JSON.stringify(object);
  return { object, text, bytes: new TextEncoder().encode(text) } as const;
}

/** A document the core must refuse (an unknown revision). Its text must never reach an error. */
export const MALFORMED_POLICY = '{"actionPolicyRevision":2,"SYNTHETIC-BROKEN-POLICY-MARKER":true}';
export const MALFORMED_MARKER = "SYNTHETIC-BROKEN-POLICY-MARKER";
