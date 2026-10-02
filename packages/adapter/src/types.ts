/**
 * The core contract, imported as types from the core itself. If the core
 * renames an action or reshapes a result, this package fails to compile
 * instead of quietly letting a `block`-worthy secret through.
 */

import type { ScanAndRedactOptions, ScanResult } from "@redact-secret/core";

import type { OperationBudget, OperationLimits } from "./budget.js";
import type { OutcomeCounter } from "./outcome.js";
import type { ScanConfig, ScanOptionsInput } from "./scan-options.js";

/** The injected scanner: `scanAndRedact` from `@redact-secret/core`, or a fake. */
export type ScanAndRedact = (text: string, options?: ScanAndRedactOptions) => ScanResult;

/**
 * The PII activation a live factory takes (see `./activation.ts`).
 *
 * PII detection is opt-in, process-wide and one-shot in the core. Omit `pii`
 * and the adapter asserts no selection of its own: it initializes the core as
 * before and accepts whatever selection the application already activated.
 * Pass `pii` and the adapter activates that selection and refuses to run
 * unless it is the one actually active.
 *
 * Activating selectors turns PII *detection* on, which is not the same as
 * masking every PII value: under the core's default policy, `High`-confidence
 * PII redacts while `Medium` and `Low` resolve to `warn`, and a `warn` finding
 * leaves the text alone. Supply your own `policy` if you need those masked.
 */
export interface CoreActivation {
  /** Core PII selectors to activate, e.g. `["pii:global"]`. Omit to assert no selection. */
  readonly pii?: readonly string[];
}

/**
 * The subset of `@redact-secret/core` the activation helper reads: pass the
 * module itself, or a fake in tests. Nothing else of the core is touched.
 *
 * `initialize` is declared with an optional options argument and
 * `piiActivation` as optional on purpose — a core at this repository's
 * declared floor has neither the argument nor the function, and must keep
 * working. Neither is read from `@redact-secret/core`'s own types, so nothing
 * here raises the declared range.
 */
export interface InitializableCore {
  readonly initialize: (options?: { readonly pii?: readonly string[] }) => Promise<void>;
  readonly piiActivation?: () => string;
}

/** The policy type the core's own `scanAndRedact` accepts. */
export type Policy = ScanAndRedactOptions["policy"];

/** Walk budgets; see {@link DEFAULT_LIMITS} in `./mask-leaf.ts`. */
export interface Limits {
  readonly maxDepth: number;
  readonly maxArrayLength: number;
  readonly maxObjectKeys: number;
  readonly maxStringLength: number;
  readonly maxTotalLeaves: number;
  /**
   * Every value the walk visits — containers and leaves alike, not object
   * keys — counts once per path it is reached by, as in `walkStrict`. Bounds
   * the work for a shared-reference graph, which is walked once per path.
   */
  readonly maxNodes: number;
}

export interface MaskLeafOptions extends ScanOptionsInput {
  /**
   * A scan configuration already validated and snapshotted by
   * `resolveScanConfig`, for a host that builds its masker once and masks many
   * leaves. Wins over `policy`, `scanLimits`, `ruleset` and
   * `placeholderFormatter` given beside it.
   */
  readonly scanConfig?: ScanConfig | undefined;
  readonly maxStringLength?: number | undefined;
  /**
   * The object key (or attribute name) the leaf sits directly under, when the
   * host supplies one. Context for detection only (see `./key-context.ts`):
   * the key is never rewritten, never scanned on its own and never returned.
   * Omit it for a message, an array element, or any leaf with no direct key.
   */
  readonly key?: string | undefined;
  /**
   * The operation's aggregate budget (see `./budget.ts`). Every scan this leaf
   * makes, key-context view included, is charged to it; past it the leaf is
   * `[REDACTED:LIMIT_EXCEEDED]` and the core is not called. Omit it and the
   * leaf is bounded by `maxStringLength` alone.
   */
  readonly budget?: OperationBudget | undefined;
}

export interface MaskOptions extends ScanOptionsInput {
  /** A validated scan configuration; see {@link MaskLeafOptions.scanConfig}. */
  readonly scanConfig?: ScanConfig | undefined;
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
  /**
   * Overrides for this call's aggregate operation budget (see
   * `./budget.ts`), which covers every string, key and value the call
   * visits and is the sum over them, on top of the per-walk `limits`.
   * Omitted keys use `DEFAULT_OPERATION_LIMITS`.
   */
  readonly operationLimits?: Partial<OperationLimits> | undefined;
  /**
   * A caller-owned budget to charge instead of a fresh one, for a host that
   * masks one operation in more than one pass and owns the unit
   * (`createOperationBudget()`). Wins over `operationLimits`.
   */
  readonly operation?: OperationBudget | undefined;
}
