/**
 * A deterministic stand-in for the two core operations this package uses,
 * built on the shared `fixtures/fake-scanner.ts` rules (`BOOM` throws,
 * `BLOCK_ME` blocks, `SECRET_TOKEN_\d+` redacts, `WARN_ME` warns). It
 * misbehaves on purpose where the real core would not, so the unit tests
 * can prove the boundary does not trust it:
 *
 * - every finding carries extra, non-contract fields (`match` holds the
 *   plaintext), which must never cross the boundary;
 * - every error carries a `code` and a message that holds plaintext, which
 *   must never be read;
 * - `options.policy` is called for every finding and its throw becomes
 *   `POLICY_FAILURE`, as the core does.
 *
 * The incremental session stages its whole input and scans it at
 * `finalize`, unless `emitOnAppend` is set, in which case it releases each
 * clean chunk from `append` right away (as the real core may), so a test
 * can prove the boundary still stages it.
 */

import type {
  IncrementalLimits,
  IncrementalSanitizerOptions,
  ScanAndRedactOptions,
  ScanResult,
  SecretFinding,
  SecretScanErrorCode,
} from "@redact-secret/core";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import type { AiContextCore } from "../src/index.js";

export class FakeScanError extends Error {
  constructor(
    readonly code: SecretScanErrorCode | string,
    plaintext = "",
  ) {
    // A message that carries input: the boundary must never read it.
    super(`fake core failure near ${plaintext}`);
  }
}

export interface FakeCoreCalls {
  scans: string[];
  sessions: FakeSession[];
}

export interface FakeSession {
  appended: string[];
  aborted: boolean;
  finalized: boolean;
}

export interface FakeCoreOptions {
  emitOnAppend?: boolean;
  /** Thrown from the next `append` whose chunk contains this marker. */
  appendFailures?: Record<string, SecretScanErrorCode>;
  /** Thrown from `createIncrementalSanitizer`. */
  openFailure?: unknown;
  /** Thrown from `scanAndRedact` for text containing the key. */
  scanFailures?: Record<string, unknown>;
  /** Returned instead of a real result for text containing the key. */
  malformed?: Record<string, unknown>;
}

function withLeak(finding: SecretFinding, text: string): SecretFinding {
  return Object.freeze({ ...finding, match: text, score: 0.99, features: { secret: text } }) as SecretFinding;
}

/** The callbacks both option shapes share; the fake calls the policy the same way on either path. */
interface Callbacks {
  readonly policy?: {
    evaluate(finding: SecretFinding, context: { findingIndex: number; findingCount: number }): string;
  };
  readonly placeholderFormatter?: ScanAndRedactOptions["placeholderFormatter"];
}

function applyPolicy(result: ScanResult, text: string, options: Callbacks | undefined): ScanResult {
  const findings = result.findings.map((finding, findingIndex) => {
    let action: string = finding.action;
    if (options?.policy !== undefined) {
      try {
        action = options.policy.evaluate(finding, { findingIndex, findingCount: result.findings.length });
      } catch {
        throw new FakeScanError("POLICY_FAILURE", text);
      }
    }
    return withLeak({ ...finding, action: action as SecretFinding["action"] }, text);
  });
  if (options?.placeholderFormatter !== undefined && findings.some((f) => f.action !== "warn")) {
    try {
      options.placeholderFormatter(findings[0] as SecretFinding, { placeholderIndex: 1 });
    } catch {
      throw new FakeScanError("PLACEHOLDER_FAILURE", text);
    }
  }
  return { text: result.text, findings };
}

export function createFakeCore(options: FakeCoreOptions = {}): { core: AiContextCore; calls: FakeCoreCalls } {
  const calls: FakeCoreCalls = { scans: [], sessions: [] };

  const scanAndRedact = (text: string, scanOptions?: ScanAndRedactOptions): ScanResult => {
    calls.scans.push(text);
    for (const [marker, error] of Object.entries(options.scanFailures ?? {})) if (text.includes(marker)) throw error;
    for (const [marker, result] of Object.entries(options.malformed ?? {})) {
      if (text.includes(marker)) return result as ScanResult;
    }
    const limits = scanOptions?.limits;
    if (limits !== undefined && text.length > limits.maxInputBytes)
      throw new FakeScanError("INPUT_LIMIT_EXCEEDED", text);
    if (text.includes("BOOM")) throw new FakeScanError("DETECTOR_FAILURE", text);
    const result = applyPolicy(fakeScanAndRedact(text), text, scanOptions as Callbacks | undefined);
    if (limits !== undefined && result.findings.length > limits.maxFindings) {
      throw new FakeScanError("FINDING_LIMIT_EXCEEDED", text);
    }
    return result;
  };

  const createIncrementalSanitizer = (sessionOptions: IncrementalSanitizerOptions) => {
    if (options.openFailure !== undefined) throw options.openFailure;
    const limits: IncrementalLimits = sessionOptions.limits;
    const session: FakeSession = { appended: [], aborted: false, finalized: false };
    calls.sessions.push(session);
    let staged = "";
    const guard = () => {
      if (session.aborted || session.finalized) throw new FakeScanError("INVALID_STATE");
    };
    return {
      get state() {
        return session.aborted
          ? ("aborted" as const)
          : session.finalized
            ? ("finalized" as const)
            : ("accepting" as const);
      },
      append(chunk: string): ScanResult {
        guard();
        session.appended.push(chunk);
        for (const [marker, code] of Object.entries(options.appendFailures ?? {})) {
          if (chunk.includes(marker)) throw new FakeScanError(code, chunk);
        }
        staged += chunk;
        if (staged.length > limits.maxInputCodeUnits) throw new FakeScanError("INPUT_LIMIT_EXCEEDED", staged);
        if (options.emitOnAppend) {
          const result = applyPolicy(fakeScanAndRedact(staged), staged, sessionOptions as Callbacks);
          if (result.findings.some((f) => f.action === "block")) return result;
          if (result.findings.length === 0) {
            const out = staged;
            staged = "";
            return { text: out, findings: [] };
          }
        }
        return { text: "", findings: [] };
      },
      finalize(): ScanResult {
        guard();
        session.finalized = true;
        return applyPolicy(fakeScanAndRedact(staged), staged, sessionOptions as Callbacks);
      },
      abort(): void {
        session.aborted = true;
        staged = "";
      },
    };
  };

  return { core: { scanAndRedact, createIncrementalSanitizer }, calls };
}

export const LIMITS = Object.freeze({
  wholeInputLimits: { maxInputBytes: 256, maxFindings: 4 },
  incrementalLimits: {
    maxInputCodeUnits: 256,
    maxBufferedCodeUnits: 192,
    maxTokenCodeUnits: 64,
    maxMultilineCodeUnits: 64,
  },
  traversalLimits: { maxDepth: 3, maxNodes: 16 },
});
