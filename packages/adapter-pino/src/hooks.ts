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
 * composed pair by hand. Both run after the last scan. See
 * ARCHITECTURE.md § pino.
 */

import type { MaskOptions, ScanAndRedact } from "@redact-secret/adapter";
import type { LogFn, Logger } from "pino";

import { createRedactingLogMethodWith, type RedactingLogMethod } from "./log-method.js";
import { createRedactingStreamWriteWith, type RedactingStreamWrite } from "./stream-write.js";

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

export interface RedactingHooksOptions extends MaskOptions {
  /**
   * The `hooks` object the application would otherwise have passed to
   * `pino()`. Its `logMethod` and `streamWrite` are composed with the
   * redacting ones (see the ordering rule above); every other key is copied
   * over unchanged.
   */
  readonly hooks?: PinoHostHooks & Record<string, unknown>;
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

/**
 * Builds both pino hooks over an injected `scanAndRedact` (see `./index.ts`
 * for the live factory). `options.hooks` is the host's own `hooks` object,
 * composed as documented above; `policy` and `limits` go to both hooks
 * unchanged.
 */
export function createRedactingHooksWith(
  scanAndRedact: ScanAndRedact,
  { hooks, ...maskOptions }: RedactingHooksOptions = {},
): RedactingHooks {
  if (hooks !== undefined && (hooks === null || typeof hooks !== "object")) {
    throw new TypeError("createRedactingHooksWith: hooks must be an object");
  }
  const forwarded: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(hooks ?? {})) {
    if (!(COMPOSED_KEYS as readonly string[]).includes(key)) forwarded[key] = value;
  }
  return Object.freeze({
    ...forwarded,
    logMethod: composeLogMethod(hooks?.logMethod, createRedactingLogMethodWith(scanAndRedact, maskOptions)),
    streamWrite: composeStreamWrite(hooks?.streamWrite, createRedactingStreamWriteWith(scanAndRedact, maskOptions)),
  }) as RedactingHooks;
}
