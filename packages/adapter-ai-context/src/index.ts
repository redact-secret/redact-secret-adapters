/**
 * `@redact-secret/adapter-ai-context`: the framework-neutral AI-context
 * boundary (redact-secret/redact-secret#610) over the Redact Secret core.
 *
 * ```js
 * import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";
 *
 * // Conservative documented defaults; override any limit set explicitly.
 * const boundary = await createAiContextBoundary();
 *
 * const context = boundary.buildContext([
 *   { role: "user", boundary: "user-input", text: userText },
 *   { role: "tool", boundary: "tool-result", value: toolResult },
 * ]);
 * if (context.outcome === "ok") callModel(context.value);
 * ```
 *
 * The limits are still mandatory and still finite — there is no unbounded
 * mode. What `AI_CONTEXT_DEFAULT_LIMITS` removes is only the need to invent
 * them before the first call; `createAiContextBoundaryWith`, the injected API,
 * requires all three explicitly, unchanged.
 *
 * This file is the only code in the package that loads `@redact-secret/core`
 * at runtime, and does so on call (as `@redact-secret/adapter`'s
 * `createMaskSecrets` does), so importing the injected API never loads the
 * native core.
 *
 * PII detection is opt-in and process-wide in the core. Omit `pii` and this
 * factory initializes the core as before and accepts whatever selection the
 * application already activated, in either order. Pass
 * `createAiContextBoundary({ pii: ["pii:global"] })` to activate a selection
 * from here instead; a selection that cannot be shown to be active fails the
 * boundary closed rather than quietly running with PII off. See
 * `@redact-secret/adapter`'s `activateCore` for the whole rule, including why
 * activation is not the same as masking every PII value.
 */

import { activateCore, type CoreActivation } from "@redact-secret/adapter";

import { createAiContextBoundaryWith } from "./boundary.js";
import { type AiContextBoundaryOptionsWithDefaults, withDefaultLimits } from "./defaults.js";
import type { AiContextBoundary, AiContextCore } from "./types.js";

export type { CoreActivation } from "@redact-secret/adapter";
export { BLOCK_REASONS, createAiContextBoundaryWith, SAFE_FINDING_FIELDS } from "./boundary.js";
export {
  AI_CONTEXT_DEFAULT_LIMITS,
  type AiContextBoundaryOptionsWithDefaults,
  type AiContextLimits,
  withDefaultLimits,
} from "./defaults.js";
export type {
  AbortedOutcome,
  AiContextBoundary,
  AiContextBoundaryOptions,
  AiContextCore,
  AiContextOutcome,
  AiContextStream,
  BlockedOutcome,
  BlockReason,
  BoundaryLabel,
  CancellationSignal,
  ContextMessage,
  ContextPart,
  FindingContext,
  JsonValue,
  OkOutcome,
  OperationOptions,
  SafeFinding,
  TraversalLimits,
} from "./types.js";

/**
 * Loads `@redact-secret/core`, awaits its `initialize()`, and returns the
 * boundary over it.
 *
 * Any limit set left out of `options` comes from
 * `AI_CONTEXT_DEFAULT_LIMITS` — documented, finite values, never an
 * unbounded mode. A limit set that is given is used exactly as given.
 * Passing all three, as callers before `0.1.0-alpha.2` had to, behaves
 * exactly as it did.
 *
 * `options.pii` activates core PII selectors for the whole process. Omitted,
 * an activation the application already made is accepted rather than fought
 * over — a `PII_ACTIVATION_CONFLICT` is not an initialization failure here.
 * Given, a selection that is not the one actually active is an initialization
 * failure like any other, and takes the fail-closed path below, because this
 * factory does not reject.
 *
 * Never rejects for an initialization failure: if the core cannot be loaded
 * or initialized, the returned boundary fails every operation closed with
 * the same fixed outcome the core's error maps to (`blocked` /
 * `core_error` / `INITIALIZATION_FAILED` for the core's own failure, no
 * code for anything else — a PII activation refusal has no core code and so
 * lands on `blocked` / `core_error` with none). Call this again to retry.
 * Rejects only for malformed `options`, with a fixed message.
 */
export async function createAiContextBoundary(
  options: AiContextBoundaryOptionsWithDefaults = {},
): Promise<AiContextBoundary> {
  // Before the core is touched: malformed options are a programming error,
  // not something to load a native addon for.
  const resolved = withDefaultLimits(options);
  // Read by property, not by rest-destructuring, so an activation reaching
  // `options` through a prototype survives — the same rule `withDefaultLimits`
  // follows for `policy`, `placeholderFormatter` and `onFinding`.
  const activation: CoreActivation = options.pii === undefined ? {} : { pii: options.pii };
  let core: AiContextCore;
  try {
    const loaded = await import("@redact-secret/core");
    await activateCore(loaded, activation);
    core = loaded;
  } catch (error) {
    // The core's own error is thrown again, unread, by every operation, so
    // it is mapped by the one failure path every other core error takes.
    const fails = (): never => {
      throw error;
    };
    core = { scanAndRedact: fails, createIncrementalSanitizer: fails };
  }
  return createAiContextBoundaryWith(core, resolved);
}
