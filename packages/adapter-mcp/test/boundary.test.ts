/**
 * The MCP boundary over an AI-context boundary on a fake core
 * (`adapter-ai-context/test/fake-core.ts`: `BLOCK_ME` blocks,
 * `SECRET_TOKEN_\d+` redacts, `BOOM` throws with a message carrying input).
 * The fixture replay (`conformance*.test.ts`) and the SDK tests
 * (`transport.test.ts`, `e2e.test.ts`) run the same code on the real core.
 * Every value is synthetic.
 */

import { type AiContextBoundaryOptions, createAiContextBoundaryWith } from "@redact-secret/adapter-ai-context";
import { describe, expect, test } from "vitest";

import { createFakeCore, LIMITS } from "../../adapter-ai-context/test/fake-core.js";
import {
  createMcpBoundaryWith,
  MCP_AUDIT_FIELDS,
  MCP_BLOCKED_TEXT,
  MCP_TOOL_ERROR_TEXT,
  type McpAuditRecord,
  type McpBoundaryOptions,
  mcpAuditRecord,
  mcpBlockedResult,
  mcpToolErrorResult,
  toCallToolResult,
} from "../src/index.js";

const SECRET = "SECRET_TOKEN_7";
const MARKERS = [SECRET, "BLOCK_ME", "BOOM", "fake core failure", "near", "tool failure"];

function setup(options: McpBoundaryOptions = {}, ai: Partial<AiContextBoundaryOptions> = {}, fake = createFakeCore()) {
  const events: { finding: object; context: { boundary: string } }[] = [];
  const audits: McpAuditRecord[] = [];
  const aiBoundary = createAiContextBoundaryWith(fake.core, {
    ...LIMITS,
    traversalLimits: { maxDepth: 6, maxNodes: 64 },
    onFinding: (finding, context) => events.push({ finding, context }),
    ...ai,
  });
  const mcp = createMcpBoundaryWith(aiBoundary, { onAudit: (record) => audits.push(record), ...options });
  return { mcp, events, audits, calls: fake.calls };
}

function expectInputFree(...values: unknown[]): void {
  const text = JSON.stringify(values);
  for (const marker of MARKERS) expect(text.includes(marker), marker).toBe(false);
}

