/** Shared walk state for `./mask-secrets.ts` and `./mask-log-value.ts`. */

import { DEFAULT_LIMITS, LIMIT_MARKER, maskLeafWith, resolveLimit } from "./mask-leaf.js";
import type { Limits, MaskOptions, Policy, ScanAndRedact } from "./types.js";

export interface WalkContext {
  readonly policy: Policy;
  readonly limits: Limits;
  readonly budget: { leaves: number };
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
  return { policy: options.policy, limits, budget: { leaves: limits.maxTotalLeaves } };
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

export function maskString(scanAndRedact: ScanAndRedact, value: string, ctx: WalkContext): string {
  if (ctx.budget.leaves <= 0) return LIMIT_MARKER;
  ctx.budget.leaves -= 1;
  return maskLeafWith(scanAndRedact, value, {
    policy: ctx.policy,
    maxStringLength: ctx.limits.maxStringLength,
  });
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
