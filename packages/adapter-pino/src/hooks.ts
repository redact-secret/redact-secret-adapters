/**
 * `createRedactingHooksWith`: the one setup step that installs the complete
 * pino boundary — both `hooks.logMethod` and `hooks.streamWrite` — and
 * composes, rather than replaces, hooks the host already had.
 *
 * Why a paired factory and not two separate calls: the two hooks cover
 * different inputs and neither is sufficient alone (`logMethod` never sees
 * child bindings or `mixin()` output; `streamWrite` never sees a value
 * before the host's own serializers and `formatters` run on it). Installing
 * one of them is the misassembly this factory exists to prevent. The
 * individual factories stay exported for advanced use and migration.
 *
 * **Ordering.** Redaction always runs last, closest to the bytes:
 *
 * - `logMethod`: the host's hook runs first and the redacting hook runs
 *   immediately before pino's own `method`, so arguments the host's hook
 *   adds or rewrites are scanned too. A host hook that never calls `method`
 *   still drops the record, unchanged.
 * - `streamWrite`: the host's hook runs first on pino's JSON line and the
 *   redacting hook masks what it returns, so fields the host's hook adds are
 *   scanned too. pino requires a `streamWrite` hook to return valid JSON;
 *   a line this hook cannot lex fails closed to `{"msg":"[REDACTED:ERROR]"}`.
 *
 * What is still outside the boundary: a `destination`/transport that adds
 * text of its own after `streamWrite`, and a host hook wrapped *around* the
 * composed pair by hand. Both run after the last scan.
 *
 * And one consequence of that ordering, which a host has to know: because the
 * host's `streamWrite` runs **first**, it receives pino's line **unmasked** —
 * including child bindings and `mixin()` output, the two inputs `logMethod`
 * cannot cover. A host hook that only transforms the line it is given and
 * returns it is fine; one that tees, copies or logs the line elsewhere is
 * reading plaintext. See ARCHITECTURE.md § pino.
 */

import type { MaskOptions, OperationBudget, OutcomeCounter, ScanAndRedact, ValueCounts } from "@redact-secret/adapter";
import {
  addCounts,
  bindScanConfig,
  createOperationBudget,
  createOutcomeCounter,
  notify,
  toValueCounts,
} from "@redact-secret/adapter";
import type { LogFn, Logger } from "pino";

import { createRedactingLogMethodWith, type RedactingLogMethod } from "./log-method.js";
import {
  createRedactingStreamWriteWith,
  isReplacementLine,
  type PinoLineLimits,
  type RedactingStreamWrite,
} from "./stream-write.js";

/**
 * The hooks this package composes with. Shaped after pino 10's
 * `LoggerOptions["hooks"]`; any other key on the object passed in is
 * forwarded unchanged, so a pino release that adds a hook is not silently
 * dropped — but nor is it covered. Only `logMethod` and `streamWrite` are
 * composed.
 */
export interface PinoHostHooks {
  readonly logMethod?: (this: Logger, args: Parameters<LogFn>, method: LogFn, level: number) => void;
  readonly streamWrite?: (line: string) => string;
}

/** Which of the two hooks contributed to an outcome. */
export type PinoRedactionStage = "log-method" | "stream-write";

/**
 * One summary per **log record**, the unit a host counts in.
 *
 * `values` sums both hooks' passes over that one record, so a secret in the
 * message is not counted twice because `streamWrite` scanned the line as
 * well. Every field is bounded and enumerated: there is no value, masked
 * value, field path, key, offset or error text in it, and `values`'
 * definitions are in `@redact-secret/adapter`'s `outcome.ts`.
 */
