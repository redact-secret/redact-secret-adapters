/**
 * `createRedactingStreamWriteWith`: a pino `hooks.streamWrite` that masks
 * every string value in the finished JSON line.
 *
 * `hooks.logMethod` sees only the arguments of one call. Child-logger
 * bindings (`logger.child({ ... })`, `setBindings`) are serialized once, at
 * child creation, and `mixin()` output is merged after the hook returns;
 * neither ever passes through it. `streamWrite` is the one documented pino
 * hook that sees the whole line — bindings, mixin fields, serializer output
 * — just before it reaches the destination. See ARCHITECTURE.md § pino.
 */

import type { MaskOptions, ScanAndRedact } from "@redact-secret/adapter";
import { ERROR_MARKER, LIMIT_MARKER, maskLogValueWith } from "@redact-secret/adapter";

/** The exact shape of pino's `hooks.streamWrite`. */
export type RedactingStreamWrite = (line: string) => string;

const QUOTE = 34;
const BACKSLASH = 92;
const COLON = 58;

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/**
 * `[start, end)` spans of every string literal in `line` that is a value,
 * not an object key. Keys are left alone, as the walker leaves keys alone.
 */
function valueStringSpans(line: string): [number, number][] {
  const spans: [number, number][] = [];
  let i = 0;
  while (i < line.length) {
    if (line.charCodeAt(i) !== QUOTE) {
      i++;
      continue;
    }
    const start = i++;
    while (i < line.length && line.charCodeAt(i) !== QUOTE) i += line.charCodeAt(i) === BACKSLASH ? 2 : 1;
    if (i >= line.length) throw new SyntaxError("unterminated string");
    i++;
    let next = i;
    while (next < line.length && isWhitespace(line.charCodeAt(next))) next++;
    if (line.charCodeAt(next) !== COLON) spans.push([start, i]);
  }
  return spans;
}

function redactLine(scanAndRedact: ScanAndRedact, line: string, options: MaskOptions): string {
  const spans = valueStringSpans(line);
  const values = spans.map(([start, end]) => JSON.parse(line.slice(start, end)) as string);
  // One walk over all values, so maxTotalLeaves bounds the whole line.
  const masked = maskLogValueWith(scanAndRedact, values, options);
  if (!Array.isArray(masked)) throw new TypeError("unexpected walk result");
  let out = "";
  let last = 0;
  spans.forEach(([start, end], index) => {
    // Values past maxArrayLength were dropped by the walk: never pass them through.
    const value = index < masked.length ? masked[index] : LIMIT_MARKER;
    if (value === values[index]) return;
    out += `${line.slice(last, start)}${JSON.stringify(value)}`;
    last = end;
  });
  return out + line.slice(last);
}

/**
 * Builds a pino `hooks.streamWrite` function. Never throws: a line it
 * cannot parse is replaced by `{"msg":"[REDACTED:ERROR]"}`, never written
 * as is.
 */
export function createRedactingStreamWriteWith(
  scanAndRedact: ScanAndRedact,
  options: MaskOptions = {},
): RedactingStreamWrite {
  if (typeof scanAndRedact !== "function") {
    throw new TypeError("createRedactingStreamWriteWith: scanAndRedact must be a function");
  }
  return function redactingStreamWrite(line) {
    try {
      return redactLine(scanAndRedact, line, options);
    } catch {
      return `${JSON.stringify({ msg: ERROR_MARKER })}${String(line).endsWith("\n") ? "\n" : ""}`;
    }
  };
}
