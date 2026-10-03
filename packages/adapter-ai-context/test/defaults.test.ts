/**
 * The documented default limits (redact-secret/redact-secret-adapters#46),
 * qualified against the **real installed core** — the only thing that can say
 * whether a limit set is one the core accepts.
 *
 * What is asserted: a caller who passes no limits gets a working boundary with
 * finite, documented bounds; every set can still be overridden; each bound is
 * still enforced and fails closed as `limit_exceeded`; a streamed text agrees
 * with `sanitizeText` at every chunk partition under the preset; and nothing
 * in the preset is an unbounded mode.
 *
 * Tokens are synthetic and built at runtime.
 */

import { describe, expect, test } from "vitest";

import {
  AI_CONTEXT_DEFAULT_LIMITS,
  type AiContextBoundaryOptions,
  createAiContextBoundary,
  createAiContextBoundaryWith,
  withDefaultLimits,
} from "../src/index.js";
import { createFakeCore } from "./fake-core.js";

const TOKEN = `ghp_${"SYNTHETICREVOKED"}${"0".repeat(20)}`;

describe("the preset itself", () => {
  test("every bound is a finite, positive, safe integer — there is no off switch", () => {
    const bounds = [
      ...Object.values(AI_CONTEXT_DEFAULT_LIMITS.wholeInputLimits),
      ...Object.values(AI_CONTEXT_DEFAULT_LIMITS.incrementalLimits),
      ...Object.values(AI_CONTEXT_DEFAULT_LIMITS.traversalLimits),
    ];
    expect(bounds.length).toBe(8);
    for (const bound of bounds) {
      expect(Number.isSafeInteger(bound)).toBe(true);
      expect(bound).toBeGreaterThan(0);
    }
  });

  test("it is frozen, so one caller cannot widen another's bounds", () => {
    expect(Object.isFrozen(AI_CONTEXT_DEFAULT_LIMITS)).toBe(true);
    expect(Object.isFrozen(AI_CONTEXT_DEFAULT_LIMITS.wholeInputLimits)).toBe(true);
    expect(Object.isFrozen(AI_CONTEXT_DEFAULT_LIMITS.incrementalLimits)).toBe(true);
    expect(Object.isFrozen(AI_CONTEXT_DEFAULT_LIMITS.traversalLimits)).toBe(true);
  });
});