export interface PinoLogOutcome {
  readonly host: "pino";
  readonly unit: "log-record";
  /** pino's numeric level. Absent for a line no `logMethod` pass was correlated with. */
  readonly level?: number;
  /** In the order they ran. `["log-method"]` alone means no line reached `streamWrite`. */
  readonly stages: readonly PinoRedactionStage[];
  readonly values: ValueCounts;
  /**
   * `true` when the `streamWrite` hook could not lex the line and wrote the
   * fixed `[REDACTED:ERROR]` line instead of it, or refused it because the
   * record's budget was already spent and wrote the fixed
   * `[REDACTED:LIMIT_EXCEEDED]` line (`PINO_LIMIT_LINE`). It says nothing about
   * whether the destination or transport then accepted the line: this
   * adapter never learns that.
   */
  readonly lineReplaced: boolean;
}

export interface RedactingHooksOptions extends Omit<MaskOptions, "operation"> {
  /**
   * Not accepted: the paired factory owns the unit. It creates one aggregate
   * budget per **log record** (`operationLimits` overrides its limits) and
   * shares it between `logMethod` and `streamWrite`, so the two passes over
   * one record cannot each spend a full budget. Passing a caller-owned
   * `operation` here throws.
   */
  readonly operation?: undefined;
  /**
   * Override the pre-processing ceilings `streamWrite` applies to the finished
   * line before it lexes or decodes anything (`DEFAULT_LINE_LIMITS`): the
   * longest line, the most value literals and the most decoded code units. A
   * line past one is the fixed `{"msg":"[REDACTED:LIMIT_EXCEEDED]"}` line, never
   * the original. They are not the core's input limits and not the walker's
   * `limits`.
   */
  readonly lineLimits?: Partial<PinoLineLimits> | undefined;
  /**
   * The `hooks` object the application would otherwise have passed to
   * `pino()`. Its `logMethod` and `streamWrite` are composed with the
   * redacting ones (see the ordering rule above); every other key is copied
   * over unchanged.
   */
  readonly hooks?: PinoHostHooks & Record<string, unknown>;
  /**
   * Observational: called once per log record with a {@link PinoLogOutcome},
   * synchronously, after that record has been masked. Increment your own
   * counters from it.
   *
   * It cannot affect what is written: masking is finished before it runs, and
   * anything it throws is swallowed, never read, and never rethrown. It is
   * re-entrancy-guarded, so an observer that logs through the logger it is
   * observing produces no further outcomes rather than recursing — those
   * nested records are simply not reported. No logger, exporter or network
   * client is created for it.
   *
   * Only this paired factory takes it, because only the pair can guarantee
   * one summary per record; the single-hook factories deliberately do not.
   */
  readonly onOutcome?: (outcome: PinoLogOutcome) => void;
}

/** Exactly what `pino({ hooks })` wants: both hooks, plus any key forwarded from the host's own `hooks`. */
export interface RedactingHooks extends Record<string, unknown> {
  readonly logMethod: RedactingLogMethod;
  readonly streamWrite: RedactingStreamWrite;
}

/** The keys this factory composes rather than forwards. */
const COMPOSED_KEYS = ["logMethod", "streamWrite"] as const;

function composeLogMethod(host: PinoHostHooks["logMethod"], redacting: RedactingLogMethod): RedactingLogMethod {
  if (host === undefined) return redacting;
  if (typeof host !== "function") {
    throw new TypeError("createRedactingHooksWith: hooks.logMethod must be a function");
  }
  return function composedLogMethod(this: Logger, args, method, level) {
    // The host's hook sees pino's arguments untouched and decides whether to
    // continue; `redactTail` is the `method` it is handed, so redaction runs
    // over whatever it passes on, immediately before pino's real method.
    const redactTail = function redactTail(this: Logger, ...hostArgs: Parameters<LogFn>): void {
      redacting.call(this, hostArgs, method, level);
    } as LogFn;
    host.call(this, args, redactTail, level);
  };
}

function composeStreamWrite(host: PinoHostHooks["streamWrite"], redacting: RedactingStreamWrite): RedactingStreamWrite {
  if (host === undefined) return redacting;
  if (typeof host !== "function") {
    throw new TypeError("createRedactingHooksWith: hooks.streamWrite must be a function");
  }
  return function composedStreamWrite(line) {
    let hostLine: string;
    try {
      hostLine = host(line);
    } catch {
      // A throwing host hook must not put the unmasked line on the wire
      // either: fall back to redacting pino's own line.
      hostLine = line;
    }
    return redacting(typeof hostLine === "string" ? hostLine : line);
  };
}

