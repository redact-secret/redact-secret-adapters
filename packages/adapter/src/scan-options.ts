/**
 * The verified core scan options the logging and tracing adapters pass
 * through (redact-secret/redact-secret-adapters#175): whole-input limits, a
 * declarative ruleset, and a placeholder formatter, beside the `policy` they
 * always passed.
 *
 * The core owns every one of them. This module detects nothing and decides no
 * policy: it validates the *shape* of what a caller asked for, takes a
 * **snapshot** of it, and hands exactly that to `scanAndRedact` on every
 * scan, so the adapter's own limits (traversal, aggregate budget, line
 * ceilings) stay separate from what the core is asked to enforce.
 *
 * ## Names
 *
 * `limits` is already the adapter's *walk* limits (`DEFAULT_LIMITS`), so the
 * core's whole-input limits are `scanLimits`. `ruleset` and
 * `placeholderFormatter` keep the core's names.
 *
 * ## Policy precedence
 *
 * There is exactly one policy and the adapter never combines two. The
 * caller's `policy`, when given, **replaces** the core's built-in policy for
 * every finding, including those a `ruleset` detector adds; omit it and the
 * core's built-in policy decides. An adapter's own rules (a `block` finding
 * replaces the whole leaf; a `warn` leaves the text alone) apply on top of
 * whatever action the policy returned, and never change it. A ruleset adds
 * detections, never an action of its own.
 *
 * ## Snapshot
 *
 * `scanLimits` is copied (only `maxInputBytes` and `maxFindings` are read) and
 * a binary `ruleset` is copied byte for byte, so mutating the caller's object
 * or buffer afterwards changes nothing. A `policy` and a `placeholderFormatter`
 * are callbacks and are held by reference: the adapter cannot freeze what a
 * callback closes over, and the core is documented to call them with safe
 * metadata only.
 *
 * ## Availability
 *
 * Whole-input scans only. The incremental sessions of the AI-context boundary
 * take `placeholderFormatter` and their own `incrementalLimits`, and the core
 * has no ruleset for an incremental session, so the AI-context boundary
 * rejects `ruleset` and `scanLimits` by name rather than ignore them. Every
 * option here is available from the declared core floor
 * (`SCAN_OPTION_CORE_FLOORS`); the live factories check it, then probe the
 * options with one scan of the empty text, so an unsupported core or a ruleset that does
 * not parse is a fixed, input-free `CoreOptionsError` at construction, never a
 * silently ignored option.
 */

import type { PlaceholderFormatter, ScanAndRedactOptions, WholeInputLimits } from "@redact-secret/core";

import type { Policy, ScanAndRedact } from "./types.js";

/** The options this module adds, by the names a caller passes them under. */
export interface ScanOptionsInput {
  readonly policy?: Policy;
  /** The core's whole-input limits for every scan: `{ maxInputBytes, maxFindings }`. Not the adapter's walk `limits`. */
  readonly scanLimits?: WholeInputLimits | undefined;
  /** A declarative ruleset (text, or its UTF-8 bytes). Whole-input scans only. */
  readonly ruleset?: Uint8Array | string | undefined;
  /** The core's placeholder formatter. */
  readonly placeholderFormatter?: PlaceholderFormatter | undefined;
}

/** The names of the options {@link ScanOptionsInput} adds to `policy`. */
export type ScanOptionName = "scanLimits" | "ruleset" | "placeholderFormatter";

/**
 * A validated snapshot of a caller's scan options: exactly what is passed to
 * `scanAndRedact` as its options argument, built once.
 */
export interface ScanConfig {
  readonly options: ScanAndRedactOptions;
  /** Which of the three added options were requested, in a fixed order. Never their values. */
  readonly requested: readonly ScanOptionName[];
}

const NO_OPTIONS: ScanAndRedactOptions = Object.freeze({ policy: undefined });
const EMPTY: ScanConfig = Object.freeze({ options: NO_OPTIONS, requested: Object.freeze([]) });