describe("withDefaultLimits", () => {
  test("fills in every set it is not given", () => {
    expect(withDefaultLimits()).toEqual(AI_CONTEXT_DEFAULT_LIMITS);
    expect(withDefaultLimits({})).toEqual(AI_CONTEXT_DEFAULT_LIMITS);
  });

  test("a set that is given wins, and is not merged field by field", () => {
    const resolved = withDefaultLimits({ traversalLimits: { maxDepth: 2, maxNodes: 8 } });
    expect(resolved.traversalLimits).toEqual({ maxDepth: 2, maxNodes: 8 });
    expect(resolved.wholeInputLimits).toBe(AI_CONTEXT_DEFAULT_LIMITS.wholeInputLimits);
  });

  test("everything that is not a limit set passes through untouched", () => {
    const onFinding = () => {};
    const resolved = withDefaultLimits({ onFinding, policy: undefined });
    expect(resolved.onFinding).toBe(onFinding);
  });

  test("a fully explicit options object is returned with its own limits, unchanged", () => {
    const explicit: AiContextBoundaryOptions = {
      wholeInputLimits: { maxInputBytes: 1024, maxFindings: 4 },
      incrementalLimits: {
        maxInputCodeUnits: 2048,
        maxBufferedCodeUnits: 512,
        maxTokenCodeUnits: 128,
        maxMultilineCodeUnits: 256,
      },
      traversalLimits: { maxDepth: 3, maxNodes: 16 },
    };
    expect(withDefaultLimits(explicit)).toEqual(explicit);
  });

  test("options that are not an object are a TypeError, as before", () => {
    expect(() => withDefaultLimits(null as unknown as undefined)).toThrow(TypeError);
  });

  test("an option reaching options through a prototype is kept, not silently dropped", () => {
    // `createAiContextBoundaryWith` destructures `options`, which follows the
    // prototype chain, so an options object layered over a shared base kept
    // its `policy` before this helper existed. A plain spread would drop it
    // and the boundary would quietly run on the core's default policy.
    const policy = (() => "redact") as unknown as AiContextBoundaryOptions["policy"];
    const onFinding = () => {};
    const layered = Object.create({ policy, onFinding }) as AiContextBoundaryOptions;
    const resolved = withDefaultLimits(layered);

    expect(resolved.policy).toBe(policy);
    expect(resolved.onFinding).toBe(onFinding);
    expect(resolved.traversalLimits).toBe(AI_CONTEXT_DEFAULT_LIMITS.traversalLimits);
  });

  test("an inherited limit set is used, rather than overwritten by the preset", () => {
    const traversalLimits = { maxDepth: 2, maxNodes: 8 };
    const layered = Object.create({ traversalLimits }) as AiContextBoundaryOptions;
    expect(withDefaultLimits(layered).traversalLimits).toBe(traversalLimits);
  });

  test("an option this helper does not know about is forwarded rather than dropped", () => {
    // Forward compatibility: a key the boundary adds later must survive.
    const resolved = withDefaultLimits({ future: "kept" } as unknown as AiContextBoundaryOptions);
    expect((resolved as unknown as Record<string, unknown>).future).toBe("kept");
  });

  test("a limit key that is present but undefined is left undefined, so it still fails loudly", () => {
    // `traversalLimits: config.limits` with a missing `config` is a caller's
    // bug. Turning it into the preset would hide it, so the key is kept and
    // the boundary's own validation rejects it, exactly as before.
    const resolved = withDefaultLimits({ traversalLimits: undefined });
    expect("traversalLimits" in resolved).toBe(true);
    expect(resolved.traversalLimits).toBeUndefined();
    expect(() => createAiContextBoundaryWith(createFakeCore().core, resolved)).toThrow(TypeError);
  });
});

describe("the strict injected API is unchanged", () => {
  test("createAiContextBoundaryWith still requires all three sets", () => {
    expect(() => createAiContextBoundaryWith(createFakeCore().core, {} as AiContextBoundaryOptions)).toThrow(TypeError);
  });

  test("and takes the preset when a caller asks for it explicitly", () => {
    const boundary = createAiContextBoundaryWith(createFakeCore().core, withDefaultLimits());
    expect(boundary.sanitizeText("ordinary text")).toEqual({ outcome: "ok", value: "ordinary text", findings: [] });
  });
});

