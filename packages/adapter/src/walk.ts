/**
 * The one value-tree walker behind `maskSecretsWith` and `maskLogValueWith`.
 * It masks everything JSON serialization would emit, so no shape of value
 * reaches a host's serializer unmasked.
 */

import {
  CYCLE_MARKER,
  countLeaf,
  DEFAULT_LIMITS,
  ERROR_MARKER,
  LIMIT_MARKER,
  maskLeafOutcomeWith,
  resolveLimit,
} from "./mask-leaf.js";
import type { OutcomeCounter } from "./outcome.js";
import type { Limits, MaskOptions, Policy, ScanAndRedact } from "./types.js";

export interface WalkContext {
  readonly policy: Policy;
  readonly limits: Limits;
  readonly budget: { leaves: number; nodes: number };
  /** Optional, caller-owned: see `./outcome.ts`. Absent means nothing is counted. */
  readonly counter?: OutcomeCounter | undefined;
}

/** Per-key fallback to `DEFAULT_LIMITS`, so `{ maxDepth: undefined }` or `NaN` never disables a bound. */
export function resolveLimits(overrides: Partial<Limits> | undefined): Limits {
  const limits: { -readonly [K in keyof Limits]: number } = { ...DEFAULT_LIMITS };
  for (const key of Object.keys(DEFAULT_LIMITS) as (keyof Limits)[]) {
    limits[key] = resolveLimit(overrides?.[key], DEFAULT_LIMITS[key]);
  }
  return limits;
}

