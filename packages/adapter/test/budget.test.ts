/**
 * The aggregate operation budget (redact-secret-adapters#173): what each
 * counter counts, the boundary values, sticky exhaustion, and the walker's use
 * of it. Every value is synthetic.
 */

import { expect, test } from "vitest";

import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { keyAwareScanner } from "../../../fixtures/key-aware-scanner.js";
import {
  createOperationBudget,
  createOutcomeCounter,
  DEFAULT_OPERATION_LIMITS,
  LIMIT_MARKER,
  maskLeafOutcomeWith,
  maskSecretsWith,
  resolveOperationLimits,
  type ScanAndRedact,
  utf8ByteLength,
} from "../src/index.js";

function counting(inner: ScanAndRedact = fakeScanAndRedact) {
  const seen: string[] = [];
  const scan: ScanAndRedact = (text, options) => {
    seen.push(text);
    return inner(text, options);
  };
  return { scan, seen };
}

test("UTF-8 byte accounting: ASCII, two-, three- and four-byte characters, lone surrogates", () => {
  expect(utf8ByteLength("")).toBe(0);
  expect(utf8ByteLength("abc")).toBe(3);
  expect(utf8ByteLength("é")).toBe(2);
  expect(utf8ByteLength("한국어")).toBe(9);
  expect(utf8ByteLength("😀")).toBe(4);
  expect(utf8ByteLength("a😀한é")).toBe(1 + 4 + 3 + 2);
  expect(utf8ByteLength("\ud800")).toBe(3);
  expect(utf8ByteLength("\udc00x")).toBe(4);
  expect(utf8ByteLength("\ud800x")).toBe(4);
  expect(utf8ByteLength(Buffer.from("한😀é").toString())).toBe(Buffer.byteLength("한😀é"));
});

test("defaults are frozen and an unusable override falls back per key", () => {
  expect(Object.isFrozen(DEFAULT_OPERATION_LIMITS)).toBe(true);
  expect(DEFAULT_OPERATION_LIMITS).toEqual({
    maxBytes: 16_777_216,
    maxNodes: 100_000,
    maxKeys: 100_000,
    maxLeaves: 25_000,
    maxScans: 50_000,
    maxFindings: 100_000,
  });
  const resolved = resolveOperationLimits({ maxBytes: Number.NaN, maxNodes: -1, maxLeaves: 3, maxScans: "9" as never });
  expect(resolved).toEqual({ ...DEFAULT_OPERATION_LIMITS, maxLeaves: 3 });
  expect(resolveOperationLimits(null as never)).toEqual(DEFAULT_OPERATION_LIMITS);
});

test("every counter stops at exactly its limit, and a failed charge consumes nothing", () => {
  const charges: [string, (b: ReturnType<typeof createOperationBudget>) => boolean][] = [
    ["maxNodes", (b) => b.chargeNode()],
    ["maxKeys", (b) => b.chargeKey()],
    ["maxLeaves", (b) => b.chargeLeaf()],
    ["maxScans", (b) => b.chargeScan(0)],
    ["maxFindings", (b) => b.chargeFindings(1)],
  ];
  for (const [limit, charge] of charges) {
    const budget = createOperationBudget({ [limit]: 3 });
    expect([charge(budget), charge(budget), charge(budget)]).toEqual([true, true, true]);
    expect(budget.exhausted).toBe(false);
    const before = budget.usage();
    expect(charge(budget), limit).toBe(false);
    expect(budget.exhausted).toBe(true);
    expect(budget.usage()).toEqual(before);
  }
});

test("bytes: a scan that exactly fits passes, one byte over fails and spends nothing", () => {
  const budget = createOperationBudget({ maxBytes: 10 });
  expect(budget.chargeScan(4)).toBe(true);
  expect(budget.chargeScan(6)).toBe(true);
  expect(budget.usage()).toMatchObject({ bytes: 10, scans: 2 });
  const over = createOperationBudget({ maxBytes: 10 });
  expect(over.chargeScan(11)).toBe(false);
  expect(over.usage()).toMatchObject({ bytes: 0, scans: 0 });
});

test("exhaustion is sticky: after any overrun every charge fails, even a small one", () => {
  const budget = createOperationBudget({ maxBytes: 5 });
  expect(budget.chargeScan(6)).toBe(false);
  expect(budget.chargeScan(1)).toBe(false);
  expect(budget.chargeNode()).toBe(false);
  expect(budget.chargeFindings(0)).toBe(false);
});

test("a leaf past the budget is limited and the core is not called", () => {
  const { scan, seen } = counting();
  const budget = createOperationBudget({ maxScans: 1 });
  expect(maskLeafOutcomeWith(scan, "SECRET_TOKEN_1", { budget }).text).toBe("<SECRET_1>");
  expect(maskLeafOutcomeWith(scan, "SECRET_TOKEN_2", { budget })).toEqual({
    text: LIMIT_MARKER,
    outcome: "limited",
    findings: 0,
  });
  expect(seen).toEqual(["SECRET_TOKEN_1"]);
});

test("the key-context view is charged as a second scan and its UTF-8 bytes", () => {
  const { scan } = counting(keyAwareScanner());
  const budget = createOperationBudget();
  maskLeafOutcomeWith(scan, "한국어", { key: "k", budget });
  // "한국어" (9 bytes) alone, then {"k":"한국어"} (8 + 9 bytes).
  expect(budget.usage()).toMatchObject({ scans: 2, bytes: 9 + 17 });
  const tight = createOperationBudget({ maxScans: 1 });
  const out = maskLeafOutcomeWith(scan, "한국어", { key: "k", budget: tight });
  expect(out.outcome).toBe("limited");
});