/** One record in flight: what both hooks accumulate into before it is reported. */
interface PendingRecord {
  readonly counts: OutcomeCounter;
  /** One aggregate budget for the whole record, shared by both hooks (#173). */
  readonly budget: OperationBudget;
  readonly stages: PinoRedactionStage[];
  readonly level: number;
  lineReplaced: boolean;
  reported: boolean;
}

/**
 * Wraps the redacting pair so that exactly one {@link PinoLogOutcome} is
 * reported per log record.
 *
 * pino's write path is synchronous: within one `logger.info(...)` call,
 * `logMethod` runs, then the line is built, then `streamWrite` runs. So the
 * `logMethod` pass opens a record, the `streamWrite` pass adds to it and
 * reports it, and the `logMethod` wrapper reports it itself if no line ever
 * arrived (a destination that threw, a `streamWrite` the host replaced).
 *
 * A stack, not a single slot, because this path is re-entrant: a `mixin()` or
 * a serializer that logs re-enters it after masking, and a **getter or
 * `toJSON()` on the merging object that logs re-enters it during the walk**.
 *
 * One scratch counter is reused and drained after each pass, rather than one
 * per call: the walkers only ever increment what they are given, so draining
 * is what keeps the two passes' numbers attributable to the right record.
 */
function observed(
  scanAndRedact: ScanAndRedact,
  maskOptions: MaskOptions,
  onOutcome: ((outcome: PinoLogOutcome) => void) | undefined,
): { logMethod: RedactingLogMethod; streamWrite: RedactingStreamWrite } {
  const stack: PendingRecord[] = [];
  let reporting = false;
  // Read fresh by `createWalkContext` on every masking call, so counts land on
  // the record being masked right now, however deeply nested. A single shared
  // counter drained after each pass would hand a nested record the outer
  // record's partial numbers.
  const counted: MaskOptions = {
    ...maskOptions,
    get counter(): OutcomeCounter | undefined {
      return stack[stack.length - 1]?.counts;
    },
    // Likewise the budget: the record being masked right now owns it, so a
    // nested record (a getter that logs) cannot spend the outer one's.
    get operation(): OperationBudget | undefined {
      return stack[stack.length - 1]?.budget;
    },
  };
  const inner = {
    logMethod: createRedactingLogMethodWith(scanAndRedact, counted),
    streamWrite: createRedactingStreamWriteWith(scanAndRedact, counted),
  };

  function report(pending: PendingRecord): void {
    pending.reported = true;
    // An observer that logs would otherwise re-enter this whole path.
    if (reporting) return;
    reporting = true;
    try {
      notify(onOutcome, {
        host: "pino",
        unit: "log-record",
        level: pending.level,
        stages: Object.freeze([...pending.stages]),
        values: toValueCounts(pending.counts),
        lineReplaced: pending.lineReplaced,
      } satisfies PinoLogOutcome);
    } finally {
      reporting = false;
    }
  }

  /**
   * A caller's own `counter` is a documented option, so a record's counts are
   * added to it as well. It is not handed to the walkers directly: they would
   * then mix this record's numbers with the next one's.
   */
  function addToCallerCounter(counts: OutcomeCounter): void {
    if (maskOptions.counter !== undefined) addCounts(maskOptions.counter, counts);
  }

  /** A line with no `logMethod` pass in flight: reported on its own, with no level. */
  function reportOrphanLine(counts: OutcomeCounter, stages: PinoRedactionStage[], replaced: boolean): void {
    if (reporting) return;
    reporting = true;
    try {
      notify(onOutcome, {
        host: "pino",
        unit: "log-record",
        stages: Object.freeze([...stages]),
        values: toValueCounts(counts),
        lineReplaced: replaced,
      } satisfies PinoLogOutcome);
    } finally {
      reporting = false;
    }
  }

  return {
    logMethod: function observedLogMethod(this: Logger, args, method, level) {
      const pending: PendingRecord = {
        counts: createOutcomeCounter(),
        budget: createOperationBudget(maskOptions.operationLimits),
        stages: [],
        level,
        lineReplaced: false,
        reported: false,
      };
      stack.push(pending);
      try {
        inner.logMethod.call(
          this,
          args,
          function afterMasking(this: Logger, ...masked: Parameters<LogFn>): void {
            // Masking is done; the line has not been built yet.
            pending.stages.push("log-method");
            method.apply(this, masked);
          } as LogFn,
          level,
        );
      } finally {
        const index = stack.lastIndexOf(pending);
        if (index !== -1) stack.splice(index, 1);
        if (!pending.reported) {
          report(pending);
          addToCallerCounter(pending.counts);
        }
      }
    },
    streamWrite: function observedStreamWrite(line) {
      const pending = stack[stack.length - 1];
      if (pending === undefined) {
        // A line with no `logMethod` pass of ours in flight. It gets a record
        // of its own rather than being attributed to an unrelated one, pushed
        // first so the line's own values are counted onto it.
        const orphan: PendingRecord = {
          counts: createOutcomeCounter(),
          budget: createOperationBudget(maskOptions.operationLimits),
          stages: ["stream-write"],
          level: -1,
          lineReplaced: false,
          reported: false,
        };
        stack.push(orphan);
        let out: string;
        try {
          out = inner.streamWrite(line);
        } finally {
          stack.pop();
        }
        orphan.lineReplaced = isReplacementLine(out);
        reportOrphanLine(orphan.counts, orphan.stages, orphan.lineReplaced);
        addToCallerCounter(orphan.counts);
        return out;
      }
      const out = inner.streamWrite(line);
      pending.stages.push("stream-write");
      pending.lineReplaced = isReplacementLine(out);
      report(pending);
      addToCallerCounter(pending.counts);
      return out;
    },
  };
}

