/**
 * `maskSecretsWith`: the generic masking callback, shaped so
 * `(data) => maskSecretsWith(scanAndRedact, data)` is a drop-in Langfuse JS
 * `mask` hook (`mask: ({ data }) => maskSecrets(data)`, see
 * `./create-mask-secrets.ts`). It never imports `@redact-secret/core`
 * itself — `scanAndRedact` is injected — so this file is testable without
 * the built native addon.
 */

import { CYCLE_MARKER, LIMIT_MARKER } from "./mask-leaf.js";
import type { MaskOptions, ScanAndRedact } from "./types.js";
import { createWalkContext, defineDataKey, isPlainObject, maskString, type WalkContext } from "./walk.js";

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

  // Numbers, booleans, null, undefined, and non-plain objects (Date, class
  // instances, ...) are left unchanged: only plain objects, arrays, and
  // strings are walked.
  return value;
}

/**
 * Recursively masks every string inside a plain object/array tree.
 * `scanAndRedact` is called once per leaf string, so a `<SECRET_1>`-style
 * placeholder index restarts at each leaf — identical to calling
 * `scanAndRedact` directly on that one string.
 */
export function maskSecretsWith(scanAndRedact: ScanAndRedact, data: unknown, options: MaskOptions = {}): unknown {
  if (typeof scanAndRedact !== "function") {
    throw new TypeError("maskSecretsWith: scanAndRedact must be a function");
  }
  return maskValue(scanAndRedact, data, createWalkContext(options), 0, new Set());
}
