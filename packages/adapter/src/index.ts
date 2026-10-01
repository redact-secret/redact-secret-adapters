export {
  activateCore,
  activationReflects,
  activePiiActivation,
  CoreActivationError,
  type CoreActivationErrorCode,
  isPiiActivationConflict,
  PII_ACTIVATION_CONFLICT,
  readPiiActivation,
} from "./activation.js";
export {
  createOperationBudget,
  DEFAULT_OPERATION_LIMITS,
  type OperationBudget,
  type OperationLimits,
  type OperationUsage,
  resolveOperationLimits,
  utf8ByteLength,
} from "./budget.js";
export { type CreateMaskSecretsOptions, createMaskSecrets } from "./create-mask-secrets.js";
export {
  KEY_CONTEXT_SUFFIX,
  type KeyContextFailures,
  type KeyContextFinding,
  type KeyContextScanned,
  keyContextPrefix,
  keyContextView,
  scanLeafInKeyContext,
} from "./key-context.js";
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
export { maskKeyedLeavesWith, maskLogValueWith, maskSecretsWith } from "./mask-secrets.js";
export {
  addCounts,
  createOutcomeCounter,
  type LeafOutcome,
  notify,
  type OutcomeCounter,
  toValueCounts,
  type ValueCounts,
} from "./outcome.js";
export type {
  CoreActivation,
  InitializableCore,
  Limits,
  MaskLeafOptions,
  MaskOptions,
  Policy,
  ScanAndRedact,
} from "./types.js";
export {
  isStrictWalkLimits,
  type StrictVisit,
  type StrictWalkFailure,
  type StrictWalkLimits,
  type StrictWalkResult,
  type StrictWalkVisitors,
  walkStrict,
} from "./walk-strict.js";