describe("sanitizeToolResult", () => {
  test("scans the whole result as one value: text, structuredContent, _meta, annotations, unknown fields", () => {
    const { mcp, events, audits } = setup();
    const outcome = mcp.sanitizeToolResult({
      content: [
        { type: "text", text: `log ${SECRET}`, annotations: { audience: ["user"] }, _meta: { hint: `m ${SECRET}` } },
        { type: "resource_link", uri: `https://example.test/?t=${SECRET}`, name: "link" },
        { type: "resource", resource: { uri: "file:///synthetic", text: `body ${SECRET}` } },
      ],
      structuredContent: { nested: { deeper: [`s ${SECRET}`] } },
      _meta: { trace: `t ${SECRET}` },
      futureField: `f ${SECRET}`,
      isError: false,
    });
    expect(outcome.outcome).toBe("ok");
    expectInputFree(outcome);
    expect(new Set(events.map((e) => e.context.boundary))).toEqual(new Set(["tool-result"]));
    expect(audits).toEqual([{ stage: "result", outcome: "ok" }]);
  });

  test("text is scanned as text: JSON in a text block is never parsed", () => {
    const { mcp, calls } = setup();
    const text = JSON.stringify({ note: `x ${SECRET}` });
    mcp.sanitizeToolResult({ content: [{ type: "text", text }] });
    expect(calls.scans).toContain(text);
  });

  test("binary payloads block by default; on opt-in a string payload passes unscanned at its original key position", () => {
    const image = { type: "image", data: "U1lOVEhFVElD", mimeType: "image/png" };
    const blob = { type: "resource", resource: { uri: "file:///b", blob: "U1lOVEhFVElD", mimeType: "x/y" } };
    for (const block of [image, { ...image, type: "audio" }, blob]) {
      expect(setup().mcp.sanitizeToolResult({ content: [block] })).toEqual({
        outcome: "blocked",
        reason: "unsupported_value",
      });
    }
    const { mcp, calls } = setup({ binaryContent: "pass" });
    const outcome = mcp.sanitizeToolResult({ content: [image, blob] });
    expect(outcome.outcome).toBe("ok");
    const value = (outcome as unknown as { value: { content: Record<string, unknown>[] } }).value;
    expect(Object.keys(value.content[0] ?? {})).toEqual(["type", "data", "mimeType"]);
    expect(value.content[0]?.data).toBe("U1lOVEhFVElD");
    expect((value.content[1]?.resource as Record<string, unknown> | undefined)?.blob).toBe("U1lOVEhFVElD");
    expect(calls.scans).not.toContain("U1lOVEhFVElD");
    expect(mcp.sanitizeToolResult({ content: [{ ...image, data: 42 }] })).toEqual({
      outcome: "blocked",
      reason: "unsupported_value",
    });
  });

  test.each([
    ["an unknown block type", { content: [{ type: "video", text: "x" }] }],
    ["a non-object block", { content: ["text"] }],
    ["a non-array content", { content: { type: "text", text: "x" } }],
    ["a non-object result", "text"],
    ["an array result", [{ type: "text", text: "x" }]],
    ["a resource without an object resource", { content: [{ type: "resource", resource: "x" }] }],
    ["a class instance result", new (class Result {})()],
  ])("%s is blocked as unsupported_value", (_name, result) => {
    const { mcp, audits } = setup();
    expect(mcp.sanitizeToolResult(result)).toEqual({ outcome: "blocked", reason: "unsupported_value" });
    expect(audits).toEqual([{ stage: "result", outcome: "blocked", reason: "unsupported_value" }]);
  });

  /**
   * A core that, like the real one, flags a value only through the context
   * around it: `"password":"<v>"` (its own key) and
   * `"provider":"fake","value":"<v>"` (a sibling key), with exact offsets.
   */
  function contextualCore() {
    const fake = createFakeCore();
    const scan = fake.core.scanAndRedact;
    const scans: string[] = [];
    const patterns = [/"password":"([^"<]+)"/, /"provider":"fake","value":"([^"<]+)"/];
    const core = {
      ...fake.core,
      scanAndRedact: (text: string, options?: Parameters<typeof scan>[1]) => {
        scans.push(text);
        for (const pattern of patterns) {
          const match = pattern.exec(text);
          if (match?.[1] === undefined) continue;
          const start = match.index + match[0].length - 1 - match[1].length;
          const end = start + match[1].length;
          return {
            text: `${text.slice(0, start)}<SECRET_1>${text.slice(end)}`,
            findings: [
              {
                id: "finding-1",
                type: "password",
                detector: "fake",
                confidence: "high",
                action: "redact",
                obfuscation: "none",
                start,
                end,
              },
            ],
          };
        }
        return scan(text, options);
      },
    } as typeof fake.core;
    return { core, calls: fake.calls, scans };
  }

  test("a value only its own key identifies is redacted at its leaf, not blocked (redact-secret/redact-secret#842)", () => {
    const fake = contextualCore();
    const { mcp } = setup({}, {}, fake);
    const structured = { content: [], structuredContent: { user: "deploy-bot", password: "synthetic-not-a-secret" } };
    const outcome = mcp.sanitizeToolResult(structured);
    expect(outcome).toMatchObject({
      outcome: "ok",
      value: { content: [], structuredContent: { user: "deploy-bot", password: "<SECRET_1>" } },
    });
    expect(outcome.outcome === "ok" && outcome.findings.map(({ start, end }) => [start, end])).toEqual([[0, 22]]);
    expect(fake.scans).toContain('{"password":"synthetic-not-a-secret"}');
    // The backstop still ran over the sanitized result and found nothing.
    expect(fake.scans).toContain(JSON.stringify({ structuredContent: { user: "deploy-bot", password: "<SECRET_1>" } }));
    expect(mcp.sanitizeToolArguments({ password: "synthetic-not-a-secret" })).toMatchObject({
      outcome: "ok",
      value: { password: "<SECRET_1>" },
    });
  });

  test("the key-context backstop still blocks what only the serialized structure reveals", () => {
    const fake = contextualCore();
    const { mcp } = setup({}, {}, fake);
    // Only a sibling key identifies the value: no leaf pass can see it.
    const structuredContent = { provider: "fake", value: "synthetic-not-a-secret" };
    expect(mcp.sanitizeToolResult({ content: [], structuredContent })).toEqual({
      outcome: "blocked",
      reason: "policy",
    });
    expect(fake.scans).toContain(JSON.stringify({ structuredContent }));
    expect(mcp.sanitizeToolArguments(structuredContent)).toEqual({ outcome: "blocked", reason: "policy" });
    // A text block's own text already carried its context and is not rescanned as structure.
    expect(mcp.sanitizeToolResult({ content: [{ type: "text", text: "ordinary" }] }).outcome).toBe("ok");
  });

  test("a core failure, a block finding and an aborted signal all map to fixed, input-free outcomes", () => {
    const { mcp } = setup();
    const failed = mcp.sanitizeToolResult({ content: [{ type: "text", text: `BOOM ${SECRET}` }] });
    expect(failed).toEqual({ outcome: "blocked", reason: "core_error", code: "DETECTOR_FAILURE" });
    expect(mcp.sanitizeToolResult({ content: [{ type: "text", text: "BLOCK_ME" }] })).toEqual({
      outcome: "blocked",
      reason: "policy",
    });
    expect(mcp.sanitizeToolResult({ content: [] }, { signal: { aborted: true } })).toEqual({ outcome: "aborted" });
    expectInputFree(failed, toCallToolResult(failed));
  });

  test("a throwing getter on the result or a block fails closed", () => {
    const { mcp } = setup();
    const result = {
      get content(): never {
        throw new Error(`getter ${SECRET}`);
      },
    };
    expect(mcp.sanitizeToolResult(result)).toEqual({ outcome: "blocked", reason: "unsupported_value" });
    const block = {
      type: "text",
      get text(): never {
        throw new Error(`getter ${SECRET}`);
      },
    };
    expect(mcp.sanitizeToolResult({ content: [block] })).toMatchObject({ outcome: "blocked" });
  });
});

