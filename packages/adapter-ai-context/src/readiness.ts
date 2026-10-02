/**
 * An explicit, input-free readiness check for the live AI-context factory
 * (redact-secret/redact-secret-adapters#182).
 *
 * `createAiContextBoundary` never rejects for a core load or initialization
 * failure; it returns a boundary that fails every operation closed. That is
 * safe, but a resolved factory promise can be mistaken for a service that is
 * ready. {@link checkAiContextReady} is the question an application asks at
 * startup, or before it retries, instead of making a first request to find out.
 *
 * What it does, in order, stopping at the first failure:
 *
 * 1. Loads `@redact-secret/core`.
 * 2. Runs the same activation step the factory runs (`activateCore`): the core's
 *    `initialize()`, with `pii` forwarded when given, and the explicit PII
 *    selection verified to be the active one.
 * 3. Scans one fixed, synthetic probe held by this package, under fixed small
 *    limits and the core's default policy, and checks the result is shaped as
 *    documented and redacted the probe.
 *
 * What it guarantees:
 *
 * - It accepts no input. The only option is `pii`, the same selection the
 *   factory takes. There is no way to supply a probe, a limit, a policy or a
 *   callback, so it never invokes an application `policy`,
 *   `placeholderFormatter` or `onFinding`: it checks the core, not the
 *   application's configuration of it.
 * - It never rejects and never reports an exception, a message, a path or a
 *   scanned value. The result is a fixed status code, three fixed stage
 *   states, and at most the core's own public PII activation identity.
 * - It holds no state. A failed check cannot make any boundary pass plaintext:
 *   boundaries are separate objects, and a boundary created after a failed
 *   core load still fails every operation closed. A check that fails is retried
 *   by calling it again.
 * - It does no network, filesystem, environment or log work of its own, and
 *   changes no policy. It can call `initialize()` again, exactly as a second
 *   factory call would; the core makes that idempotent and refuses a different
 *   PII selection rather than replacing the active one.
 *
 * What a `ready` result is not: it is readiness at that moment. It does not
 * prove detection completeness, that a boundary is placed on every path to a
 * model, that anything is delivered, or that a later request will succeed.
 */

import { activateCore, CoreActivationError } from "@redact-secret/adapter";

/** The fixed outcomes of {@link checkAiContextReady}. A new code is a contract change. */
export const READINESS_STATUSES = Object.freeze([
  "ready",
  "invalid_options",
  "core_unavailable",
  "initialization_failed",
  "pii_activation_unsupported",
  "pii_activation_not_active",
  "malformed_response",
  "probe_failed",
  "probe_not_redacted",
] as const);

export type ReadinessStatus = (typeof READINESS_STATUSES)[number];

/** How far the check got: `skipped` means an earlier stage failed or the stage was not requested. */
export type ReadinessStage = "ok" | "failed" | "skipped";

export interface ReadinessOptions {
  /** The PII selection to verify, as `createAiContextBoundary({ pii })` takes it. Omit to accept the application's own. */
  readonly pii?: readonly string[];
}

export interface ReadinessResult {
  readonly ready: boolean;
  readonly status: ReadinessStatus;
  /** Core loaded and `initialize()` completed. */
  readonly core: ReadinessStage;
  /** The explicit `pii` selection is the active one. `skipped` when `pii` was not given. */
  readonly pii: ReadinessStage;
  /** The fixed synthetic probe was redacted. */
  readonly probe: ReadinessStage;
  /**
   * The core's own canonical PII activation identity, when it reports one in
   * the documented shape. Public capability metadata; never derived from input.
   */
  readonly activation?: string;
}

const PROBE_LIMITS = Object.freeze({ maxInputBytes: 1024, maxFindings: 8 });

/** Synthetic and revoked; assembled at runtime so no scanner flags this source. */
const PROBE_TOKEN = `ghp_${"SYNTHETICREVOKED"}${"0".repeat(20)}`;
const PROBE = `readiness probe ${PROBE_TOKEN}`;

