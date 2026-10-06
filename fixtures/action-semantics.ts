/**
 * Shared synthetic inputs for the policy action truth-table tests
 * (redact-secret/redact-secret-adapters#214, `docs/action-semantics.md`).
 *
 * The tests assert the exact host output of the real adapters over the real
 * published core, one file per host package, so this module holds only what
 * they must agree on: the synthetic credential, the four actions, and the
 * policies that drive them. The credential is built at runtime, so the source
 * never contains a token-shaped literal, and it is unmistakably synthetic.
 *
 * The expected outputs are deliberately NOT computed here. Each test spells
 * the exact string out, so a change in what a host emits fails a test that
 * names it.
 */

import type { SecretAction } from "@redact-secret/core";

/** A GitHub-token-shaped, obviously synthetic value the real core detects. */
export const SYNTHETIC_TOKEN = `ghp_${"x".repeat(36)}`;

/** Detected by the real core only with `api_key` as the key or `api_key=` in front of it. */
export const SYNTHETIC_CONTEXTUAL_VALUE = `SYNTHETIC_TEST_VALUE_${"0".repeat(10)}`;

/** The four actions a legacy callback `policy` may return, in the core's order of severity. */
export const ACTIONS = ["allow", "warn", "redact", "block"] as const satisfies readonly SecretAction[];

/** The legacy callback policy that resolves every finding to one action. */
export function policyFor(action: SecretAction): { evaluate: () => SecretAction } {
  return { evaluate: () => action };
}

/** A policy that throws, with a message that carries the credential (which must never be read). */
export const THROWING_POLICY = {
  evaluate: (): SecretAction => {
    throw new Error(`policy failed on ${SYNTHETIC_TOKEN}`);
  },
};

/** A policy that returns something that is not an action. */
export const INVALID_POLICY = { evaluate: () => "nonsense" as unknown as SecretAction };
