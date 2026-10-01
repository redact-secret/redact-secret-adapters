/**
 * A deterministic stand-in for a core whose detection is key-aware, for
 * tests that must control what the key-context view reports. It detects
 * nothing on its own text: only a leaf's view `{"<key>":"<leaf>"}` whose key
 * is one of `KEYS` and whose leaf is at least eight characters long, over
 * the leaf's span (UTF-16 offsets, like the real core). Everything else
 * falls through to `fakeScanAndRedact`'s magic substrings.
 */

import type { ScanResult, SecretAction, SecretFinding } from "@redact-secret/core";

import { fakeScanAndRedact } from "./fake-scanner.js";

export const KEYS = ["api_key", "password", "client_secret"] as const;

export interface KeyAwareOptions {
  /** The action of the finding the view produces. Default `redact`. */
  readonly action?: SecretAction;
  /** Also report a finding over the key itself, which cannot be applied. */
  readonly spanKey?: boolean;
  /** Return view text that does not keep the prefix, a broken core contract. */
  readonly corruptText?: boolean;
  /** Throw on every view scan. */
  readonly throwOnView?: boolean;
}

const VIEW = /^\{"(api_key|password|client_secret)":"([\s\S]*)"\}$/;

function finding(action: SecretAction, start: number, end: number): SecretFinding {
  return {
    id: "finding-1",
    type: "contextual_secret",
    detector: "fake",
    confidence: "high",
    obfuscation: "none",
    action,
    start,
    end,
  };
}

export function keyAwareScanner(options: KeyAwareOptions = {}): (text: string) => ScanResult {
  const action = options.action ?? "redact";
  return (text) => {
    const match = VIEW.exec(text);
    if (match === null) return fakeScanAndRedact(text);
    if (options.throwOnView) throw new Error(`simulated view failure for ${text}`);
    const leaf = match[2] ?? "";
    const start = (match[1] ?? "").length + 5;
    const findings: SecretFinding[] = [];
    if (options.spanKey) findings.push(finding("redact", 2, 2 + (match[1] ?? "").length));
    if (leaf.length < 8) return { text, findings };
    findings.push(finding(action, start, start + leaf.length));
    if (options.corruptText) return { text: "<SECRET_1>", findings };
    const replaced = action === "redact" || action === "block" ? "<SECRET_1>" : leaf;
    return { text: `${text.slice(0, start)}${replaced}${text.slice(start + leaf.length)}`, findings };
  };
}
