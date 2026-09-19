/**
 * Recursively masks every string inside a pino merging-object tree,
 * including an `Error` value's `message` and `stack`. Structurally the
 * same walk as `./mask-secrets.ts`'s `maskValue` — plain objects, arrays,
 * and string leaves — plus one addition: an `Error` instance is not a
 * plain object, so the tracing walker would leave it untouched, but pino's
 * default `err` serializer turns it into `{ type, message, stack, ... }`
 * and *that* is where a secret in `err.message` becomes visible. This
 * walker pre-empts that by replacing the `Error` itself with an
 * already-redacted plain object in the same shape, before pino's
 * serializer (or `hooks.logMethod`'s caller) ever sees the raw message.
 */

import { CYCLE_MARKER, LIMIT_MARKER } from "./mask-leaf.js";
import type { MaskOptions, ScanAndRedact } from "./types.js";
import { createWalkContext, defineDataKey, isPlainObject, maskString, type WalkContext } from "./walk.js";

/**
 * Redacts an `Error`'s own enumerable string properties plus the standard
 * `message` and `stack` accessors, matching the shape
 * `pino.stdSerializers.err` would have produced — pre-redacted, so that
 * serializer (which only transforms `instanceof Error` values) sees our
 * plain object, finds it is not an `Error`, and passes it through
 * unchanged.
 */
function maskError(
  scanAndRedact: ScanAndRedact,
  error: Error,
  ctx: WalkContext,
  depth: number,
  seen: Set<object>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {
    // `constructor.name` here is deliberately "the object's own", not the
    // original error's: if a host's `serializers.err` runs afterward (the
    // pino default does), it re-derives `type` from `constructor.name`
    // too, which reports "Object" — confirmed against pino 10.3.1 — since
    // this value is a plain object, not an `Error`, by the time that
    // serializer sees it. Harmless (`type` never carried a secret either
    // way) and worth knowing if a log line's `err.type` reads "Object"
    // instead of "Error".
    type: error.name ?? error.constructor?.name ?? "Error",
    message: maskString(scanAndRedact, String(error.message ?? ""), ctx),
  };
  if (typeof error.stack === "string") {
    out.stack = maskString(scanAndRedact, error.stack, ctx);
  }
  const own = error as unknown as Record<string, unknown>;
  for (const key of Object.keys(error)) {
    if (key === "message" || key === "stack") continue;
    defineDataKey(out, key, maskValue(scanAndRedact, own[key], ctx, depth + 1, seen));
  }
  if (error.cause !== undefined) {
    out.cause = maskValue(scanAndRedact, error.cause, ctx, depth + 1, seen);
  }
  return out;
}

function maskValue(
  scanAndRedact: ScanAndRedact,
  value: unknown,
  ctx: WalkContext,
  depth: number,
  seen: Set<object>,
): unknown {
  if (typeof value === "string") {
    return maskString(scanAndRedact, value, ctx);
  }

  if (value instanceof Error) {
    if (depth >= ctx.limits.maxDepth) return LIMIT_MARKER;
    if (seen.has(value)) return CYCLE_MARKER;
    seen.add(value);
    const masked = maskError(scanAndRedact, value, ctx, depth, seen);
    seen.delete(value);
    return masked;
  }

  if (Array.isArray(value)) {
    if (depth >= ctx.limits.maxDepth) return LIMIT_MARKER;
    if (seen.has(value)) return CYCLE_MARKER;
    seen.add(value);
    // Elements beyond the limit are dropped, never passed through unmasked.
    const bounded = value.slice(0, ctx.limits.maxArrayLength);
    const masked = bounded.map((item) => maskValue(scanAndRedact, item, ctx, depth + 1, seen));
    seen.delete(value);
    return masked;
  }

  if (isPlainObject(value)) {
    if (depth >= ctx.limits.maxDepth) return LIMIT_MARKER;
    if (seen.has(value)) return CYCLE_MARKER;
    seen.add(value);
    // Keys beyond the limit are dropped, never passed through unmasked.
    const keys = Object.keys(value).slice(0, ctx.limits.maxObjectKeys);
    const out = {};
    for (const key of keys) {
      defineDataKey(out, key, maskValue(scanAndRedact, value[key], ctx, depth + 1, seen));
    }
    seen.delete(value);
    return out;
  }

  // Numbers, booleans, null, undefined, and non-plain/non-Error objects
  // (Date, class instances, ...) are left unchanged: only plain objects,
  // arrays, Errors, and strings are walked.
  return value;
}

/**
 * Recursively masks every string (and every `Error`'s `message`/`stack`)
 * inside a plain object/array tree. `scanAndRedact` is called once per
 * leaf string, so a `<SECRET_1>`-style placeholder index restarts at each
 * leaf.
 */
export function maskLogValueWith(scanAndRedact: ScanAndRedact, data: unknown, options: MaskOptions = {}): unknown {
  if (typeof scanAndRedact !== "function") {
    throw new TypeError("maskLogValueWith: scanAndRedact must be a function");
  }
  return maskValue(scanAndRedact, data, createWalkContext(options), 0, new Set());
}