describe("sanitizeToolArguments", () => {
  test("labelled tool-arguments; absent is ok with no value; non-objects are unsupported", () => {
    const { mcp, events, audits } = setup();
    expect(mcp.sanitizeToolArguments({ query: `q ${SECRET}` })).toMatchObject({
      outcome: "ok",
      value: { query: "q <SECRET_1>" },
    });
    expect(events.map((e) => e.context.boundary)).toEqual(["tool-arguments"]);
    expect(mcp.sanitizeToolArguments(undefined)).toEqual({ outcome: "ok", value: undefined, findings: [] });
    for (const args of [null, "x", ["a"], 1]) {
      expect(mcp.sanitizeToolArguments(args)).toEqual({ outcome: "blocked", reason: "unsupported_value" });
    }
    expect(audits.map((a) => a.stage)).toEqual(Array(6).fill("arguments"));
  });
});

describe("sanitizeToolCall", () => {
  test("a throw or rejection is tool_error; the error, including a message getter, is never read", async () => {
    const { mcp } = setup();
    let read = 0;
    const error = {
      get message() {
        read += 1;
        return `tool failure ${SECRET}`;
      },
      get code() {
        read += 1;
        return "DETECTOR_FAILURE";
      },
    };
    expect(
      await mcp.sanitizeToolCall(() => {
        throw error;
      }),
    ).toEqual({ outcome: "tool_error" });
    expect(await mcp.sanitizeToolCall(() => Promise.reject(error))).toEqual({ outcome: "tool_error" });
    expect(read).toBe(0);
  });

  test("a rejection after the signal fired is aborted, and a result that arrives after it is discarded", async () => {
    const { mcp } = setup();
    const controller = new AbortController();
    const rejected = mcp.sanitizeToolCall(
      async () => {
        controller.abort();
        throw new Error("cancelled");
      },
      { signal: controller.signal },
    );
    expect(await rejected).toEqual({ outcome: "aborted" });
    const late = new AbortController();
    const resolved = await mcp.sanitizeToolCall(
      async () => {
        late.abort();
        return { content: [{ type: "text", text: SECRET }] };
      },
      { signal: late.signal },
    );
    expect(resolved).toEqual({ outcome: "aborted" });
    expect(toCallToolResult(resolved)).toBeNull();
  });

  test("with arguments: sanitized first; blocked arguments never invoke the tool; invoke gets only the sanitized copy", async () => {
    const { mcp, audits } = setup();
    let invoked = 0;
    const blocked = await mcp.sanitizeToolCall(
      () => {
        invoked += 1;
        return { content: [] };
      },
      { arguments: { q: "BLOCK_ME" } },
    );
    expect(blocked).toEqual({ outcome: "blocked", reason: "policy" });
    expect(invoked).toBe(0);
    expect(audits).toEqual([{ stage: "arguments", outcome: "blocked", reason: "policy" }]);

    const seen: unknown[] = [];
    const original = { q: `a ${SECRET}` };
    await mcp.sanitizeToolCall(
      ({ arguments: args }) => {
        seen.push(args);
        return { content: [] };
      },
      { arguments: original },
    );
    expect(seen).toEqual([{ q: "a <SECRET_1>" }]);
    expect(seen[0]).not.toBe(original);
    expect(audits.slice(1)).toEqual([
      { stage: "arguments", outcome: "ok" },
      { stage: "result", outcome: "ok" },
    ]);
  });
});

