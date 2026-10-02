/**
 * The shared key-context primitive and the logging walker's use of it
 * (redact-secret-adapters#172), against a scanner whose key-context answer the
 * test controls. The real-core replay is in `key-context-live.test.ts`.
 */

import { expect, test } from "vitest";

import { keyAwareScanner } from "../../../fixtures/key-aware-scanner.js";
import {
  BLOCK_MARKER,
  ERROR_MARKER,
  KEY_CONTEXT_SUFFIX,
  keyContextPrefix,
  keyContextView,
  LIMIT_MARKER,
  maskKeyedLeavesWith,
  maskLeafOutcomeWith,
  maskLeafWith,
  maskSecretsWith,
  type ScanAndRedact,
  scanLeafInKeyContext,
} from "../src/index.js";

const LEAF = "synthetic-example-value-0001";

test("the view is the key and the leaf, verbatim, in a one-key object", () => {
  expect(keyContextPrefix('a"b')).toBe('{"a"b":"');
  expect(KEY_CONTEXT_SUFFIX).toBe('"}');
  expect(keyContextView("password", 'x"\\y')).toBe('{"password":"x"\\y"}');
});

test("a context-dependent leaf under its key is masked; the same leaf under a benign key, in an array, or at the root is not", () => {
  const scan = keyAwareScanner();
  expect(maskSecretsWith(scan, { password: LEAF, name: LEAF, list: [LEAF] })).toEqual({
    password: "<SECRET_1>",
    name: LEAF,
    list: [LEAF],
  });
  expect(maskSecretsWith(scan, LEAF)).toBe(LEAF);
});

test("key context reaches nested objects, error properties and toJSON results, and the object shape is unchanged", () => {
  const scan = keyAwareScanner();
  const error = Object.assign(new Error("failed"), { password: LEAF });
  const dated = { toJSON: () => LEAF };
  const masked = maskSecretsWith(scan, { outer: { client_secret: LEAF }, error, api_key: dated }) as {
    outer: unknown;
    error: { password: unknown };
    api_key: unknown;
  };
  expect(masked.outer).toEqual({ client_secret: "<SECRET_1>" });
  expect(masked.error.password).toBe("<SECRET_1>");
  expect(masked.api_key).toBe("<SECRET_1>");
  expect(Object.keys(masked)).toEqual(["outer", "error", "api_key"]);
});

test("offsets are leaf offsets: UTF-16 units survive emoji and Korean, and the leaf alone reports none", () => {
  const scan = keyAwareScanner();
  for (const leaf of ["😀synthetic-example-0001", "한국어-가짜-비밀번호-1234", `say "hi" \\ ${LEAF}`]) {
    const out = maskLeafOutcomeWith(scan, leaf, { key: "password" });
    expect(out.text).toBe("<SECRET_1>");
    expect(out.outcome).toBe("redacted");
    expect(out.findings).toBe(1);
  }
});

test("block, warn and allow policies from the key-context view", () => {
  expect(maskLeafWith(keyAwareScanner({ action: "block" }), LEAF)).toBe(LEAF);
  const options = { key: "password" };
  const block = maskLeafOutcomeWith(keyAwareScanner({ action: "block" }), LEAF, options);
  expect(block).toEqual({ text: BLOCK_MARKER, outcome: "blocked", findings: 1 });
  for (const action of ["warn", "allow"] as const) {
    const out = maskLeafOutcomeWith(keyAwareScanner({ action }), LEAF, options);
    expect(out).toEqual({ text: LEAF, outcome: "unchanged", findings: 1 });
  }
});

test("a view finding that would rewrite the key blocks the leaf, never the key", () => {
  const out = maskLeafOutcomeWith(keyAwareScanner({ spanKey: true }), LEAF, { key: "password" });
  expect(out.text).toBe(BLOCK_MARKER);
  expect(maskSecretsWith(keyAwareScanner({ spanKey: true }), { password: LEAF })).toEqual({ password: BLOCK_MARKER });
});

test("a view scan that throws or breaks the prefix contract fails the leaf closed, and the original never survives", () => {
  for (const options of [{ throwOnView: true }, { corruptText: true }]) {
    const out = maskLeafOutcomeWith(keyAwareScanner(options), LEAF, { key: "password" });
    expect(out).toEqual({ text: ERROR_MARKER, outcome: "failed", findings: 0 });
  }
});

test("a malformed view result fails closed", () => {
  const scan: ScanAndRedact = (text) =>
    text.startsWith('{"')
      ? ({ text: 1, findings: [] } as unknown as ReturnType<ScanAndRedact>)
      : { text, findings: [] };
  expect(maskLeafOutcomeWith(scan, LEAF, { key: "k" }).text).toBe(ERROR_MARKER);
});

test("a key longer than the string limit is refused before any scan", () => {
  const scan: ScanAndRedact = () => {
    throw new Error("must not be called");
  };
  const out = maskLeafOutcomeWith(scan, "v", { key: "k".repeat(20), maxStringLength: 10 });
  expect(out).toEqual({ text: LIMIT_MARKER, outcome: "limited", findings: 0 });
});

test("a non-string key is no key", () => {
  const seen: string[] = [];
  const scan: ScanAndRedact = (text) => {
    seen.push(text);
    return { text, findings: [] };
  };
  maskLeafOutcomeWith(scan, "v", { key: 7 as unknown as string });
  expect(seen).toEqual(["v"]);
});

test("a leaf the core already redacts is not scanned again", () => {
  const seen: string[] = [];
  const scan: ScanAndRedact = (text) => {
    seen.push(text);
    return keyAwareScanner()(text);
  };
  expect(maskLeafWith(scan, "SECRET_TOKEN_1", { key: "note" })).toBe("<SECRET_1>");
  expect(seen).toEqual(["SECRET_TOKEN_1"]);
});

test("the primitive is generic over the failure type and returns the scan's failure unchanged", () => {
  type Scanned = { text: string; findings: { action: string; start: number; end: number }[] };
  const failures = { policy: "policy", coreError: "core" } as const;
  const alone = (text: string): Scanned | { failure: string } =>
    text === "boom" ? { failure: "limit" } : { text, findings: [] };
  expect(scanLeafInKeyContext(alone, "boom", "k", failures)).toEqual({ failure: "limit" });
  const viewFails = (text: string): Scanned | { failure: string } =>
    text.startsWith('{"') ? { failure: "limit" } : { text, findings: [] };
  expect(scanLeafInKeyContext(viewFails, "v", "k", failures)).toEqual({ failure: "limit" });
  expect(scanLeafInKeyContext(viewFails, "v", undefined, failures)).toEqual({ text: "v", findings: [] });
});

test("flat leaves lifted from a document carry their keys", () => {
  const out = maskKeyedLeavesWith(keyAwareScanner(), [LEAF, LEAF, LEAF], ["password", undefined, "name"]);
  expect(out).toEqual(["<SECRET_1>", LEAF, LEAF]);
  expect(() => maskKeyedLeavesWith(null as unknown as ScanAndRedact, [], [])).toThrow(TypeError);
});

test("the keys of the root array are read for the root array only", () => {
  const out = maskKeyedLeavesWith(keyAwareScanner(), [LEAF], ["password"]) as string[];
  expect(out).toEqual(["<SECRET_1>"]);
  const nested = maskSecretsWith(keyAwareScanner(), [[LEAF]]);
  expect(nested).toEqual([[LEAF]]);
});
