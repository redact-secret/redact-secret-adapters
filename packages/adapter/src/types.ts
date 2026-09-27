/**
 * The core contract, imported as types from the core itself. If the core
 * renames an action or reshapes a result, this package fails to compile
 * instead of quietly letting a `block`-worthy secret through.
 */

import type { ScanAndRedactOptions, ScanResult } from "@redact-secret/core";

import type { OutcomeCounter } from "./outcome.js";

/** The injected scanner: `scanAndRedact` from `@redact-secret/core`, or a fake. */
export type ScanAndRedact = (text: string, options?: ScanAndRedactOptions) => ScanResult;

/** The policy type the core's own `scanAndRedact` accepts. */
export type Policy = ScanAndRedactOptions["policy"];

/** Walk budgets; see {@link DEFAULT_LIMITS} in `./mask-leaf.ts`. */
export interface Limits {
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly maxStringLength: number;
  readonly maxTotalLeaves: number;
}

export interface MaskLeafOptions {
  readonly policy?: Policy;
  readonly maxStringLength?: number | undefined;
}

export interface MaskOptions {
  readonly policy?: Policy;
  readonly limits?: Partial<Limits> | undefined;
  /**
   * An optional, caller-owned accumulator the walk adds to while it masks
   * (`createOutcomeCounter()`; see `./outcome.ts`). It holds six non-negative
   * integers and nothing derived from the input. Omit it and nothing is
   * counted. The walk only ever increments it — a host adapter owns the
   * lifetime, which is how "one summary per log record or span" is kept
   * accurate across more than one masking pass.
   */
  readonly counter?: OutcomeCounter | undefined;
}