function producer(chunks: string[], { failAt, async = true }: { failAt?: number; async?: boolean } = {}) {
  const state = { pulled: 0, closed: false };
  let index = 0;
  const next = () => {
    if (failAt === index) throw new Error(`producer failure ${SECRET}`);
    if (index >= chunks.length) return { done: true, value: undefined };
    state.pulled += 1;
    return { done: false, value: chunks[index++] };
  };
  const iterator = {
    next: async ? () => Promise.resolve().then(next) : next,
    return() {
      state.closed = true;
      return { done: true, value: undefined };
    },
  };
  const iterable = async ? { [Symbol.asyncIterator]: () => iterator } : { [Symbol.iterator]: () => iterator };
  return { iterable, state };
}

describe("sanitizeStreamedToolResult", () => {
  test("a secret split across async chunks is redacted and released once as one text block", async () => {
    const { mcp } = setup();
    const { iterable, state } = producer(["stdout: SECRET_", "TOKEN_7 done"]);
    const outcome = await mcp.sanitizeStreamedToolResult(iterable);
    expect(outcome).toMatchObject({
      outcome: "ok",
      value: { content: [{ type: "text", text: "stdout: <SECRET_1> done" }] },
    });
    expect(state).toEqual({ pulled: 2, closed: false });
  });

  test("an early failure stops pulling at once and closes the producer", async () => {
    const fake = createFakeCore({ emitOnAppend: true, appendFailures: { OVER: "BUFFER_LIMIT_EXCEEDED" } });
    for (const [chunk, expected] of [
      ["BLOCK_ME", { outcome: "blocked", reason: "policy" }],
      ["OVER", { outcome: "blocked", reason: "limit_exceeded", code: "BUFFER_LIMIT_EXCEEDED" }],
    ] as const) {
      const { mcp } = setup({}, {}, fake);
      const { iterable, state } = producer(["clean ", chunk, `late ${SECRET}`, "never"]);
      expect(await mcp.sanitizeStreamedToolResult(iterable)).toEqual(expected);
      expect(state).toEqual({ pulled: 2, closed: true });
    }
  });

  test("a producer failure is tool_error, never read", async () => {
    const { mcp } = setup();
    const { iterable } = producer(["a", "b"], { failAt: 1, async: false });
    const outcome = await mcp.sanitizeStreamedToolResult(iterable);
    expect(outcome).toEqual({ outcome: "tool_error" });
    expectInputFree(outcome);
  });

  test("a real AbortSignal ends a producer that is still pending, closes it, and delivers nothing", async () => {
    const { mcp } = setup();
    const controller = new AbortController();
    const state = { closed: false, pulled: 0 };
    const iterable = {
      [Symbol.asyncIterator]: () => ({
        next: () => {
          state.pulled += 1;
          return state.pulled === 1 ? Promise.resolve({ done: false, value: `a ${SECRET}` }) : new Promise(() => {});
        },
        return: () => {
          state.closed = true;
          return Promise.resolve({ done: true });
        },
      }),
    };
    const pending = mcp.sanitizeStreamedToolResult(iterable, { signal: controller.signal });
    await new Promise((resolve) => setTimeout(resolve, 5));
    controller.abort();
    const outcome = await pending;
    expect(outcome).toEqual({ outcome: "aborted" });
    expect(toCallToolResult(outcome)).toBeNull();
    expect(state).toEqual({ closed: true, pulled: 2 });
  });

  test("a non-iterable is unsupported and a non-string chunk blocks and closes the producer", async () => {
    const { mcp } = setup();
    expect(await mcp.sanitizeStreamedToolResult(42)).toEqual({ outcome: "blocked", reason: "unsupported_value" });
    const { iterable, state } = producer([7 as unknown as string, "later"]);
    expect(await mcp.sanitizeStreamedToolResult(iterable)).toEqual({ outcome: "blocked", reason: "unsupported_value" });
    expect(state.closed).toBe(true);
  });
});

