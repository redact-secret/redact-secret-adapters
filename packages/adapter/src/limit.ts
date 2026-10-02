/**
 * `value` if it is a usable bound, else `fallback`. `undefined`, `NaN`, a
 * negative number, or a non-number would otherwise disable a limit
 * (`length > NaN` is never true) or override the default by accident.
 */
export function resolveLimit(value: unknown, fallback: number): number {
  return typeof value === "number" && value >= 0 ? value : fallback;
}
