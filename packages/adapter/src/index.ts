export { createMaskSecrets } from "./create-mask-secrets.js";
export {
  BLOCK_MARKER,
  CYCLE_MARKER,
  countLeaf,
  DEFAULT_LIMITS,
  ERROR_MARKER,
  LIMIT_MARKER,
  type MaskedLeaf,
  maskLeafOutcomeWith,
  maskLeafWith,
} from "./mask-leaf.js";
export { maskLogValueWith, maskSecretsWith } from "./mask-secrets.js";
export {
  addCounts,
  createOutcomeCounter,
  type LeafOutcome,
  notify,
  type OutcomeCounter,
  toValueCounts,
  type ValueCounts,
} from "./outcome.js";
export type { Limits, MaskLeafOptions, MaskOptions, Policy, ScanAndRedact } from "./types.js";
export {
  isStrictWalkLimits,
  type StrictVisit,
  type StrictWalkFailure,
  type StrictWalkLimits,
  type StrictWalkResult,
  type StrictWalkVisitors,
  walkStrict,
} from "./walk-strict.js";
