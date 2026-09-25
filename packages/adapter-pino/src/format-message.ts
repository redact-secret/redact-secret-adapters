/**
 * A line-for-line port of the string branch of `quick-format-unescaped`
 * 4.0.4 (MIT, https://github.com/pinojs/quick-format-unescaped), the
 * formatter pino applies to `msg` after `hooks.logMethod` returns. The
 * hook joins with it so the scanner sees the exact string pino will write —
 * including its quirks: an unmatched placeholder stays literal, an unused
 * trailing value is dropped, and `%%` consumes no value.
 * `test/format-message.test.ts` checks it byte for byte against the real
 * package.
 *
 * One known divergence: `%j`/`%o`/`%O` use `JSON.stringify` (the
 * package default), where pino passes its own safe, `redact`-aware
 * stringifier. Output can differ for circular values, bigints, or paths
 * pino's `redact` would censor; the joined text is still scanned by value.
 */

function tryStringify(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[Circular]"';
  }
}

/**
 * Formats `fmt` with `values` (the arguments after `msg`) exactly as pino
 * would.
 *
 * @internal Exported for `@redact-secret/adapter-pino`'s own tests and kept
 * for compatibility; not part of the supported API and may change in any
 * release.
 */
export function formatPinoMessage(fmt: string, values: readonly unknown[]): string {
  const argLen = values.length;
  if (argLen === 0) return fmt;

  let str = "";
  let a = 0;
  let lastPos = -1;
  const flen = fmt.length;

  for (let i = 0; i < flen; ) {
    if (fmt.charCodeAt(i) === 37 /* '%' */ && i + 1 < flen) {
      lastPos = lastPos > -1 ? lastPos : 0;
      switch (fmt.charCodeAt(i + 1)) {
        case 100: // 'd'
        case 102: // 'f'
          if (a >= argLen) break;
          if (values[a] == null) break;
          if (lastPos < i) str += fmt.slice(lastPos, i);
          str += Number(values[a]);
          lastPos = i + 2;
          i++;
          break;
        case 105: // 'i'
          if (a >= argLen) break;
          if (values[a] == null) break;
          if (lastPos < i) str += fmt.slice(lastPos, i);
          str += Math.floor(Number(values[a]));
          lastPos = i + 2;
          i++;
          break;
        case 79: // 'O'
        case 111: // 'o'
        case 106: // 'j'
          if (a >= argLen) break;
          if (values[a] === undefined) break;
          if (lastPos < i) str += fmt.slice(lastPos, i);
          {
            const type = typeof values[a];
            if (type === "string") {
              // biome-ignore lint/style/useTemplate: kept line-for-line with quick-format-unescaped
              str += "'" + values[a] + "'";
              lastPos = i + 2;
              i++;
              break;
            }
            if (type === "function") {
              str += (values[a] as { name?: string }).name || "<anonymous>";
              lastPos = i + 2;
              i++;
              break;
            }
          }
          str += tryStringify(values[a]);
          lastPos = i + 2;
          i++;
          break;
        case 115: // 's'
          if (a >= argLen) break;
          if (lastPos < i) str += fmt.slice(lastPos, i);
          str += String(values[a]);
          lastPos = i + 2;
          i++;
          break;
        case 37: // '%'
          if (lastPos < i) str += fmt.slice(lastPos, i);
          str += "%";
          lastPos = i + 2;
          i++;
          a--;
          break;
      }
      a++;
    }
    i++;
  }

  if (lastPos === -1) return fmt;
  if (lastPos < flen) str += fmt.slice(lastPos);
  return str;
}
