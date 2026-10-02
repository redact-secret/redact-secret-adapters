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
import { ERROR_MARKER, LIMIT_MARKER, maskKeyedLeavesWith, withResolvedScanConfig } from "@redact-secret/adapter";

/** The exact shape of pino's `hooks.streamWrite`. */
export type RedactingStreamWrite = (line: string) => string;

/**
 * The fixed line written in place of one that could not be lexed. Public so a
 * host observing outcomes can recognise it without pattern-matching: pino
 * always emits a `level`, so this can never be a line pino itself produced.
 */
export const PINO_ERROR_LINE = JSON.stringify({ msg: ERROR_MARKER });

/**
 * The fixed line written in place of one the adapter refused to inspect
 * because a budget was spent (the aggregate operation budget, redact-secret/
 * redact-secret-adapters#173, or a pre-processing ceiling, #174), as opposed
 * to one it could not lex. A valid JSON object like {@link PINO_ERROR_LINE},
 * and never a line pino itself produced.
 */
export const PINO_LIMIT_LINE = JSON.stringify({ msg: LIMIT_MARKER });

/** Whether `line` is one of the fixed replacement lines, with or without its newline. */
export function isReplacementLine(line: string): boolean {
  const bare = line.endsWith("\n") ? line.slice(0, -1) : line;
  return bare === PINO_ERROR_LINE || bare === PINO_LIMIT_LINE;
}

/**
 * A ceiling or a budget refused the whole line. `counted` is whether the walk
 * that spent it already added to the `limited` counter.
 */
class LineLimitExceeded extends Error {
  constructor(readonly counted: boolean) {
    super("line limit exceeded");
  }
}

const QUOTE = 34;
const BACKSLASH = 92;
const COLON = 58;

function isWhitespace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

/**
 * The pre-processing ceilings: what the hook refuses **before** it has
 * allocated anything proportional to the line (redact-secret/
 * redact-secret-adapters#174). They bound the work of lexing and decoding the
 * finished JSON line into the values the walker is then handed, and nothing
 * else; they are not the core's input limits and not the walker's traversal
 * limits (see "How the three kinds of limit differ" in the package README).
 *
 * Every size is in UTF-16 code units (`string.length`), not bytes, because a
 * code-unit count is what JavaScript can read in O(1) before looking at the
 * line at all. A bound met exactly is accepted; one more is refused.
 */
export interface PinoLineLimits {
  /**
   * The longest line the hook will lex at all. A longer one is refused at once,
   * unread. Default 4,194,304 (4 Mi code units).
   */
  readonly maxLineLength: number;
  /**
   * The most string literals that are *values* (object keys are not counted)
   * the lexer will collect. The count is checked as each span is found, before
   * the span list or any decoded value can grow past it. Default 20,000.
   */
  readonly maxValueSpans: number;
  /**
   * The most raw code units of string literals the hook will JSON-decode in
   * all: every value literal plus the key literal it sits under. It bounds the
   * cumulative decoding work, so many long, escape-heavy literals cannot cost
   * more than this however the line is shaped. Checked while spans are
   * collected, before any literal is decoded. Default 2,097,152 (2 Mi).
   */
  readonly maxDecodeLength: number;
}

/** The defaults of {@link PinoLineLimits}. Frozen. */
export const DEFAULT_LINE_LIMITS: PinoLineLimits = Object.freeze({
  maxLineLength: 4_194_304,
  maxValueSpans: 20_000,
  maxDecodeLength: 2_097_152,
});

/** Options of the single-hook factory: the walk's {@link MaskOptions} plus the pre-processing ceilings. */
export interface StreamWriteOptions extends MaskOptions {
  /** Override the pre-processing ceilings. Omitted or unusable (`NaN`, negative, not a number) keys use the defaults. */
  readonly lineLimits?: Partial<PinoLineLimits> | undefined;
}