describe("the real core accepts the preset", () => {
  test("a boundary with no options at all sanitizes and reports ok", async () => {
    const boundary = await createAiContextBoundary();
    const outcome = boundary.sanitizeText(`deploy with API_KEY=${TOKEN}`, { boundary: "user-input" });

    expect(outcome.outcome).toBe("ok");
    if (outcome.outcome !== "ok") return;
    expect(outcome.value).not.toContain(TOKEN);
    expect(outcome.value).toMatch(/^deploy with API_KEY=<SECRET_\d+>$/);
    expect(outcome.findings.length).toBeGreaterThan(0);
  });

  test("buildContext and sanitizeValue work under the preset's traversal bounds", async () => {
    const boundary = await createAiContextBoundary();
    const context = boundary.buildContext([
      { role: "user", boundary: "user-input", text: `token ${TOKEN}` },
      { role: "tool", boundary: "tool-result", value: { nested: { deeper: [`token ${TOKEN}`] } } },
    ]);

    expect(context.outcome).toBe("ok");
    expect(JSON.stringify(context)).not.toContain(TOKEN);
  });

  test("a streamed text agrees with sanitizeText at every chunk partition", async () => {
    const boundary = await createAiContextBoundary();
    const text = `prefix API_KEY=${TOKEN} suffix`;
    const whole = boundary.sanitizeText(text);
    expect(whole.outcome).toBe("ok");

    for (let split = 0; split <= text.length; split++) {
      const stream = boundary.openStream();
      stream.append(text.slice(0, split));
      stream.append(text.slice(split));
      const staged = stream.finalize();
      expect(staged).toEqual(whole);
    }
  });

  test("each preset bound is still enforced and fails closed", async () => {
    const boundary = await createAiContextBoundary();

    // Whole input, one byte over.
    const tooLong = "a".repeat(AI_CONTEXT_DEFAULT_LIMITS.wholeInputLimits.maxInputBytes + 1);
    expect(boundary.sanitizeText(tooLong)).toEqual({
      outcome: "blocked",
      reason: "limit_exceeded",
      code: "INPUT_LIMIT_EXCEEDED",
    });

    // Traversal depth: the root counts as 1.
    let deep: unknown = "leaf";
    for (let level = 0; level < AI_CONTEXT_DEFAULT_LIMITS.traversalLimits.maxDepth + 1; level++) {
      deep = { nested: deep };
    }
    expect(boundary.sanitizeValue(deep)).toEqual({ outcome: "blocked", reason: "limit_exceeded" });

    // Traversal nodes.
    const wide = Array.from({ length: AI_CONTEXT_DEFAULT_LIMITS.traversalLimits.maxNodes + 2 }, () => "x");
    expect(boundary.sanitizeValue(wide)).toEqual({ outcome: "blocked", reason: "limit_exceeded" });

    // An incremental session, past its total.
    const stream = boundary.openStream();
    // Core beta.13 types the incremental total as either `maxInputBytes` or the deprecated
    // `maxInputCodeUnits`, so neither is statically present; the defaults set the latter.
    const { incrementalLimits } = AI_CONTEXT_DEFAULT_LIMITS;
    const total = incrementalLimits.maxInputCodeUnits ?? incrementalLimits.maxInputBytes;
    expect(total).toBe(1_048_576);
    const buffered = incrementalLimits.maxBufferedCodeUnits ?? incrementalLimits.maxBufferedBytes ?? 0;
    const chunk = "b".repeat(buffered);
    const chunks = Math.ceil((total ?? 0) / chunk.length) + 1;
    for (let index = 0; index < chunks && stream.accepting; index++) stream.append(chunk);
    const staged = stream.finalize();
    expect(staged.outcome).toBe("blocked");
    if (staged.outcome === "blocked") expect(staged.reason).toBe("limit_exceeded");
  });

  test("an explicit override replaces the preset, not merges with it", async () => {
    const boundary = await createAiContextBoundary({ wholeInputLimits: { maxInputBytes: 16, maxFindings: 2 } });
    // 17 bytes: under the preset, over the override.
    expect(boundary.sanitizeText("a".repeat(17))).toEqual({
      outcome: "blocked",
      reason: "limit_exceeded",
      code: "INPUT_LIMIT_EXCEEDED",
    });
    // The traversal set was not given, so it is still the preset's, and a
    // short value still passes. Note the interaction the package README
    // documents: `sanitizeValue` also scans a leaf inside its key-context view
    // `{"<key>":"<leaf>"}`, so a leaf's usable budget is `maxInputBytes` minus
    // that key and its JSON punctuation — with a tiny override, that is what
    // binds first.
    expect(boundary.sanitizeValue({ a: "ok" })).toEqual({
      outcome: "ok",
      value: { a: "ok" },
      findings: [],
    });
    expect(boundary.sanitizeValue({ a: "ordinary text" })).toEqual({
      outcome: "blocked",
      reason: "limit_exceeded",
      code: "INPUT_LIMIT_EXCEEDED",
    });
  });

  test("an unsupported value and an aborted signal still fail closed under the preset", async () => {
    const boundary = await createAiContextBoundary();
    expect(boundary.sanitizeValue(new Date())).toEqual({ outcome: "blocked", reason: "unsupported_value" });
    expect(boundary.sanitizeText("x", { signal: { aborted: true } })).toEqual({ outcome: "aborted" });
  });
});