/** The oldest core each option has been verified against, which is the declared `@redact-secret/core` floor. */
export const SCAN_OPTION_CORE_FLOORS: Readonly<Record<ScanOptionName, string>> = Object.freeze({
  scanLimits: "0.1.0-beta.6",
  ruleset: "0.1.0-beta.6",
  placeholderFormatter: "0.1.0-beta.6",
});

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/**
 * Validates and snapshots `input`. Throws a `TypeError` with a fixed message
 * for a malformed option: that is a programming error, not an input. With none
 * of the three options given it returns options holding only `policy`, as the
 * adapters have always passed.
 */
export function resolveScanConfig(input: ScanOptionsInput = {}): ScanConfig {
  const { policy, scanLimits, ruleset, placeholderFormatter } = input;
  if (scanLimits === undefined && ruleset === undefined && placeholderFormatter === undefined) {
    return policy === undefined
      ? EMPTY
      : Object.freeze({ options: Object.freeze({ policy }), requested: EMPTY.requested });
  }
  const options: { -readonly [K in keyof ScanAndRedactOptions]: ScanAndRedactOptions[K] } = { policy };
  const requested: ScanOptionName[] = [];
  if (scanLimits !== undefined) {
    if (
      scanLimits === null ||
      typeof scanLimits !== "object" ||
      !isNonNegativeNumber(scanLimits.maxInputBytes) ||
      !isNonNegativeNumber(scanLimits.maxFindings)
    ) {
      throw new TypeError("scanLimits must be { maxInputBytes, maxFindings }, two non-negative numbers");
    }
    options.limits = Object.freeze({ maxInputBytes: scanLimits.maxInputBytes, maxFindings: scanLimits.maxFindings });
    requested.push("scanLimits");
  }
  if (ruleset !== undefined) {
    if (typeof ruleset === "string") options.ruleset = ruleset;
    else if (ruleset instanceof Uint8Array) options.ruleset = new Uint8Array(ruleset);
    else throw new TypeError("ruleset must be a string or a Uint8Array");
    requested.push("ruleset");
  }
  if (placeholderFormatter !== undefined) {
    if (typeof placeholderFormatter !== "function") throw new TypeError("placeholderFormatter must be a function");
    options.placeholderFormatter = placeholderFormatter;
    requested.push("placeholderFormatter");
  }
  return Object.freeze({ options: Object.freeze(options), requested: Object.freeze(requested) });
}

/**
 * `options` with its scan configuration validated and snapshotted once: the
 * same object when it already carries a `scanConfig`, else a layer over it
 * (`Object.create`, so every inherited key, `counter` and `operation` getters
 * included, is still read through) with the resolved `scanConfig` added. A
 * host that builds a masker once calls this at construction, so a malformed
 * option throws there and every leaf is scanned with the one snapshot.
 */
export function withResolvedScanConfig<T extends ScanOptionsInput & { readonly scanConfig?: ScanConfig | undefined }>(
  options: T,
): T & { readonly scanConfig: ScanConfig } {
  if (options.scanConfig !== undefined) return options as T & { readonly scanConfig: ScanConfig };
  return Object.create(options, { scanConfig: { value: resolveScanConfig(options), enumerable: true } });
}

/** The fixed codes {@link CoreOptionsError} carries. Input-free by construction. */
export type CoreOptionsErrorCode = "CORE_OPTION_UNSUPPORTED" | "CORE_OPTION_REJECTED";

const MESSAGES: Readonly<Record<CoreOptionsErrorCode, string>> = Object.freeze({
  CORE_OPTION_UNSUPPORTED:
    "verifyScanOptions: the installed @redact-secret/core is older than the version a requested scan option was verified against, or does not report its version; upgrade the core or omit the option",
  CORE_OPTION_REJECTED:
    "verifyScanOptions: the core rejected a requested scan option (a ruleset that does not parse, invalid limits, a failing callback); see coreCode",
});

/** The core codes forwarded as `coreCode`: the ones a scan option can raise. Nothing else is read from the error. */
const FORWARDED_CORE_CODES: ReadonlySet<string> = new Set([
  "INVALID_RULESET",
  "INVALID_LIMITS",
  "INVALID_OPTIONS",
  "INVALID_PLACEHOLDER",
  "PLACEHOLDER_FAILURE",
  "POLICY_FAILURE",
  "INVALID_POLICY_ACTION",
  "NOT_INITIALIZED",
]);