function resolveLineLimits(overrides: Partial<PinoLineLimits> | undefined): PinoLineLimits {
  if (overrides !== undefined && (overrides === null || typeof overrides !== "object")) {
    throw new TypeError("createRedactingStreamWriteWith: lineLimits must be an object");
  }
  const limits: { -readonly [K in keyof PinoLineLimits]: number } = { ...DEFAULT_LINE_LIMITS };
  for (const key of Object.keys(DEFAULT_LINE_LIMITS) as (keyof PinoLineLimits)[]) {
    const value: unknown = overrides?.[key];
    if (typeof value === "number" && value >= 0) limits[key] = value;
  }
  return Object.freeze(limits);
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
 *
 * Bounded as it goes: the span count and the cumulative raw literal length are
 * checked as each span is found, so a line of many tiny literals or a few huge
 * ones is refused before the span list, a decoded value or a masking input has
 * been built past the ceiling.
 */
function valueStringSpans(line: string, limits: PinoLineLimits): ValueSpan[] {
  const spans: ValueSpan[] = [];
  let decodeLength = 0;
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
      const keySpan = pendingAt === start ? pendingKey : undefined;
      if (spans.length >= limits.maxValueSpans) throw new LineLimitExceeded(false);
      decodeLength += i - start + (keySpan === undefined ? 0 : keySpan[1] - keySpan[0]);
      if (decodeLength > limits.maxDecodeLength) throw new LineLimitExceeded(false);
      spans.push({ start, end: i, keySpan });
    }
  }
  return spans;
}

function redactLine(scanAndRedact: ScanAndRedact, line: string, options: StreamWriteOptions, limits: PinoLineLimits) {
  // Before the line is read at all: `length` is O(1), so an oversized line
  // costs nothing but this comparison.
  if (line.length > limits.maxLineLength) throw new LineLimitExceeded(false);
  const spans = valueStringSpans(line, limits);
  const values = spans.map(({ start, end }) => JSON.parse(line.slice(start, end)) as string);
  const keys = spans.map(({ keySpan }) =>
    keySpan === undefined ? undefined : (JSON.parse(line.slice(keySpan[0], keySpan[1])) as string),
  );
  // One walk over all values, so maxTotalLeaves bounds the whole line.
  const masked = maskKeyedLeavesWith(scanAndRedact, values, keys, options);
  // The operation's budget spent before any of the line's values was visited
  // comes back as a bare marker: a refusal of the whole line, not a malformed
  // result. (A per-walk bound such as `maxDepth: 0` keeps failing to the error
  // line, as it always has.)
  if (masked === LIMIT_MARKER && options.operation?.exhausted === true) throw new LineLimitExceeded(true);
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
 * Builds a pino `hooks.streamWrite` function. Never throws. A line it cannot
 * lex is replaced by `{"msg":"[REDACTED:ERROR]"}`, and a line a ceiling or a
 * budget refuses by `{"msg":"[REDACTED:LIMIT_EXCEEDED]"}`; each keeps the
 * original's trailing newline, is valid JSON, and is never the original line.
 * Neither a failed parse nor a limit forwards the line unmasked.
 */
export function createRedactingStreamWriteWith(
  scanAndRedact: ScanAndRedact,
  options: StreamWriteOptions = {},
): RedactingStreamWrite {
  if (typeof scanAndRedact !== "function") {
    throw new TypeError("createRedactingStreamWriteWith: scanAndRedact must be a function");
  }
  const limits = resolveLineLimits(options.lineLimits);
  // Validated and snapshotted once: a malformed scan option throws here.
  const resolved = withResolvedScanConfig(options);
  return function redactingStreamWrite(line) {
    try {
      return redactLine(scanAndRedact, line, resolved, limits);
    } catch (error) {
      // `line.endsWith` is not read on a non-string: the fixed line has no newline then.
      const newline = typeof line === "string" && line.endsWith("\n") ? "\n" : "";
      if (error instanceof LineLimitExceeded) {
        // The whole line was refused by a ceiling or a budget, not malformed.
        if (!error.counted && resolved.counter !== undefined) resolved.counter.limited += 1;
        return `${PINO_LIMIT_LINE}${newline}`;
      }
      // The whole line is one value the adapter could not represent.
      if (resolved.counter !== undefined) resolved.counter.failed += 1;
      return `${PINO_ERROR_LINE}${newline}`;
    }
  };
}
