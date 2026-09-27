/**
 * The one outcome contract every host adapter reports through
 * (redact-secret/redact-secret-adapters#45), so a consumer can count what
 * happened without the adapters coupling to a metrics backend and without
 * anything derived from the input leaving the process.
 *
 * It is input-free **by construction**: a counter holds six non-negative
 * integers and nothing else. There is no field for a value, a masked value, a
 * field path, a key, an offset, a detector id, or an error message, so there
 * is nothing to accidentally forward. A host increments its own metrics from
 * these numbers; no adapter here creates a logger, an exporter, or a network
 * client.
 *
 * ## What the six numbers mean
 *
 * They count **values** (string leaves), not credentials and not host events:
 *
 * - `scanned` — leaves handed to the core. A leaf refused by a bound before
 *   the core saw it is not one of these.
 * - `findings` — findings the core reported, summed over those leaves. This
 *   is **not** a count of distinct credentials: one credential repeated in
 *   five leaves is five findings, and the core may report several findings
 *   for one leaf.
 * - `redacted` — leaves whose text the core changed. Lower than `findings`
 *   whenever a finding's action leaves text alone (a `warn`), and higher than
 *   the number of secrets whenever one value carries several.
 * - `blocked` — leaves replaced whole by `[REDACTED:BLOCKED]` because a
 *   finding resolved to `block`.
 * - `limited` — values replaced by `[REDACTED:LIMIT_EXCEEDED]`: past a walk
 *   budget or longer than `maxStringLength`. Never scanned, never passed
 *   through.
 * - `failed` — values the adapter could not scan or represent and replaced
 *   with `[REDACTED:ERROR]`, plus the `[REDACTED:CYCLE]` case. A core throw,
 *   a malformed core result, a throwing getter or `toJSON()`, a self-reference.
 *
 * A host's own delivery outcome — a pino line the `streamWrite` hook had to
 * replace, an OpenTelemetry span this adapter did not forward — is a separate,
 * named field on that host's outcome type, because only that adapter knows it.
 * None of them means "exported": no adapter here learns whether an exporter
 * or a destination succeeded, and none of them claims to.
 */

/** A mutable accumulator. Create one per logical host unit (one log record, one span). */
export interface OutcomeCounter {
  scanned: number;
  findings: number;
  redacted: number;
  blocked: number;
  limited: number;
  failed: number;
}

/** A frozen snapshot of an {@link OutcomeCounter}: what a host adapter hands an observer. */
export type ValueCounts = Readonly<OutcomeCounter>;

/** What one leaf string became. */
export type LeafOutcome = "unchanged" | "redacted" | "blocked" | "limited" | "failed";

export function createOutcomeCounter(): OutcomeCounter {
  return { scanned: 0, findings: 0, redacted: 0, blocked: 0, limited: 0, failed: 0 };
}

/** An immutable copy, safe to hand to an observer that may keep it. */
export function toValueCounts(counter: OutcomeCounter): ValueCounts {
  return Object.freeze({
    scanned: counter.scanned,
    findings: counter.findings,
    redacted: counter.redacted,
    blocked: counter.blocked,
    limited: counter.limited,
    failed: counter.failed,
  });
}

/** Adds `from` into `into`, for a unit whose values were masked in more than one pass. */
export function addCounts(into: OutcomeCounter, from: OutcomeCounter): void {
  into.scanned += from.scanned;
  into.findings += from.findings;
  into.redacted += from.redacted;
  into.blocked += from.blocked;
  into.limited += from.limited;
  into.failed += from.failed;
}

/**
 * Calls `observer` with a frozen outcome, swallowing anything it throws.
 *
 * Observation must never turn a protected result into an unprotected one, so
 * the caller has already finished masking before this runs, and an exception
 * here is neither read nor rethrown. It is also re-entrancy-guarded by the
 * caller: an observer that logs through the same logger it is observing would
 * otherwise recurse.
 */
export function notify<T>(observer: ((outcome: T) => void) | undefined, outcome: T): void {
  if (typeof observer !== "function") return;
  try {
    observer(outcome);
  } catch {
    // Observational only. Never read, never rethrown, never a changed outcome.
  }
}
