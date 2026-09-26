/**
 * `walkStrict`, the all-or-nothing walker behind the AI-context boundary:
 * exact budgets, the JSON-shaped value set, visitor ordering, and that a
 * visitor's failure or exception is never swallowed into a different
 * outcome.
 */

import { describe, expect, test } from "vitest";

import { isStrictWalkLimits, type StrictWalkVisitors, walkStrict } from "../src/index.js";

const LIMITS = { maxDepth: 3, maxNodes: 10 };

function recorder(fail?: { string?: string; key?: string }) {
  const seen: string[] = [];
  const visitors: StrictWalkVisitors<"visitor"> = {
    string(text) {
      seen.push(`s:${text}`);
      return text === fail?.string ? { ok: false, failure: "visitor" } : { ok: true, text: text.toUpperCase() };
    },
    key(key) {
      seen.push(`k:${key}`);
      return key === fail?.key ? { ok: false, failure: "visitor" } : { ok: true };
    },
  };
  return { seen, visitors };
}

describe("walkStrict", () => {
  test("copies a JSON-shaped value, replacing every string through the visitor, in document order", () => {
    const { seen, visitors } = recorder();
    const input = { a: "x", b: [1, true, null, { c: "y" }] };
    const result = walkStrict(input, LIMITS, visitors);
    expect(result).toEqual({ ok: true, value: { a: "X", b: [1, true, null, { c: "Y" }] } });
    expect(seen).toEqual(["k:a", "s:x", "k:b", "k:c", "s:y"]);
    expect(result.ok && result.value).not.toBe(input);
  });

  test("hands each string leaf its immediate object key; array elements and the root get none", () => {
    const keys: [string, string | undefined][] = [];
    const visitors: StrictWalkVisitors<never> = {
      string(text, key) {
        keys.push([text, key]);
        return { ok: true, text };
      },
      key: () => ({ ok: true }),
    };
    walkStrict({ password: "a", list: ["b", { inner: "c" }], nested: { value: "d" } }, LIMITS, visitors);
    expect(keys).toEqual([
      ["a", "password"],
      ["b", undefined],
      ["c", "inner"],
      ["d", "value"],
    ]);
    keys.length = 0;
    walkStrict("root", LIMITS, visitors);
    expect(keys).toEqual([["root", undefined]]);
  });

  test("a visitor failure ends the walk with that failure; later values are not visited", () => {
    const { seen, visitors } = recorder({ string: "stop" });
    expect(walkStrict(["a", "stop", "never"], LIMITS, visitors)).toEqual({ ok: false, failure: "visitor" });
    expect(seen).toEqual(["s:a", "s:stop"]);
    const keyed = recorder({ key: "bad" });
    expect(walkStrict({ bad: "never" }, LIMITS, keyed.visitors)).toEqual({ ok: false, failure: "visitor" });
    expect(keyed.seen).toEqual(["k:bad"]);
  });

  test("maxDepth counts containers including the root; maxNodes counts every value but not keys", () => {
    const { visitors } = recorder();
    expect(walkStrict({ a: { b: { c: 1 } } }, LIMITS, visitors).ok).toBe(true);
    expect(walkStrict({ a: { b: { c: {} } } }, LIMITS, visitors)).toEqual({ ok: false, failure: "limit_exceeded" });
    expect(
      walkStrict(
        Array.from({ length: 9 }, () => 0),
        LIMITS,
        visitors,
      ).ok,
    ).toBe(true);
    expect(
      walkStrict(
        Array.from({ length: 10 }, () => 0),
        LIMITS,
        visitors,
      ),
    ).toEqual({
      ok: false,
      failure: "limit_exceeded",
    });
    expect(walkStrict({ k1: 0, k2: 0, k3: 0, k4: 0, k5: 0, k6: 0, k7: 0, k8: 0, k9: 0 }, LIMITS, visitors).ok).toBe(
      true,
    );
    expect(walkStrict("leaf", { maxDepth: 0, maxNodes: 1 }, visitors)).toEqual({ ok: true, value: "LEAF" });
    expect(walkStrict([], { maxDepth: 0, maxNodes: 1 }, visitors)).toEqual({ ok: false, failure: "limit_exceeded" });
  });

  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  test.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["-Infinity", Number.NEGATIVE_INFINITY],
    ["bigint", 1n],
    ["symbol", Symbol("x")],
    ["function", () => 1],
    ["Date", new Date(0)],
    ["Set", new Set()],
    ["class instance", new (class Box {})()],
    ["boxed number", new Number(1)],
    // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test.
    ["array hole", [1, , 2]],
    ["revoked Proxy", revoked.proxy],
    [
      "throwing getter",
      Object.defineProperty({}, "k", {
        enumerable: true,
        get() {
          throw new Error("unreadable");
        },
      }),
    ],
  ])("%s is unsupported_value", (_name, value) => {
    expect(walkStrict({ wrap: value }, LIMITS, recorder().visitors)).toEqual({
      ok: false,
      failure: "unsupported_value",
    });
  });

  test("a cycle is unsupported_value; a shared, acyclic reference is copied twice", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(walkStrict(cyclic, LIMITS, recorder().visitors)).toEqual({ ok: false, failure: "unsupported_value" });
    const shared = { s: "v" };
    expect(walkStrict([shared, shared], LIMITS, recorder().visitors)).toEqual({
      ok: true,
      value: [{ s: "V" }, { s: "V" }],
    });
  });

  test("null-prototype objects are plain; __proto__ is copied as a data key", () => {
    const bare = Object.assign(Object.create(null), { a: "x" });
    expect(walkStrict(bare, LIMITS, recorder().visitors)).toEqual({ ok: true, value: { a: "X" } });
    const result = walkStrict(JSON.parse('{"__proto__": {"p": 1}}'), LIMITS, recorder().visitors);
    if (!result.ok) throw new Error("expected ok");
    expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
    expect(Object.keys(result.value as object)).toEqual(["__proto__"]);
  });

  test("a visitor's own exception propagates unchanged, at any depth", () => {
    const boom = new Error("visitor bug");
    const visitors: StrictWalkVisitors<never> = {
      string() {
        throw boom;
      },
      key: () => ({ ok: true }),
    };
    expect(() => walkStrict({ a: { b: ["x"] } }, LIMITS, visitors)).toThrow(boom);
  });

  test("limits must be non-negative safe integers", () => {
    for (const limits of [
      undefined,
      {},
      { maxDepth: 1 },
      { maxDepth: -1, maxNodes: 1 },
      { maxDepth: 1.5, maxNodes: 1 },
    ]) {
      expect(isStrictWalkLimits(limits)).toBe(false);
      expect(() => walkStrict("x", limits as never, recorder().visitors)).toThrow(TypeError);
    }
    expect(isStrictWalkLimits({ maxDepth: 0, maxNodes: 0 })).toBe(true);
  });
});