export function createWalkContext(options: MaskOptions): WalkContext {
  const limits = resolveLimits(options.limits);
  return {
    policy: options.policy,
    limits,
    budget: { leaves: limits.maxTotalLeaves, nodes: limits.maxNodes },
    counter: options.counter,
  };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function maskString(scanAndRedact: ScanAndRedact, value: string, ctx: WalkContext): string {
  if (ctx.budget.leaves <= 0) {
    if (ctx.counter !== undefined) ctx.counter.limited += 1;
    return LIMIT_MARKER;
  }
  ctx.budget.leaves -= 1;
  const leaf = maskLeafOutcomeWith(scanAndRedact, value, {
    policy: ctx.policy,
    maxStringLength: ctx.limits.maxStringLength,
  });
  countLeaf(ctx.counter, leaf);
  return leaf.text;
}

/** Defines a data key without invoking inherited setters such as `__proto__`. */
export function defineDataKey(out: object, key: string, value: unknown): void {
  Object.defineProperty(out, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

type Walk = (value: unknown, depth: number) => unknown;

/**
 * Counts a marker this walk produced for a whole value rather than for a
 * scanned leaf: a container past `maxDepth`, a cycle, a value that could not
 * be read. `CYCLE_MARKER` joins `failed` — both are values the walk could
 * not represent.
 */
function countMarker(ctx: WalkContext, marker: string): string {
  if (ctx.counter !== undefined) {
    if (marker === LIMIT_MARKER) ctx.counter.limited += 1;
    else ctx.counter.failed += 1;
  }
  return marker;
}

/**
 * Copies `source`'s own enumerable string keys into `out`, masked. Keys past
 * `maxObjectKeys` are dropped, never passed through; a throwing getter
 * becomes {@link ERROR_MARKER} for that key alone.
 */
function maskProperties(
  source: object,
  out: object,
  walk: Walk,
  ctx: WalkContext,
  depth: number,
  skip?: ReadonlySet<string>,
): void {
  const record = source as Record<string, unknown>;
  const keys = Object.keys(source).filter((key) => !skip?.has(key));
  for (const key of keys.slice(0, ctx.limits.maxObjectKeys)) {
    let masked: unknown;
    try {
      masked = walk(record[key], depth + 1);
    } catch {
      masked = countMarker(ctx, ERROR_MARKER);
    }
    defineDataKey(out, key, masked);
  }
}

// Own properties that would clash with the fixed fields are skipped; `cause`
// is walked once, below, whether or not it is enumerable.
const ERROR_OWN_KEYS: ReadonlySet<string> = new Set(["type", "message", "stack", "cause"]);

/**
 * An `Error` becomes `{ type, message, stack, ...ownProps, cause }`, the
 * shape `pino.stdSerializers.err` emits. `message`, `stack` and `cause` are
 * usually non-enumerable, so a plain property walk would drop them — or,
 * for a host serializer that reads them itself, leave them unmasked.
 */
function maskError(error: Error, scanAndRedact: ScanAndRedact, walk: Walk, ctx: WalkContext, depth: number) {
  const out: Record<string, unknown> = {};
  const name: unknown = error.name;
  out.type = typeof name === "string" ? maskString(scanAndRedact, name, ctx) : "Error";
  out.message = maskString(scanAndRedact, String(error.message ?? ""), ctx);
  if (typeof error.stack === "string") out.stack = maskString(scanAndRedact, error.stack, ctx);
  maskProperties(error, out, walk, ctx, depth, ERROR_OWN_KEYS);
  if (error.cause !== undefined) out.cause = walk(error.cause, depth + 1);
  return out;
}

function maskObject(value: object, scanAndRedact: ScanAndRedact, walk: Walk, ctx: WalkContext, depth: number) {
  if (value instanceof Error) return maskError(value, scanAndRedact, walk, ctx, depth);
  if (Array.isArray(value)) {
    // Elements beyond the limit are dropped, never passed through unmasked.
    return value.slice(0, ctx.limits.maxArrayLength).map((item) => walk(item, depth + 1));
  }
  // Serialize the way JSON.stringify would: a boxed primitive is its
  // primitive, and `toJSON()` replaces the value (Date, URL, Buffer, ...).
  // Checked on plain objects too: a toJSON left on the masked copy would
  // run again at serialization time and emit its unmasked result.
  if (value instanceof String) return maskString(scanAndRedact, value.valueOf(), ctx);
  if (value instanceof Number || value instanceof Boolean) return value.valueOf();
  const toJSON: unknown = (value as { toJSON?: unknown }).toJSON;
  if (typeof toJSON === "function") {
    let json: unknown;
    try {
      json = toJSON.call(value, "");
    } catch {
      return countMarker(ctx, ERROR_MARKER);
    }
    // One level deeper, so a toJSON that returns a fresh toJSON object
    // each call still terminates at maxDepth.
    return walk(json, depth + 1);
  }
  // Plain objects, and any other instance (class, IncomingMessage, Map, ...)
  // as the own enumerable properties JSON.stringify would emit.
  const out = {};
  maskProperties(value, out, walk, ctx, depth);
  return out;
}

/**
 * Masks every string reachable in `data`. Never throws: a value that cannot
 * be read (throwing getter or `toJSON`, revoked proxy) becomes
 * {@link ERROR_MARKER}, a repeat visit {@link CYCLE_MARKER}, and anything
 * past a budget {@link LIMIT_MARKER}. Numbers, booleans, `null`,
 * `undefined`, bigints, symbols and functions pass through unchanged
 * until `maxNodes` is spent; past it, every value is {@link LIMIT_MARKER}.
 */
export function walkValue(scanAndRedact: ScanAndRedact, data: unknown, options: MaskOptions): unknown {
  const ctx = createWalkContext(options);
  const seen = new Set<object>();
  const walk: Walk = (value, depth) => {
    // Every visit counts, once per path: `seen` holds only the current
    // path, so a shared reference is walked again from each parent.
    if (ctx.budget.nodes <= 0) return countMarker(ctx, LIMIT_MARKER);
    ctx.budget.nodes -= 1;
    if (typeof value === "string") return maskString(scanAndRedact, value, ctx);
    if (typeof value !== "object" || value === null) return value;
    if (depth >= ctx.limits.maxDepth) return countMarker(ctx, LIMIT_MARKER);
    if (seen.has(value)) return countMarker(ctx, CYCLE_MARKER);
    seen.add(value);
    try {
      return maskObject(value, scanAndRedact, walk, ctx, depth);
    } catch {
      return countMarker(ctx, ERROR_MARKER);
    } finally {
      seen.delete(value);
    }
  };
  return walk(data, 0);
}
