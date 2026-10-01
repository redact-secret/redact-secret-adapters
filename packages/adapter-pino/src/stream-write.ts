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
import { ERROR_MARKER, LIMIT_MARKER, maskKeyedLeavesWith } from "@redact-secret/adapter";

/** The exact shape of pino's `hooks.streamWrite`. */
export type RedactingStreamWrite = (line: string) => string;

/**
 * The fixed line written in place of one that could not be lexed. Public so a
 * host observing outcomes can recognise it without pattern-matching: pino
 * always emits a `level`, so this can never be a line pino itself produced.
 */
export const PINO_ERROR_LINE = JSON.stringify({ msg: ERROR_MARKER });

const QUOTE = 34;
const BACKSLASH = 92;
const COLON = 58;

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/** One string literal that is a value: its `[start, end)` span and the raw literal of the key it sits directly under. */
interface ValueSpan {
  readonly start: number;
  readonly end: number;
  readonly keySpan: readonly [number, number] | undefined;
}

/**
 * Every string literal in `line` that is a value, not an object key, with the
 * key literal it sits directly under (`"key": "value"`, any whitespace
 * between). A value that is an array element, or follows a non-string, has
 * none. Keys are left alone, as the walker leaves keys alone.
 */
function valueStringSpans(line: string): ValueSpan[] {
  const spans: ValueSpan[] = [];
  let pendingKey: [number, number] | undefined;
  let pendingAt = -1;
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
    if (line.charCodeAt(next) === COLON) {
      // A key: if the next token is a string, that string is its value.
      let after = next + 1;
      while (after < line.length && isWhitespace(line.charCodeAt(after))) after++;
      pendingKey = [start, i];
      pendingAt = after;
    } else {
      spans.push({ start, end: i, keySpan: pendingAt === start ? pendingKey : undefined });
    }
  }
  return spans;
}

function redactLine(scanAndRedact: ScanAndRedact, line: string, options: MaskOptions): string {
  const spans = valueStringSpans(line);
  const values = spans.map(({ start, end }) => JSON.parse(line.slice(start, end)) as string);
  const keys = spans.map(({ keySpan }) =>
    keySpan === undefined ? undefined : (JSON.parse(line.slice(keySpan[0], keySpan[1])) as string),
  );
  // One walk over all values, so maxTotalLeaves bounds the whole line.
  const masked = maskKeyedLeavesWith(scanAndRedact, values, keys, options);
  if (!Array.isArray(masked)) throw new TypeError("unexpected walk result");
  let out = "";
  let last = 0;
  spans.forEach(({ start, end }, index) => {
    // Values past maxArrayLength were dropped by the walk: never pass them
    // through. The walk could not count them — it never saw them — so they are
    // counted here, or `limited` would under-report exactly the refused values.
    const dropped = index >= masked.length;
    if (dropped && options.counter !== undefined) options.counter.limited += 1;
    const value = dropped ? LIMIT_MARKER : masked[index];
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
      // The whole line is one value the adapter could not represent.
      if (options.counter !== undefined) options.counter.failed += 1;
      return `${PINO_ERROR_LINE}${String(line).endsWith("\n") ? "\n" : ""}`;
    }
  };
}
