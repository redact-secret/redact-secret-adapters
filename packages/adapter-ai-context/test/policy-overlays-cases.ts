/**
 * Shared harness for the policy-overlay recipes on the AI-context boundary
 * (redact-secret-adapters#215). The PII-off and PII-on files each spell out
 * their expected table and call `checkOverlays`; PII activation is process-wide
 * and one-shot, so the two states live in two test files (vitest runs each
 * file in its own process).
 */

import * as core from "@redact-secret/core";
import { expect } from "vitest";

import {
  BENIGN,
  EMAIL_LINE,
  MIXED,
  OVERLAYS,
  type OverlayName,
  PASSWORD_LINE,
  PRIVATE_KEY,
  triple,
} from "../../../fixtures/policy-overlays.js";
import { createAiContextBoundary } from "../src/index.js";

export const INPUTS = {
  mixed: MIXED,
  password: PASSWORD_LINE,
  email: EMAIL_LINE,
  privateKey: PRIVATE_KEY,
  benign: BENIGN,
};
export type InputName = keyof typeof INPUTS;

export type Expected =
  | { outcome: "ok"; value: string; findings: readonly string[] }
  | { outcome: "blocked"; reason: "policy" };

export type Table = Record<OverlayName, Record<InputName, Expected>>;

/** Unchanged input, no finding: the shape of every benign negative control. */
export const unchanged = (input: string): Expected => ({ outcome: "ok", value: input, findings: [] });

/** The core's own text for the same input and the same overlay, to show the adapter adds nothing. */
function coreText(options: Record<string, unknown>, input: string): string | "blocked" {
  const result = core.scanAndRedact(input, options as never);
  return result.findings.some((finding) => finding.action === "block") ? "blocked" : result.text;
}

/** Asserts every overlay x input: exact outcome, exact value, exact `type/confidence/action` triples, and the core's own text. */
export async function checkOverlays(expected: Table, pii: readonly string[] | undefined): Promise<void> {
  for (const [name, make] of Object.entries(OVERLAYS) as [OverlayName, () => Record<string, unknown>][]) {
    const options = { ...make(), ...(pii === undefined ? {} : { pii }) };
    const boundary = await createAiContextBoundary(options as never);
    for (const [inputName, input] of Object.entries(INPUTS) as [InputName, string][]) {
      const outcome = boundary.sanitizeText(input);
      const want = expected[name][inputName];
      const label = `${name} / ${inputName}`;
      if (want.outcome === "blocked") {
        expect(outcome, label).toEqual({ outcome: "blocked", reason: "policy" });
        expect(coreText(options, input), label).toBe("blocked");
        continue;
      }
      if (outcome.outcome !== "ok") throw new Error(`${label}: expected ok, got ${outcome.outcome}`);
      expect(outcome.value, label).toBe(want.value);
      expect(outcome.findings.map(triple), label).toEqual(want.findings);
      expect(coreText(options, input), label).toBe(want.value);
    }
  }
}
