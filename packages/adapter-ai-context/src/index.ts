/**
 * `@redact-secret/adapter-ai-context`: the framework-neutral AI-context
 * boundary (redact-secret/redact-secret#610) over the Redact Secret core.
 *
 * ```js
 * import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";
 *
 * const boundary = await createAiContextBoundary({
 *   wholeInputLimits: { maxInputBytes: 65536, maxFindings: 256 },
 *   incrementalLimits: {
 *     maxInputCodeUnits: 1048576,
 *     maxBufferedCodeUnits: 65536,
 *     maxTokenCodeUnits: 8192,
 *     maxMultilineCodeUnits: 32768,
 *   },
 *   traversalLimits: { maxDepth: 16, maxNodes: 4096 },
 * });
 *
 * const context = boundary.buildContext([
 *   { role: "user", boundary: "user-input", text: userText },
 *   { role: "tool", boundary: "tool-result", value: toolResult },
 * ]);
 * if (context.outcome === "ok") callModel(context.value);
 * ```
 *
 * This file is the only code in the package that loads `@redact-secret/core`
 * at runtime, and does so on call (as `@redact-secret/adapter`'s
 * `createMaskSecrets` does), so importing the injected API never loads the
 * native core.
 */

import { createAiContextBoundaryWith } from "./boundary.js";
import type { AiContextBoundary, AiContextBoundaryOptions, AiContextCore } from "./types.js";

export { BLOCK_REASONS, createAiContextBoundaryWith, SAFE_FINDING_FIELDS } from "./boundary.js";
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
 * Never rejects for an initialization failure: if the core cannot be loaded
 * or initialized, the returned boundary fails every operation closed with
 * the same fixed outcome the core's error maps to (`blocked` /
 * `core_error` / `INITIALIZATION_FAILED` for the core's own failure, no
 * code for anything else). Call this again to retry. Rejects only for
 * malformed `options`, with a fixed message.
 */
export async function createAiContextBoundary(options: AiContextBoundaryOptions): Promise<AiContextBoundary> {
  let core: AiContextCore;
  try {
    const loaded = await import("@redact-secret/core");
    await loaded.initialize();
    core = loaded;
  } catch (error) {
    // The core's own error is thrown again, unread, by every operation, so
    // it is mapped by the one failure path every other core error takes.
    const fails = (): never => {
      throw error;
    };
    core = { scanAndRedact: fails, createIncrementalSanitizer: fails };
  }
  return createAiContextBoundaryWith(core, options);
}
