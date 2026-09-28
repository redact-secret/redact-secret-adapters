/**
 * Activation is not masking: a `warn` finding leaves its text alone
 * (redact-secret/redact-secret-adapters#51).
 *
 * Under the core's default policy, PII finding types are confidence-gated
 * rather than always redacted — `High` redacts, `Medium` and `Low` resolve to
 * `Action::Warn`, which the core pins with its own
 * `pii_policy_tests::pii_types_remain_confidence_gated`. `maskLeafOutcomeWith`
 * substitutes only on `block`; for everything else it returns `result.text`,
 * which a `warn` leaves as the original string. So a consumer who turns PII on
 * through these adapters still emits Medium- and Low-confidence PII as
 * plaintext to logs, spans and AI context under that default policy.
 *
 * That is a deliberate boundary, not a defect to compensate for here: this
 * repository decides nothing about policy, and does not synthesize one. A
 * caller who needs all of it masked supplies their own `policy` mapping those
 * findings to `redact` — the last test shows exactly that working through the
 * same primitive.
 *
 * It is also **observable** rather than merely disclosed: the counters count
 * `findings` and `redacted` apart, so a non-zero finding count on a leaf that
 * is `unchanged` is this situation and nothing else. These tests pin that
 * signal so an operator can alert on it.
 *
 * The scanner is the deterministic fake; `WARN_ME` is a magic fixture string,
 * not a credential.
 */

import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import {
  countLeaf,
  createOutcomeCounter,
  maskLeafOutcomeWith,
  type ScanAndRedact,
  toValueCounts,
} from "../src/index.js";

const WARNED = "contact WARN_ME at the desk";

test("a warn finding passes its text through unchanged, with a non-zero finding count", () => {
  const leaf = maskLeafOutcomeWith(fakeScanAndRedact, WARNED);
  // The whole point: the text on the wire is the input, byte for byte.
  expect(leaf.text).toBe(WARNED);
  expect(leaf.outcome).toBe("unchanged");
  expect(leaf.findings).toBe(1);
});

test("the counters make the gap visible: scanned and findings rise, redacted does not", () => {
  const counter = createOutcomeCounter();
  countLeaf(counter, maskLeafOutcomeWith(fakeScanAndRedact, WARNED));
  expect(toValueCounts(counter)).toEqual({
    scanned: 1,
    findings: 1,
    redacted: 0,
    blocked: 0,
    limited: 0,
    failed: 0,
  });
});

test("a redacting leaf is the contrast: the same counters, with redacted raised", () => {
  const counter = createOutcomeCounter();
  const leaf = maskLeafOutcomeWith(fakeScanAndRedact, "token SECRET_TOKEN_1");
  countLeaf(counter, leaf);
  expect(leaf.outcome).toBe("redacted");
  expect(toValueCounts(counter)).toEqual({
    scanned: 1,
    findings: 1,
    redacted: 1,
    blocked: 0,
    limited: 0,
    failed: 0,
  });
});

test("a caller's own policy is the documented way to close the gap, and reaches the core unchanged", () => {
  const seen: unknown[] = [];
  const scanner: ScanAndRedact = (text, options) => {
    seen.push(options?.policy);
    return fakeScanAndRedact(text);
  };
  const policy = { evaluate: () => "redact" as const };
  maskLeafOutcomeWith(scanner, WARNED, { policy });
  expect(seen).toEqual([policy]);
});