/**
 * A refusal to run with a scan option the installed core cannot be shown to
 * honor. `message` and `code` are fixed; `coreCode` is one of the core's own
 * registry codes or absent. It never carries an option value, a ruleset, an
 * input, or the core's own error text.
 */
export class CoreOptionsError extends Error {
  readonly code: CoreOptionsErrorCode;
  readonly coreCode?: string;
  /** Which requested options were being verified, in a fixed order. Names only. */
  readonly options: readonly ScanOptionName[];

  constructor(code: CoreOptionsErrorCode, options: readonly ScanOptionName[], coreCode?: string) {
    super(MESSAGES[code]);
    this.name = "CoreOptionsError";
    this.code = code;
    this.options = options;
    if (coreCode !== undefined) this.coreCode = coreCode;
  }
}

interface Version {
  readonly core: readonly [number, number, number];
  readonly pre: readonly (string | number)[];
}

function parseVersion(text: unknown): Version | undefined {
  if (typeof text !== "string") return undefined;
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec(text.trim());
  if (match === null) return undefined;
  const pre = (match[4] ?? "").split(".").filter((part) => part !== "");
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: pre.map((part) => (/^\d+$/.test(part) ? Number(part) : part)),
  };
}

/** SemVer 2.0 ordering, enough for the core's `0.1.0-beta.N` line: a release outranks its prereleases. */
function compareVersions(a: Version, b: Version): number {
  for (let index = 0; index < 3; index += 1) {
    const diff = (a.core[index] as number) - (b.core[index] as number);
    if (diff !== 0) return diff;
  }
  if (a.pre.length === 0 || b.pre.length === 0) return b.pre.length - a.pre.length;
  for (let index = 0; index < Math.max(a.pre.length, b.pre.length); index += 1) {
    const left = a.pre[index];
    const right = b.pre[index];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    if (left === right) continue;
    if (typeof left === "number" && typeof right === "number") return left - right;
    if (typeof left === "number") return -1;
    if (typeof right === "number") return 1;
    return left < right ? -1 : 1;
  }
  return 0;
}

/** Whether `version` is at least `floor`. An unparsable version is not. */
export function coreVersionAtLeast(version: unknown, floor: string): boolean {
  const have = parseVersion(version);
  const want = parseVersion(floor);
  return have !== undefined && want !== undefined && compareVersions(have, want) >= 0;
}

/** The subset of `@redact-secret/core` {@link verifyScanOptions} reads: `VERSION` and `scanAndRedact`. */
export interface ScanOptionsCore {
  readonly scanAndRedact: ScanAndRedact;
  readonly VERSION?: unknown;
}

/**
 * The empty text. It has no finding, so no policy or formatter callback runs
 * on it, and it is shorter than any whole-input byte ceiling the core accepts,
 * so the probe can fail only because an option is itself rejected: a ruleset
 * that does not parse (`INVALID_RULESET`), limits the core refuses
 * (`INVALID_LIMITS`), or an unsupported option shape (`INVALID_OPTIONS`).
 */
const PROBE_TEXT = "";

function codeOf(error: unknown): string | undefined {
  try {
    const code: unknown = error !== null && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
    return typeof code === "string" && FORWARDED_CORE_CODES.has(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The live factories' check that the installed core honors the requested
 * options, run once at construction: the core's reported `VERSION` must be at
 * least each requested option's floor, and one scan of the empty text with the options
 * applied must succeed (a ruleset that does not parse, or limits the core
 * rejects, raise there). A no-op when none of the three options was
 * requested, so a core at the declared floor keeps working unchanged.
 *
 * Throws {@link CoreOptionsError}; nothing it throws carries an option value,
 * a ruleset or the core's own message.
 */
export function verifyScanOptions(core: ScanOptionsCore, config: ScanConfig): void {
  const { requested } = config;
  if (requested.length === 0) return;
  const unsupported = requested.filter((name) => !coreVersionAtLeast(core.VERSION, SCAN_OPTION_CORE_FLOORS[name]));
  if (unsupported.length > 0) throw new CoreOptionsError("CORE_OPTION_UNSUPPORTED", unsupported);
  try {
    core.scanAndRedact(PROBE_TEXT, config.options);
  } catch (error) {
    throw new CoreOptionsError("CORE_OPTION_REJECTED", requested, codeOf(error));
  }
}
