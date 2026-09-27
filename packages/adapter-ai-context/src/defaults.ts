/**
 * A conservative, named default for the three limit sets
 * (redact-secret/redact-secret-adapters#46).
 *
 * The boundary's limits are mandatory on purpose: the core enforces the
 * whole-input and incremental bounds *before* the detection work they exist to
 * prevent, and this package enforces the traversal bounds. What was wrong was
 * only that a new caller had to invent four security numbers before the first
 * `sanitizeText` — so the numbers are named here instead of guessed there.
 *
 * **There is no unbounded mode.** This preset is a set of finite values, not a
 * way to switch bounds off; every one of them can still be overridden, and the
 * strict, fully explicit API (`createAiContextBoundaryWith`) is unchanged.
 *
 * The values are the ones this repository has been exercising: they are what
 * the package README's example, the clean-install smoke test, and the core's
 * own conformance replay run with, and `test/defaults.test.ts` asserts the real
 * core accepts them and that a streamed text agrees with `sanitizeText` at
 * every chunk partition under them.
 */

import type { AiContextBoundaryOptions } from "./types.js";

/**
 * The three limit sets of {@link AiContextBoundaryOptions}, as one object. Each
 * is read off the options type, so the core's own limit shapes stay the single
 * source of truth.
 */
export type AiContextLimits = Pick<
  AiContextBoundaryOptions,
  "wholeInputLimits" | "incrementalLimits" | "traversalLimits"
>;

/**
 * Conservative bounds for a first integration. Deliberately far below what a
 * process could survive, so the failure a caller meets first is a fixed
 * `blocked` / `limit_exceeded` outcome on an oversized input rather than an
 * unbounded scan:
 *
 * | Limit | Value | Bounds |
 * | --- | --- | --- |
 * | `maxInputBytes` | 65536 (64 KiB) | one whole-input scan |
 * | `maxFindings` | 256 | findings the core will collect for one scan |
 * | `maxInputCodeUnits` | 1048576 (1 Mi) | one streamed session, total |
 * | `maxBufferedCodeUnits` | 65536 | what a session holds while a candidate is open |
 * | `maxTokenCodeUnits` | 8192 | one candidate token |
 * | `maxMultilineCodeUnits` | 32768 | one multi-line candidate |
 * | `maxDepth` | 16 | nested containers, the root counting as 1 |
 * | `maxNodes` | 4096 | values visited in one `sanitizeValue` |
 */
export const AI_CONTEXT_DEFAULT_LIMITS: AiContextLimits = Object.freeze({
  wholeInputLimits: Object.freeze({ maxInputBytes: 65_536, maxFindings: 256 }),
  incrementalLimits: Object.freeze({
    maxInputCodeUnits: 1_048_576,
    maxBufferedCodeUnits: 65_536,
    maxTokenCodeUnits: 8_192,
    maxMultilineCodeUnits: 32_768,
  }),
  traversalLimits: Object.freeze({ maxDepth: 16, maxNodes: 4_096 }),
});

/** {@link AiContextBoundaryOptions} with each limit set optional. */
export type AiContextBoundaryOptionsWithDefaults = Omit<
  AiContextBoundaryOptions,
  "wholeInputLimits" | "incrementalLimits" | "traversalLimits"
> &
  Partial<AiContextLimits>;

const LIMIT_KEYS = ["wholeInputLimits", "incrementalLimits", "traversalLimits"] as const;

/**
 * Every documented key of {@link AiContextBoundaryOptions}, read by name.
 *
 * `createAiContextBoundaryWith` destructures `options`, which follows the
 * prototype chain, so an options object layered over a shared base
 * (`Object.create(defaults)`) kept its `policy` before this module existed. A
 * plain spread copies own enumerable properties only and would drop it — which
 * would silently run the boundary on the core's default policy. So the three
 * non-limit keys are read with `in` and a property read, both of which follow
 * the chain.
 */
const OPTION_KEYS = [...LIMIT_KEYS, "policy", "placeholderFormatter", "onFinding"] as const;

/**
 * Fills in any limit set `options` **omits** from
 * {@link AI_CONTEXT_DEFAULT_LIMITS}, and returns complete
 * {@link AiContextBoundaryOptions}.
 *
 * Three rules, each there to keep a default from hiding a mistake:
 *
 * 1. **Omitted means defaulted; present means used as given.** A limit set
 *    that is passed is not merged field by field with the preset, because a
 *    half-specified set is the kind of thing a caller should see rejected by
 *    the core rather than silently completed.
 * 2. **A key that is present but `undefined` is still an error.** It is how
 *    `traversalLimits: config.limits` looks when `config` is missing, and
 *    turning that into the preset would hide the bug. It reaches
 *    `createAiContextBoundaryWith`'s validation and throws, exactly as before
 *    this preset existed.
 * 3. Everything that is not a limit set (`policy`, `placeholderFormatter`,
 *    `onFinding`) passes through untouched, **including when it reaches
 *    `options` through a prototype** — see {@link OPTION_KEYS}.
 *
 * That is the whole migration path: an existing caller that passes all three
 * sets gets exactly what it passed, an existing caller that passed a broken
 * one still gets the same `TypeError`, and `createAiContextBoundaryWith` still
 * requires all three.
 */
export function withDefaultLimits(options: AiContextBoundaryOptionsWithDefaults = {}): AiContextBoundaryOptions {
  if (options === null || typeof options !== "object") {
    throw new TypeError("createAiContextBoundary: options are required");
  }
  const source = options as Record<string, unknown>;
  // Own enumerable keys first, so a key this module does not know about — a
  // future option the boundary adds — is still forwarded rather than dropped.
  const resolved: Record<string, unknown> = { ...options };
  // Both `in` and the read follow the prototype chain, which a spread does not.
  for (const key of OPTION_KEYS) if (key in source) resolved[key] = source[key];
  // `in`, not `?? default`: an explicit `undefined` is a caller's bug, not an
  // omission, and must still fail loudly.
  for (const key of LIMIT_KEYS) if (!(key in source)) resolved[key] = AI_CONTEXT_DEFAULT_LIMITS[key];
  return resolved as unknown as AiContextBoundaryOptions;
}
