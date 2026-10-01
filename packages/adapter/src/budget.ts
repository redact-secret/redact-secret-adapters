/**
 * The operation-owned aggregate budget (redact-secret/redact-secret-adapters#173).
 *
 * Per-string and per-walk bounds do not bound a whole host operation: a span
 * has many attributes, events and links, a log record is masked by two pino
 * hooks, and an AI context is built from many parts, each starting its own
 * traversal. An *operation* is the unit a host counts in (one log record, one
 * span, one `buildContext` or `sanitizeValue` call, one `maskSecrets` call),
 * and one {@link OperationBudget} is created for it and shared by every pass
 * and field that belongs to it. Many individually valid fields therefore
 * cannot multiply the total work or the retained findings.
 *
 * ## What each counter counts
 *
 * Six counters, with the meaning fixed here. **Occurrences** are counted where
 * a value is *visited*, however it is reached and whether or not its scan was
 * memoized, so a shared reference reached by two paths counts twice. **Actual
 * calls** are counted where work is *done*, so a memoized repeat costs nothing.
 *
 * | Counter | Counts | Unit |
 * | --- | --- | --- |
 * | `maxNodes` | every value visited, containers and leaves alike | occurrences |
 * | `maxKeys` | every object key or attribute name visited | occurrences |
 * | `maxLeaves` | every string leaf handed to a scan | occurrences |
 * | `maxScans` | every `scanAndRedact` invocation, key-context views included | actual calls |
 * | `maxBytes` | the UTF-8 bytes of every text handed to `scanAndRedact`, views included | actual calls |
 * | `maxFindings` | every finding the core reported, summed over occurrences | occurrences |
 *
 * `maxNodes`, `maxLeaves` and `maxFindings` are the aggregate form of the
 * per-walk `maxNodes`, `maxTotalLeaves` and the per-scan finding ceiling the
 * core enforces: the per-walk and per-string limits still apply to every
 * pass; this budget is the sum over the operation, and whichever is reached
 * first wins. No existing counter changes meaning, and the outcome counters of
 * `./outcome.ts` are untouched.
 *
 * ## Exhaustion
 *
 * Exhaustion is **sticky**: the first charge that does not fit marks the
 * budget exhausted and every later charge fails too, so nothing after the
 * overrun is scanned or passed on. A charge that fails consumes nothing. What
 * the caller does about it is the host's rule: the marker-based adapters
 * (logging, tracing) replace what could not be inspected with
 * `[REDACTED:LIMIT_EXCEEDED]`; the AI-context and MCP boundaries return a
 * `blocked` / `limit_exceeded` outcome with no value, so a partly approved
 * value never escapes.
 *
 * ## What it is not
 *
 * It is a work counter, not a wall-clock interrupt. It is checked *between*
 * scans, synchronously; one `scanAndRedact` call, once started, runs to its
 * own completion under the core's whole-input limits, and a host callback
 * (a policy, a getter, a `toJSON()`) that never returns is not interrupted
 * either. Cancellation of a running operation needs the host's own timeout or
 * an `AbortSignal` the AI-context boundary already polls between scans.
 */

import { resolveLimit } from "./limit.js";

export interface OperationLimits {
  /** Cumulative UTF-8 bytes handed to `scanAndRedact`, key-context views included. */
  readonly maxBytes: number;
  /** Every value visited, containers and leaves. */
  readonly maxNodes: number;
  /** Every object key or attribute name visited. */
  readonly maxKeys: number;
  /** Every string leaf handed to a scan, memoized repeats included. */
  readonly maxLeaves: number;
  /** Every `scanAndRedact` invocation, key-context views included; memoized repeats are not invocations. */
  readonly maxScans: number;
  /** Every finding the core reported, summed over occurrences. */
  readonly maxFindings: number;
}

/**
 * The defaults. They sit far above any per-walk default so that an ordinary
 * log record, span or context is unaffected, and bound what an adversarial
 * one can cost: a record or span can inspect at most 16 MiB of UTF-8 text in
 * at most 50,000 scans. `maxLeaves` is five times the per-walk
 * `maxTotalLeaves`, and `maxNodes` five times the per-walk `maxNodes`.
 */
export const DEFAULT_OPERATION_LIMITS: OperationLimits = Object.freeze({
  maxBytes: 16 * 1024 * 1024,
  maxNodes: 100_000,
  maxKeys: 100_000,
  maxLeaves: 25_000,
  maxScans: 50_000,
  maxFindings: 100_000,
});

/** Per-key fallback to {@link DEFAULT_OPERATION_LIMITS}, so `NaN`, a negative or a non-number never disables a bound. */
export function resolveOperationLimits(overrides: Partial<OperationLimits> | undefined): OperationLimits {
  const limits: { -readonly [K in keyof OperationLimits]: number } = { ...DEFAULT_OPERATION_LIMITS };
  const source = typeof overrides === "object" && overrides !== null ? overrides : undefined;
  for (const key of Object.keys(DEFAULT_OPERATION_LIMITS) as (keyof OperationLimits)[]) {
    limits[key] = resolveLimit(source?.[key], DEFAULT_OPERATION_LIMITS[key]);
  }
  return Object.freeze(limits);
}

/** What an operation has spent so far. Six non-negative integers; nothing derived from the input. */
export interface OperationUsage {
  readonly bytes: number;
  readonly nodes: number;
  readonly keys: number;
  readonly leaves: number;
  readonly scans: number;
  readonly findings: number;
}

export interface OperationBudget {
  readonly limits: OperationLimits;
  /** `true` once any charge has failed. Sticky. */
  readonly exhausted: boolean;
  /** What has been spent. A failed charge spends nothing. */
  usage(): OperationUsage;
  chargeNode(): boolean;
  chargeKey(): boolean;
  chargeLeaf(): boolean;
  /** One `scanAndRedact` invocation over `bytes` UTF-8 bytes. */
  chargeScan(bytes: number): boolean;
  chargeFindings(count: number): boolean;
}

/** The number of bytes `text` takes in UTF-8, counting a lone surrogate as the 3 bytes of U+FFFD. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}

/** A fresh budget for one operation. Create one per host operation and share it across every pass of it. */
export function createOperationBudget(overrides?: Partial<OperationLimits>): OperationBudget {
  const limits = resolveOperationLimits(overrides);
  let bytes = 0;
  let nodes = 0;
  let keys = 0;
  let leaves = 0;
  let scans = 0;
  let findings = 0;
  let exhausted = false;

  const fits = (spent: number, add: number, limit: number): boolean => !exhausted && spent + add <= limit;
  const refuse = (): false => {
    exhausted = true;
    return false;
  };

  return {
    limits,
    get exhausted() {
      return exhausted;
    },
    usage: () => ({ bytes, nodes, keys, leaves, scans, findings }),
    chargeNode() {
      if (!fits(nodes, 1, limits.maxNodes)) return refuse();
      nodes += 1;
      return true;
    },
    chargeKey() {
      if (!fits(keys, 1, limits.maxKeys)) return refuse();
      keys += 1;
      return true;
    },
    chargeLeaf() {
      if (!fits(leaves, 1, limits.maxLeaves)) return refuse();
      leaves += 1;
      return true;
    },
    chargeScan(scanBytes) {
      if (!fits(scans, 1, limits.maxScans) || !fits(bytes, scanBytes, limits.maxBytes)) return refuse();
      scans += 1;
      bytes += scanBytes;
      return true;
    },
    chargeFindings(count) {
      if (!fits(findings, count, limits.maxFindings)) return refuse();
      findings += count;
      return true;
    },
  };
}
