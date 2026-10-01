/**
 * The single primitive every adapter builds on: mask one leaf string with
 * an injected `scanAndRedact`, and never let a core failure or a `block`
 * finding put text on the wire.
 */

import type { SecretAction } from "@redact-secret/core";

import { type KeyContextScanned, scanLeafInKeyContext } from "./key-context.js";
import type { LeafOutcome, OutcomeCounter } from "./outcome.js";
import type { Limits, MaskLeafOptions, ScanAndRedact } from "./types.js";

export const BLOCK_MARKER = "[REDACTED:BLOCKED]";
export const ERROR_MARKER = "[REDACTED:ERROR]";
export const LIMIT_MARKER = "[REDACTED:LIMIT_EXCEEDED]";
export const CYCLE_MARKER = "[REDACTED:CYCLE]";

const BLOCK: SecretAction = "block";

/**
 * Bounds enforced by every walker and the span processor. A field that
 * exceeds `maxStringLength`, or a value reached only after `maxDepth`/
 * `maxArrayLength`/`maxObjectKeys`/`maxTotalLeaves` is spent, never
 * reaches the core: it becomes {@link LIMIT_MARKER} instead. Every log
 * call pays the scan cost, so these bounds also cap per-call latency for
 * pathological merging objects.
 *
 * `maxNodes` caps every visit, containers included, so a shared-reference
 * graph (walked once per path) cannot multiply the work past it. It is four
 * times `maxTotalLeaves`, so a string-heavy value still meets the leaf
 * budget first.
 */
export const DEFAULT_LIMITS: Limits = Object.freeze({
  maxDepth: 8,
  maxArrayLength: 1000,
  maxObjectKeys: 200,
  maxStringLength: 200_000,
  maxTotalLeaves: 5000,
  maxNodes: 20_000,
});

/**
 * `value` if it is a usable bound, else `fallback`. `undefined`, `NaN`, a
 * negative number, or a non-number would otherwise disable a limit
 * (`length > NaN` is never true) or override the default by accident.
 */
export function resolveLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && value >= 0 ? value : fallback;
}

/**
 * Masks one leaf string. Any thrown error — including `NOT_INITIALIZED` if
 * a host skipped `await initialize()` — or a result not shaped like
 * `{ text: string, findings: [] }` fails closed: the leaf becomes
 * {@link ERROR_MARKER}, never the original text and never the error's own
 * message. A `block` finding replaces the entire leaf with
 * {@link BLOCK_MARKER}: `scanAndRedact` already substitutes `block`
 * findings in place like `redact` ones, but an inline placeholder still
 * leaves the rest of the string visible, which is not the documented host
 * decision for a block-worthy secret. For a plain string log call the leaf
 * *is* the message, and for a merged field or an `err.message` the leaf is
 * that field's whole text.
 */
export function maskLeafWith(scanAndRedact: ScanAndRedact, text: string, options: MaskLeafOptions = {}): string {
  return maskLeafOutcomeWith(scanAndRedact, text, options).text;
}

/** One masked leaf, with the input-free record of what happened to it. */
export interface MaskedLeaf {
  readonly text: string;
  readonly outcome: LeafOutcome;
  /**
   * Findings the core reported for this one leaf — zero when it was never
   * scanned. Not a count of distinct credentials: see `./outcome.ts`.
   */
  readonly findings: number;
}

/**
 * {@link maskLeafWith}, plus what happened, for a host adapter that reports
 * outcome counters. Exactly the same masking decisions; nothing derived from
 * the leaf's text is in the result besides the masked text itself.
 */
export function maskLeafOutcomeWith(
  scanAndRedact: ScanAndRedact,
  text: string,
  { policy, maxStringLength, key }: MaskLeafOptions = {},
): MaskedLeaf {
  if (typeof text !== "string") {
    throw new TypeError("maskLeafWith: text must be a string");
  }
  if (text.length > resolveLimit(maxStringLength, DEFAULT_LIMITS.maxStringLength)) {
    return { text: LIMIT_MARKER, outcome: "limited", findings: 0 };
  }
  // The key is context for the scan, never output, and is not itself
  // scanned: a key is kept as it is, so the value keeps its shape.
  const keyed = typeof key === "string" ? key : undefined;
  if (keyed !== undefined && keyed.length > resolveLimit(maxStringLength, DEFAULT_LIMITS.maxStringLength)) {
    return { text: LIMIT_MARKER, outcome: "limited", findings: 0 };
  }

  const scan = (input: string): KeyContextScanned | { readonly failure: Failure } => {
    try {
      const result = scanAndRedact(input, { policy });
      if (typeof result?.text !== "string" || !Array.isArray(result.findings)) return { failure: "error" };
      return result;
    } catch {
      return { failure: "error" };
    }
  };
  const scanned = scanLeafInKeyContext(scan, text, keyed, { policy: "blocked", coreError: "error" });
  if ("failure" in scanned) {
    return scanned.failure === "blocked"
      ? { text: BLOCK_MARKER, outcome: "blocked", findings: 0 }
      : { text: ERROR_MARKER, outcome: "failed", findings: 0 };
  }
  const findings = scanned.findings.length;
  if (scanned.findings.some((finding) => finding?.action === BLOCK)) {
    return { text: BLOCK_MARKER, outcome: "blocked", findings };
  }
  // A `warn` finding leaves the text alone, so a scan can report findings
  // and still be `unchanged`. That is why the two are counted apart.
  return { text: scanned.text, outcome: scanned.text === text ? "unchanged" : "redacted", findings };
}

/** What a scan inside {@link maskLeafOutcomeWith} can fail with before it is mapped to a marker. */
type Failure = "error" | "blocked";

/** Adds one leaf's outcome to `counter`. A leaf the core never saw does not count as `scanned`. */
export function countLeaf(counter: OutcomeCounter | undefined, leaf: MaskedLeaf): void {
  if (counter === undefined) return;
  if (leaf.outcome !== "limited") counter.scanned += 1;
  counter.findings += leaf.findings;
  if (leaf.outcome === "redacted") counter.redacted += 1;
  else if (leaf.outcome === "blocked") counter.blocked += 1;
  else if (leaf.outcome === "limited") counter.limited += 1;
  else if (leaf.outcome === "failed") counter.failed += 1;
}
