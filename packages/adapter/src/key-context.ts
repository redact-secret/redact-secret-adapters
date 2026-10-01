/**
 * The shared key-context scan primitive (redact-secret/redact-secret-adapters#172).
 *
 * Some credentials are only recognisable by the field name they sit under
 * (`{"api_key":"..."}`). The core owns that decision: this module detects
 * nothing, holds no key pattern or name list, and decides no policy. It only
 * builds the leaf's *key-context view* `{"<key>":"<leaf>"}` (key and leaf
 * verbatim, never escaped, so every offset the core reports stays an exact
 * UTF-16 offset into the view), asks the injected scan for a second opinion,
 * and maps what comes back onto the leaf.
 *
 * The AI-context boundary was the first user; the logging walker, pino's
 * final-line masking and both trace processors use the same function, so a
 * credential whose detection depends on its field name is treated the same
 * way by every adapter. The caller supplies the scan (and with it its own
 * options, memoization, budgets and failure type); this module supplies the
 * view, the offset mapping and the rules for when the view's answer is used.
 */

/** The fields of a finding this module reads. A real core finding has more; they are kept. */
export interface KeyContextFinding {
  readonly action?: string;
  readonly start: number;
  readonly end: number;
}

/** What one successful scan returns to this module. */
export interface KeyContextScanned<F extends KeyContextFinding = KeyContextFinding> {
  readonly text: string;
  readonly findings: readonly F[];
}

/**
 * The failures this module raises itself. `policy`: the view reported a
 * redacting or blocking finding outside the leaf, which cannot be applied
 * without rewriting the key (or crossing the leaf boundary). `coreError`:
 * the core's view answer broke the contract that nothing outside the leaf is
 * rewritten. Both are the caller's to map: a host that must not release a
 * partly approved value blocks; a host that masks in place replaces the leaf.
 */
export interface KeyContextFailures<X> {
  readonly policy: X;
  readonly coreError: X;
}

const PREFIX_OPEN = '{"';
const PREFIX_CLOSE = '":"';
const SUFFIX = '"}';

/** `{"<key>":"` */
export function keyContextPrefix(key: string): string {
  return `${PREFIX_OPEN}${key}${PREFIX_CLOSE}`;
}

/** `"}` */
export const KEY_CONTEXT_SUFFIX = SUFFIX;

/** `{"<key>":"<leaf>"}`, with the key and the leaf verbatim. */
export function keyContextView(key: string, text: string): string {
  return keyContextPrefix(key) + text + SUFFIX;
}

function redactsOrBlocks(finding: KeyContextFinding | null | undefined): boolean {
  return finding?.action === "redact" || finding?.action === "block";
}

function anyRedactsOrBlocks(findings: readonly KeyContextFinding[]): boolean {
  return findings.some(redactsOrBlocks);
}

/**
 * Scans one string leaf, key-aware. `scan` is the caller's whole-input scan
 * of one string.
 *
 * The leaf is scanned alone. When that redacts or blocks nothing and the leaf
 * sits directly under an object key (`key` is a string), it is scanned again
 * in its view. A view finding inside the leaf's span is shifted to leaf
 * offsets; a redacting or blocking one outside it fails with
 * `failures.policy`, since the key cannot be rewritten. The view's result
 * replaces the leaf-alone one, whole, when it redacts or blocks, or when the
 * leaf alone reported nothing. Two results are never merged. Any finding that
 * is not redact or block outside the leaf (`warn`, `allow`) is dropped: it
 * describes text that is not the leaf.
 *
 * A `scan` failure on either call is returned unchanged, and the leaf is
 * never returned unscanned.
 */
export function scanLeafInKeyContext<F extends KeyContextFinding, X>(
  scan: (text: string) => KeyContextScanned<F> | { readonly failure: X },
  text: string,
  key: string | undefined,
  failures: KeyContextFailures<X>,
): KeyContextScanned<F> | { readonly failure: X } {
  const alone = scan(text);
  if ("failure" in alone || key === undefined || anyRedactsOrBlocks(alone.findings)) return alone;
  const prefix = keyContextPrefix(key);
  const view = scan(prefix + text + SUFFIX);
  if ("failure" in view) return view;
  const leafEnd = prefix.length + text.length;
  const findings: F[] = [];
  for (const finding of view.findings) {
    if (finding.start >= prefix.length && finding.end <= leafEnd) {
      findings.push(
        Object.freeze({ ...finding, start: finding.start - prefix.length, end: finding.end - prefix.length }),
      );
    } else if (redactsOrBlocks(finding)) {
      return { failure: failures.policy };
    }
  }
  if (!anyRedactsOrBlocks(findings) && alone.findings.length > 0) return alone;
  // Nothing outside the leaf was rewritten, so the view's text is the
  // prefix, the sanitized leaf, and the suffix; anything else is a core
  // that broke its own contract.
  if (
    !view.text.startsWith(prefix) ||
    !view.text.endsWith(SUFFIX) ||
    view.text.length < prefix.length + SUFFIX.length
  ) {
    return { failure: failures.coreError };
  }
  return { text: view.text.slice(prefix.length, view.text.length - SUFFIX.length), findings };
}