/** The documented identity shape, and nothing the core could stuff arbitrary text into. */
const ACTIVATION_IDENTITY = /^[A-Za-z0-9=;:,._/-]{0,512}$/;

interface ProbeCore {
  readonly initialize?: unknown;
  readonly piiActivation?: unknown;
  readonly scanAndRedact?: unknown;
}

function result(
  status: ReadinessStatus,
  stages: { core: ReadinessStage; pii: ReadinessStage; probe: ReadinessStage },
  activation?: string,
): ReadinessResult {
  const base = { ready: status === "ready", status, ...stages };
  return Object.freeze(activation === undefined ? base : { ...base, activation });
}

/** `options.pii`, read defensively; `undefined` for a malformed option set. */
function readSelection(options: unknown): { pii: readonly string[] | undefined } | undefined {
  try {
    if (options === undefined) return { pii: undefined };
    if (options === null || typeof options !== "object") return undefined;
    const pii: unknown = (options as { pii?: unknown }).pii;
    if (pii === undefined) return { pii: undefined };
    if (!Array.isArray(pii) || !pii.every((selector) => typeof selector === "string")) return undefined;
    return { pii: [...(pii as string[])] };
  } catch {
    return undefined;
  }
}

/**
 * Whether the core is loaded, initialized, and able to redact a fixed
 * synthetic probe right now. Resolves, never rejects, and never carries input
 * or an exception. See the module comment for the whole contract.
 */
export async function checkAiContextReady(options: ReadinessOptions = {}): Promise<ReadinessResult> {
  const selection = readSelection(options);
  const none = { core: "skipped", pii: "skipped", probe: "skipped" } as const;
  if (selection === undefined) return result("invalid_options", none);
  const requested = selection.pii !== undefined;

  let core: ProbeCore;
  try {
    core = (await import("@redact-secret/core")) as unknown as ProbeCore;
  } catch {
    return result("core_unavailable", none);
  }

  // Read once: a getter that changes between reads cannot split the check.
  let initialize: unknown;
  let scanAndRedact: unknown;
  try {
    ({ initialize, scanAndRedact } = core);
  } catch {
    return result("malformed_response", none);
  }
  if (typeof initialize !== "function" || typeof scanAndRedact !== "function") {
    return result("malformed_response", none);
  }

  let activation: string | undefined;
  try {
    activation = await activateCore(core as Parameters<typeof activateCore>[0], requested ? { pii: selection.pii } : {});
  } catch (error) {
    if (error instanceof CoreActivationError) {
      const status =
        error.code === "PII_ACTIVATION_UNSUPPORTED" ? "pii_activation_unsupported" : "pii_activation_not_active";
      // The core initialized; only the explicit selection could not be shown.
      return result(status, { core: "ok", pii: "failed", probe: "skipped" });
    }
    return result("initialization_failed", { core: "failed", pii: "skipped", probe: "skipped" });
  }
  const identity = typeof activation === "string" && ACTIVATION_IDENTITY.test(activation) ? activation : undefined;
  const piiStage: ReadinessStage = requested ? "ok" : "skipped";

  let scanned: unknown;
  try {
    scanned = (scanAndRedact as (input: string, options: unknown) => unknown)(PROBE, {
      wholeInputLimits: PROBE_LIMITS,
    });
  } catch {
    return result("probe_failed", { core: "ok", pii: piiStage, probe: "failed" }, identity);
  }
  const stages = { core: "ok", pii: piiStage, probe: "failed" } as const;
  if (scanned === null || typeof scanned !== "object") return result("malformed_response", stages, identity);
  const { text, findings } = scanned as { text?: unknown; findings?: unknown };
  if (typeof text !== "string" || !Array.isArray(findings)) return result("malformed_response", stages, identity);
  if (text.includes(PROBE_TOKEN) || findings.length === 0) return result("probe_not_redacted", stages, identity);
  return result("ready", { core: "ok", pii: piiStage, probe: "ok" }, identity);
}
