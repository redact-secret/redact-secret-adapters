/**
 * `createRedactingLogMethodWith`: a pino `hooks.logMethod` (pinned against
 * pino `10.3.1` — the only version this reasoning was ever confirmed
 * against — https://github.com/pinojs/pino/blob/main/docs/api.md#hooks and
 * https://github.com/pinojs/pino/blob/main/lib/tools.js) that redacts a
 * secret out of the message, every string field of a merging object, and a
 * serialized `err.message`, before pino ever serializes or writes the line.
 *
 * `hooks.logMethod` is the only pino extension point that sees the raw
 * message: `formatters.log(obj)` looked like the natural fit at first, but
 * reading `lib/tools.js`'s `_asJson` shows `formatters.log` never receives
 * `msg` at all (pino serializes the message key separately from the
 * merged object) and runs *before* `serializers[key]` — so a `formatters`
 * hook can redact a plain string field, but never the message, and never
 * a value an `err` serializer hasn't produced yet. `hooks.logMethod`,
 * documented as `logMethod (args, method, level) {}`, instead wraps the
 * log call itself (`lib/tools.js`'s `genLog`: `hook.call(this, args, LOG,
 * level)`) before pino does anything — before merging, before
 * serializers, before `formatters.log`, before the configured
 * path-based `redact`. Redacting here and then calling `method.apply`
 * with the redacted arguments means every later pino stage (including a
 * host's own `redact` option, still applied by path) runs unchanged on
 * text pino can no longer see in the clear.
 *
 * `args` is exactly what the caller passed to `logger.info(...)` et al.:
 * `(msg, ...interpolationValues)`, `(mergingObject, msg,
 * ...interpolationValues)`, or a bare `Error`. Before anything is scanned,
 * `joinInterpolatedMessage` (below) joins a string `msg` followed by
 * further positional arguments into the single string pino's own
 * `quick-format-unescaped` would produce (`./format-message.ts`), *before*
 * redaction runs, so a secret split across the format string and an
 * interpolation value — or across two interpolation values — is scanned
 * as one leaf, not two that never individually match. Everything from
 * that point on — the joined message, a merging object, or a normalized
 * `Error` — is one value tree, redacted with `maskLogValueWith`
 * (`@redact-secret/adapter`), so:
 *
 * - the joined message, or a plain string `msg` with nothing to join, is
 *   redacted as one leaf;
 * - every string field of a merging object is redacted, at any depth;
 * - an `Error` anywhere in the tree — including a bare `logger.error(err)`
 *   call — is replaced by an already-redacted `{ type, message, stack,
 *   ...ownProps }` object, in the shape `pino.stdSerializers.err` would
 *   have produced, before that serializer (or any other) ever sees the
 *   real message or stack.
 *
 * A leading `Error` is handed back to pino as a masked copy that keeps its
 * prototype (see `asMaskedError`), so pino's own `instanceof Error` handling
 * still applies to it.
 *
 * `await initialize()` (`@redact-secret/core`) must resolve before the
 * returned hook is used; `./index.ts`'s `createRedactingLogMethod`
 * enforces that ordering for the live integration. This file is
 * dependency-injected and testable without the native addon built; pino
 * appears here as a type import only, never as a value import.
 */

import type { MaskOptions, ScanAndRedact } from "@redact-secret/adapter";
import { maskLogValueWith } from "@redact-secret/adapter";
import type { LogFn, Logger } from "pino";

import { formatPinoMessage } from "./format-message.js";

/** The exact shape of pino's `hooks.logMethod`. */
export type RedactingLogMethod = (this: Logger, args: Parameters<LogFn>, method: LogFn, level: number) => void;

/**
 * Gives a masked `{ type, message, stack, ... }` back the prototype of the
 * `Error` it came from. pino keys its `Error` handling on `instanceof Error`:
 * for a leading `Error` it wraps it under `errorKey` and, only when no
 * message was passed, takes `msg` from its `message` — now the masked one.
 */
function asMaskedError(original: Error, masked: unknown): unknown {
  if (typeof masked !== "object" || masked === null) return masked;
  const out = Object.create(Object.getPrototypeOf(original)) as object;
  for (const [key, value] of Object.entries(masked)) {
    Object.defineProperty(out, key, { value, enumerable: true, configurable: true, writable: true });
  }
  return out;
}

function hasMergingObjectFirst(args: unknown[]): boolean {
  return args.length > 0 && typeof args[0] === "object" && args[0] !== null;
}

/**
 * Folds `msg` and any trailing printf-style interpolation values into the
 * single string pino would format, so the redaction pass below sees it as
 * one leaf. A no-op for every other shape — a bare message with nothing
 * after it, a non-string `msg`, or a merging object with no message —
 * which all fall through to the existing per-leaf walk unchanged.
 */
function joinInterpolatedMessage(args: unknown[]): unknown[] {
  const msgIndex = hasMergingObjectFirst(args) ? 1 : 0;
  const msg = args[msgIndex];
  if (typeof msg !== "string" || args.length <= msgIndex + 1) {
    return args;
  }
  const joined = formatPinoMessage(msg, args.slice(msgIndex + 1));
  return msgIndex === 1 ? [args[0], joined] : [joined];
}

/**
 * Builds a pino `hooks.logMethod` function. `scanAndRedact` is injected
 * (see `./index.ts` for the live factory over `@redact-secret/core`).
 */
export function createRedactingLogMethodWith(
  scanAndRedact: ScanAndRedact,
  options: MaskOptions = {},
): RedactingLogMethod {
  if (typeof scanAndRedact !== "function") {
    throw new TypeError("createRedactingLogMethodWith: scanAndRedact must be a function");
  }
  return function redactingLogMethod(args, method, _level) {
    const joined = joinInterpolatedMessage(Array.from(args));
    const redacted = maskLogValueWith(scanAndRedact, joined, options) as unknown[];
    if (joined[0] instanceof Error) redacted[0] = asMaskedError(joined[0], redacted[0]);
    method.apply(this, redacted as Parameters<LogFn>);
  };
}
