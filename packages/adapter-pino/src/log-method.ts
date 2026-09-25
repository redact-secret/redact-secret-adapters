/**
 * `createRedactingLogMethodWith`: a pino `hooks.logMethod` that masks the
 * message, the merging object and any `Error` before pino merges,
 * serializes, formats or writes anything. Checked against pino 10.3.1's
 * `lib/tools.js` (`genLog`) and `lib/proto.js` (`write`). Why this hook,
 * why the message is joined with its values first, and how a leading `Error`
 * and `msgPrefix` are handled: ARCHITECTURE.md § pino. pino is a type import
 * only.
 */

import type { MaskOptions, ScanAndRedact } from "@redact-secret/adapter";
import { ERROR_MARKER, maskLogValueWith } from "@redact-secret/adapter";
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

/**
 * Where pino's `LOG` reads the message: after a first argument that is an
 * object (`null` included) or `undefined`, else the first argument itself.
 */
function messageIndex(args: unknown[]): number {
  const first = args[0];
  return first === undefined || typeof first === "object" ? 1 : 0;
}

/**
 * Folds `msg` and any trailing printf-style interpolation values into the
 * single string pino would format, so the redaction pass below sees it as
 * one leaf. A no-op when `msg` is not a string or has nothing after it.
 */
function joinInterpolatedMessage(args: unknown[], msgIndex: number): unknown[] {
  const msg = args[msgIndex];
  if (typeof msg !== "string" || args.length <= msgIndex + 1) {
    return args;
  }
  return [...args.slice(0, msgIndex), formatPinoMessage(msg, args.slice(msgIndex + 1))];
}

function redactArgs(scanAndRedact: ScanAndRedact, args: unknown[], prefix: unknown, options: MaskOptions): unknown[] {
  const msgIndex = messageIndex(args);
  const joined = joinInterpolatedMessage(args, msgIndex);
  // pino prepends `msgPrefix` after this hook returns, so scan it with the
  // message (a prefix like "api_key=" is the context that makes the value
  // detectable), then hand pino the message without it again.
  const prefixed = typeof prefix === "string" && prefix !== "" && typeof joined[msgIndex] === "string";
  if (prefixed) joined[msgIndex] = `${prefix}${joined[msgIndex]}`;
  const redacted = maskLogValueWith(scanAndRedact, joined, options);
  if (!Array.isArray(redacted)) return [ERROR_MARKER];
  if (prefixed) {
    const message = redacted[msgIndex];
    // A redaction that reached into the prefix (or a marker) is kept whole;
    // pino then prints the static prefix before it, never the raw message.
    if (typeof message === "string" && message.startsWith(prefix)) redacted[msgIndex] = message.slice(prefix.length);
  }
  restoreErrors(args[0], redacted);
  return redacted;
}

/**
 * Restores the `Error` prototype where pino's serializers look: a leading
 * `Error`, and any top-level merging-object key holding one — whatever the
 * logger's `errorKey` is, which the hook cannot read. pino's `err`
 * serializer takes `type` from the constructor, so a plain object would log
 * `type: "Object"`.
 */
function restoreErrors(first: unknown, redacted: unknown[]): void {
  if (first instanceof Error) {
    redacted[0] = asMaskedError(first, redacted[0]);
    return;
  }
  const merged = redacted[0];
  if (typeof first !== "object" || first === null || typeof merged !== "object" || merged === null) return;
  for (const key of Object.keys(merged)) {
    // A data descriptor only: re-running a getter could return something else.
    const original: unknown = Object.getOwnPropertyDescriptor(first, key)?.value;
    if (original instanceof Error) {
      Object.defineProperty(merged, key, {
        value: asMaskedError(original, (merged as Record<string, unknown>)[key]),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
  }
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
    let redacted: unknown[];
    try {
      redacted = redactArgs(scanAndRedact, Array.from(args), this?.msgPrefix, options);
    } catch {
      // e.g. formatting `%d` with a Symbol: log the marker, never the raw arguments.
      redacted = [ERROR_MARKER];
    }
    method.apply(this, redacted as Parameters<LogFn>);
  };
}