describe("server handler wrappers", () => {
  test("read the signal from v1 extra.signal and v2 ctx.mcpReq.signal", async () => {
    const { mcp } = setup();
    const handler = mcp.wrapToolHandler(() => ({ content: [{ type: "text", text: "ok" }] }));
    const aborted = { aborted: true };
    // A cancelled request gets the blocked result, which the SDK never sends.
    expect(await handler({}, { signal: aborted })).toEqual(mcpBlockedResult());
    expect(await handler({}, { mcpReq: { signal: aborted } })).toEqual(mcpBlockedResult());
    expect(await handler({ signal: { aborted: false } })).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  test("the (args, ctx) and (ctx) forms both work; arguments are sanitized only on opt-in", async () => {
    const { mcp } = setup();
    const seen: unknown[] = [];
    const plain = mcp.wrapToolHandler((args: unknown) => {
      seen.push(args);
      return { content: [] };
    });
    const sanitizing = mcp.wrapToolHandler(
      (args: unknown) => {
        seen.push(args);
        return { content: [] };
      },
      { sanitizeArguments: true },
    );
    await plain({ q: SECRET }, {});
    await sanitizing({ q: SECRET }, {});
    expect(seen).toEqual([{ q: SECRET }, { q: "<SECRET_1>" }]);
    expect(await sanitizing({ q: "BLOCK_ME" }, {})).toEqual(mcpBlockedResult());
    expect(seen).toHaveLength(2);
    const contextOnly = mcp.wrapToolHandler((ctx: unknown) => ({ content: [{ type: "text", text: typeof ctx }] }));
    expect(await contextOnly({})).toEqual({ content: [{ type: "text", text: "object" }] });
  });

  test("a throwing handler becomes the fixed tool-error result; a sanitized result keeps its shape", async () => {
    const { mcp } = setup();
    const throwing = mcp.wrapToolHandler(() => {
      throw new Error(`tool failure ${SECRET}`);
    });
    const result = await throwing({});
    expect(result).toEqual(mcpToolErrorResult());
    expectInputFree(result);
    const sanitized = mcp.wrapToolHandler(() => ({ content: [{ type: "text", text: `x ${SECRET}` }], isError: true }));
    expect(await sanitized({})).toEqual({ content: [{ type: "text", text: "x <SECRET_1>" }], isError: true });
  });

  test("wrapStreamedToolHandler releases one text block, or a fixed result", async () => {
    const { mcp } = setup();
    const ok = mcp.wrapStreamedToolHandler(() => producer(["a SECRET_", "TOKEN_7"]).iterable);
    expect(await ok({}, {})).toEqual({ content: [{ type: "text", text: "a <SECRET_1>" }] });
    const blocked = mcp.wrapStreamedToolHandler(async () => producer(["BLOCK_ME"]).iterable);
    expect(await blocked({}, {})).toEqual(mcpBlockedResult());
    const failing = mcp.wrapStreamedToolHandler(() => Promise.reject(new Error(SECRET)));
    expect(await failing({}, {})).toEqual(mcpToolErrorResult());
  });
});

describe("fixed results, audit, and telemetry", () => {
  test("fixed results are exact, fresh objects with no structuredContent or _meta", () => {
    const a = mcpBlockedResult();
    expect(a).toEqual({ content: [{ type: "text", text: MCP_BLOCKED_TEXT }], isError: true });
    expect(mcpBlockedResult()).not.toBe(a);
    expect(mcpBlockedResult().content).not.toBe(a.content);
    expect(mcpToolErrorResult()).toEqual({ content: [{ type: "text", text: MCP_TOOL_ERROR_TEXT }], isError: true });
    for (const reason of ["policy", "limit_exceeded", "unsupported_value", "lifecycle", "core_error"] as const) {
      expect(toCallToolResult({ outcome: "blocked", reason })).toEqual(a);
    }
    expect(toCallToolResult({ outcome: "tool_error" })).toEqual(mcpToolErrorResult());
    expect(toCallToolResult({ outcome: "aborted" })).toBeNull();
    expect(() => toCallToolResult({ outcome: "other" } as never)).toThrow(TypeError);
  });

  test("audit records carry only stage, outcome, reason and code", () => {
    expect(
      mcpAuditRecord({ outcome: "blocked", reason: "limit_exceeded", code: "INPUT_LIMIT_EXCEEDED" }, "result"),
    ).toEqual({
      stage: "result",
      outcome: "blocked",
      reason: "limit_exceeded",
      code: "INPUT_LIMIT_EXCEEDED",
    });
    const okRecord = mcpAuditRecord({ outcome: "ok", value: { secret: SECRET }, findings: [] }, "arguments");
    expect(okRecord).toEqual({ stage: "arguments", outcome: "ok" });
    expect(Object.isFrozen(okRecord)).toBe(true);
    for (const key of Object.keys(okRecord)) expect(MCP_AUDIT_FIELDS).toContain(key);
    expect(() => mcpAuditRecord({ outcome: "ok", value: 1, findings: [] }, "x" as never)).toThrow(TypeError);
  });

  test("a throwing onAudit or onFinding callback never changes an outcome and is never read", async () => {
    const fake = createFakeCore();
    const aiBoundary = createAiContextBoundaryWith(fake.core, {
      ...LIMITS,
      onFinding() {
        throw new Error(`finding ${SECRET}`);
      },
    });
    const mcp = createMcpBoundaryWith(aiBoundary, {
      onAudit() {
        throw new Error(`audit ${SECRET}`);
      },
    });
    expect(mcp.sanitizeToolResult({ content: [{ type: "text", text: `a ${SECRET}` }] })).toMatchObject({
      outcome: "ok",
      value: { content: [{ type: "text", text: "a <SECRET_1>" }] },
    });
    expect(await mcp.sanitizeStreamedToolResult(["b ", SECRET])).toMatchObject({ outcome: "ok" });
  });
});

describe("options", () => {
  const aiBoundary = createAiContextBoundaryWith(createFakeCore().core, LIMITS);
  test.each([
    ["no boundary", undefined, {}],
    ["a boundary without operations", {}, {}],
    ["an unknown binaryContent", aiBoundary, { binaryContent: "scan" }],
    ["a non-function onAudit", aiBoundary, { onAudit: "log" }],
    ["non-object options", aiBoundary, null],
  ])("%s throws a TypeError with a fixed message", (_name, boundary, options) => {
    expect(() => createMcpBoundaryWith(boundary as never, options as never)).toThrow(TypeError);
  });

  test("the returned boundary is frozen", () => {
    expect(Object.isFrozen(createMcpBoundaryWith(aiBoundary))).toBe(true);
  });
});