/**
 * Builds both pino hooks over an injected `scanAndRedact` (see `./index.ts`
 * for the live factory). `options.hooks` is the host's own `hooks` object,
 * composed as documented above; `policy` and `limits` go to both hooks
 * unchanged, and `onOutcome` reports one summary per log record.
 */
export function createRedactingHooksWith(
  scanAndRedact: ScanAndRedact,
  { hooks, onOutcome, ...rawOptions }: RedactingHooksOptions = {},
): RedactingHooks {
  if (hooks !== undefined && (hooks === null || typeof hooks !== "object")) {
    throw new TypeError("createRedactingHooksWith: hooks must be an object");
  }
  if (onOutcome !== undefined && typeof onOutcome !== "function") {
    throw new TypeError("createRedactingHooksWith: onOutcome must be a function");
  }
  if ((rawOptions as { operation?: unknown }).operation !== undefined) {
    throw new TypeError("createRedactingHooksWith: operation is not accepted; use operationLimits");
  }
  // Validated and snapshotted once, here, and shared by both hooks: a malformed
  // scan option is a programming error at construction, and every leaf of
  // every record is scanned with the one snapshot.
  const maskOptions = bindScanConfig(rawOptions);
  const forwarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hooks ?? {})) {
    if (!(COMPOSED_KEYS as readonly string[]).includes(key)) forwarded[key] = value;
  }
  // The pair is always wrapped, observer or not: the record is the unit that
  // owns the aggregate budget both hooks spend (#173), and `observed` is what
  // correlates the two passes over one record.
  const redacting = observed(scanAndRedact, maskOptions, onOutcome);
  return Object.freeze({
    ...forwarded,
    logMethod: composeLogMethod(hooks?.logMethod, redacting.logMethod),
    streamWrite: composeStreamWrite(hooks?.streamWrite, redacting.streamWrite),
  }) as RedactingHooks;
}