test("many small fields stop at the operation's leaf bound, deterministically, with no unscanned value passing", () => {
  const { scan, seen } = counting();
  const data = Object.fromEntries(Array.from({ length: 50 }, (_, index) => [`f${index}`, `SECRET_TOKEN_${index}`]));
  const counter = createOutcomeCounter();
  const out = maskSecretsWith(scan, data, { operationLimits: { maxLeaves: 10 }, counter }) as Record<string, string>;
  const values = Object.values(out);
  expect(values.filter((value) => value === "<SECRET_1>")).toHaveLength(10);
  // The first leaf past the bound is limited; exhaustion is sticky, so the
  // keys after it are dropped, never passed through.
  expect(values.filter((value) => value === LIMIT_MARKER)).toHaveLength(1);
  expect(Object.keys(out)).toHaveLength(11);
  expect(JSON.stringify(out)).not.toContain("SECRET_TOKEN");
  // Keyed leaves are scanned alone and in context only when the first scan finds nothing: 10 here.
  expect(seen).toHaveLength(10);
  expect(counter).toMatchObject({ scanned: 10, limited: 2, redacted: 10 });
  expect(maskSecretsWith(scan, data, { operationLimits: { maxLeaves: 10 } })).toEqual(out);
});

test("a shared reference reached by many paths is stopped by the node bound", () => {
  const shared = ["a", "b", "c"];
  const data = Array.from({ length: 200 }, () => shared);
  const out = maskSecretsWith(fakeScanAndRedact, data, { operationLimits: { maxNodes: 50 } }) as unknown[];
  expect(JSON.stringify(out)).toContain(LIMIT_MARKER);
  const again = maskSecretsWith(fakeScanAndRedact, data, { operationLimits: { maxNodes: 50 } });
  expect(again).toEqual(out);
});

test("an object with many keys is stopped by the key bound and never passes its remaining values", () => {
  const data = Object.fromEntries(Array.from({ length: 100 }, (_, index) => [`k${index}`, "SECRET_TOKEN_9"]));
  const counter = createOutcomeCounter();
  const out = maskSecretsWith(fakeScanAndRedact, data, { operationLimits: { maxKeys: 7 }, counter }) as Record<
    string,
    string
  >;
  expect(Object.keys(out)).toHaveLength(7);
  expect(JSON.stringify(out)).not.toContain("SECRET_TOKEN");
  expect(counter.limited).toBeGreaterThan(0);
});

test("a finding bound counts every finding the core reports", () => {
  const data = ["SECRET_TOKEN_1", "SECRET_TOKEN_2", "SECRET_TOKEN_3"];
  expect(maskSecretsWith(fakeScanAndRedact, data, { operationLimits: { maxFindings: 2 } })).toEqual([
    "<SECRET_1>",
    "<SECRET_1>",
    LIMIT_MARKER,
  ]);
});

test("Unicode bytes, not code units, are what the byte bound counts", () => {
  // 10 Korean characters are 10 code units but 30 bytes.
  const leaf = "한".repeat(10);
  expect(maskSecretsWith(fakeScanAndRedact, [leaf, leaf], { operationLimits: { maxBytes: 59 } })).toEqual([
    leaf,
    LIMIT_MARKER,
  ]);
  expect(maskSecretsWith(fakeScanAndRedact, [leaf, leaf], { operationLimits: { maxBytes: 60 } })).toEqual([leaf, leaf]);
});

test("a caller-owned operation is shared across passes; two operations never share", () => {
  const operation = createOperationBudget({ maxLeaves: 3 });
  expect(maskSecretsWith(fakeScanAndRedact, ["a", "b"], { operation })).toEqual(["a", "b"]);
  expect(maskSecretsWith(fakeScanAndRedact, ["c", "d"], { operation })).toEqual(["c", LIMIT_MARKER]);
  // A fresh call with no shared budget starts from zero.
  expect(maskSecretsWith(fakeScanAndRedact, ["c", "d"], { operationLimits: { maxLeaves: 3 } })).toEqual(["c", "d"]);
});

test("re-entry: masking inside a getter during a walk spends its own budget, not the outer one", () => {
  let inner: unknown;
  const data = {
    get nested() {
      inner = maskSecretsWith(fakeScanAndRedact, ["x", "y"], { operationLimits: { maxLeaves: 2 } });
      return "z";
    },
    other: "w",
  };
  const out = maskSecretsWith(fakeScanAndRedact, data, { operationLimits: { maxLeaves: 2 } });
  expect(inner).toEqual(["x", "y"]);
  expect(out).toEqual({ nested: "z", other: "w" });
});

test("the default budget leaves an ordinary value untouched, and per-walk limits still apply first", () => {
  const data = { a: "x", b: ["y", { c: "SECRET_TOKEN_1" }] };
  expect(maskSecretsWith(fakeScanAndRedact, data)).toEqual({ a: "x", b: ["y", { c: "<SECRET_1>" }] });
  const long = "a".repeat(100);
  expect(maskSecretsWith(fakeScanAndRedact, [long], { limits: { maxStringLength: 10 } })).toEqual([LIMIT_MARKER]);
});
