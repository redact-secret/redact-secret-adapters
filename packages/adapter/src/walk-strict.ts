/**
 * The all-or-nothing variant of the shared value-tree walker, for hosts
 * where a partially scanned value is not a safe value (the AI-context
 * boundary, redact-secret/redact-secret#610). {@link walkValue} degrades a
 * subtree to a marker and keeps going; this walker stops at the first
 * problem and returns a failure instead of a value.
 *
 * It accepts exactly the JSON-shaped values: strings, finite numbers,
 * booleans, `null`, arrays, and plain objects (prototype `Object.prototype`
 * or `null`). Anything else — `undefined`, a non-finite number, a bigint, a
 * symbol, a function, a class instance, a `Date`, a `Map`, an array hole, a
 * cycle, or a value whose read throws — is `unsupported_value`. Past a
 * budget it is `limit_exceeded`. No string is scanned here: every string
 * and every object key is handed to the caller's visitor, which owns the
 * scan and may fail the walk with a failure of its own.
 */

import { defineDataKey, isPlainObject } from "./walk.js";

/**
 * `maxDepth` counts nested containers including the root (a flat object is
 * depth 1); `maxNodes` counts every visited value, containers and leaves
 * alike, but not object keys.
 */
export interface StrictWalkLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
}

export type StrictWalkFailure = "limit_exceeded" | "unsupported_value";

/** A visitor's verdict on one string: its replacement, or a failure that ends the walk. */
export type StrictVisit<F> = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly failure: F };

export interface StrictWalkVisitors<F> {
  /** Called once per string leaf, in document order. */
  readonly string: (text: string) => StrictVisit<F>;
  /**
   * Called once per own enumerable object key, before that key's value is
   * walked. A key is kept unchanged when it passes: rewriting a key would
   * change the value's shape.
   */
  readonly key: (key: string) => { readonly ok: true } | { readonly ok: false; readonly failure: F };
}

export type StrictWalkResult<F> =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly failure: F | StrictWalkFailure };

/** `limits` is valid when both bounds are non-negative safe integers. */
export function isStrictWalkLimits(limits: unknown): limits is StrictWalkLimits {
  if (typeof limits !== "object" || limits === null) return false;
  const { maxDepth, maxNodes } = limits as Record<string, unknown>;
  return [maxDepth, maxNodes].every((bound) => Number.isSafeInteger(bound) && (bound as number) >= 0);
}

/**
 * Walks `value` and returns a fresh copy with every string replaced by its
 * visitor's text, or the first failure. Never throws for any input value;
 * a visitor that throws is the caller's bug and propagates.
 *
 * The walk never reads a value twice: each key's value is read once, so a
 * getter cannot hand the visitor one string and the copy another.
 */
export function walkStrict<F>(
  value: unknown,
  limits: StrictWalkLimits,
  visitors: StrictWalkVisitors<F>,
): StrictWalkResult<F> {
  if (!isStrictWalkLimits(limits)) throw new TypeError("walkStrict: limits must be non-negative safe integers");
  let nodes = 0;
  const seen = new Set<object>();
  type Step = { ok: true; value: unknown } | { ok: false; failure: F | StrictWalkFailure };
  const unsupported: Step = { ok: false, failure: "unsupported_value" };
  const overLimit: Step = { ok: false, failure: "limit_exceeded" };

  const visit: StrictWalkVisitors<F> = {
    string: (text) => callVisitor(visitors.string, text),
    key: (key) => callVisitor(visitors.key, key),
  };

  const walk = (node: unknown, depth: number): Step => {
    nodes += 1;
    if (nodes > limits.maxNodes) return overLimit;
    if (typeof node === "string") {
      const visited = visit.string(node);
      return visited.ok ? { ok: true, value: visited.text } : visited;
    }
    if (node === null || typeof node === "boolean" || (typeof node === "number" && Number.isFinite(node))) {
      return { ok: true, value: node };
    }
    if (typeof node !== "object") return unsupported;
    let isArray: boolean;
    try {
      // Both can throw on a revoked Proxy.
      isArray = Array.isArray(node);
      if (!isArray && !isPlainObject(node)) return unsupported;
    } catch {
      return unsupported;
    }
    if (seen.has(node)) return unsupported;
    if (depth + 1 > limits.maxDepth) return overLimit;
    seen.add(node);
    try {
      if (isArray) {
        const source = node as unknown[];
        const out: unknown[] = [];
        const length = source.length;
        for (let index = 0; index < length; index += 1) {
          // A hole reads as `undefined`, which is unsupported: JSON.stringify
          // would invent a `null` for it.
          const child = walk(source[index], depth + 1);
          if (!child.ok) return child;
          out.push(child.value);
        }
        return { ok: true, value: out };
      }
      const source = node as Record<string, unknown>;
      const out = {};
      for (const key of Object.keys(source)) {
        const checked = visit.key(key);
        if (!checked.ok) return checked;
        const child = walk(source[key], depth + 1);
        if (!child.ok) return child;
        defineDataKey(out, key, child.value);
      }
      return { ok: true, value: out };
    } catch (error) {
      // A throwing getter or Proxy trap: the value cannot be read, so it
      // cannot be scanned. A visitor's own exception is not ours to hide.
      if (error instanceof VisitorError) throw error;
      return unsupported;
    } finally {
      seen.delete(node);
    }
  };

  let result: Step;
  try {
    result = walk(value, 0);
  } catch (error) {
    if (error instanceof VisitorError) throw error.cause;
    throw error;
  }
  return result.ok ? { ok: true, value: result.value } : { ok: false, failure: result.failure };
}

/** Wraps a visitor's exception so the walk can tell it apart from a failed read. */
class VisitorError {
  constructor(readonly cause: unknown) {}
}

function callVisitor<A, R>(visitor: (arg: A) => R, arg: A): R {
  try {
    return visitor(arg);
  } catch (error) {
    throw new VisitorError(error);
  }
}
