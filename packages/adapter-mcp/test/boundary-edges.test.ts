/**
 * Edge cases of the MCP boundary that the everyday tests never reach: the
 * block-level key-context backstop in isolation, results without `content`,
 * throwing getters partway through a copy, unreadable signals, and the
 * one-parameter handler form. Each case pins a fail-closed branch that
 * mutation testing showed to be unprotected
 * (redact-secret/redact-secret-adapters#91). Every value is synthetic.
 */

import {
  type AiContextBoundary,
  type AiContextOutcome,
  createAiContextBoundaryWith,
  type SafeFinding,
} from "@redact-secret/adapter-ai-context";
import { describe, expect, test } from "vitest";

import { createFakeCore, LIMITS } from "../../adapter-ai-context/test/fake-core.js";
import { createMcpBoundaryWith, type McpAuditRecord, type McpBoundaryOptions, mcpBlockedResult } from "../src/index.js";

const SECRET = "SECRET_TOKEN_7";
const UNSUPPORTED = { outcome: "blocked", reason: "unsupported_value" };
const POLICY = { outcome: "blocked", reason: "policy" };

function setup(options: McpBoundaryOptions = {}) {
  const audits: McpAuditRecord[] = [];
  const ai = createAiContextBoundaryWith(createFakeCore().core, {
    ...LIMITS,
    traversalLimits: { maxDepth: 6, maxNodes: 64 },
  });
  const mcp = createMcpBoundaryWith(ai, { onAudit: (record) => audits.push(record), ...options });
  return { mcp, audits };
}

/** A property whose getter throws, as a data-shaped own enumerable property. */
function throwingGetter<T extends object>(target: T, key: string): T {
  return Object.defineProperty(target, key, {
    enumerable: true,
    get() {
      throw new Error(`getter saw ${SECRET}`);
    },
  });
}

/**
 * A stub AI-context boundary: the value pass passes everything through
 * untouched and ignores the signal, and only the backstop's text scan sees a
 * marker (`SECRET_TOKEN_7` redacts, `BLOCK_ME` blocks). Whatever it catches
 * can only come from the MCP layer itself.
 */
function stubBoundary(): { boundary: AiContextBoundary; texts: string[] } {
  const texts: string[] = [];
  const finding = (action: SafeFinding["action"]): SafeFinding =>
    Object.freeze({
      id: "finding-1",
      type: "generic_token",
      detector: "stub",
      confidence: "high",
      action,
      obfuscation: "none",
      start: 0,
      end: 1,
    });
  const ok = <T>(value: T, findings: SafeFinding[] = []): AiContextOutcome<T> =>
    Object.freeze({ outcome: "ok", value, findings: Object.freeze(findings) });
  const boundary = {
    sanitizeValue: (value: unknown) => ok(value),
    sanitizeText: (text: string) => {
      texts.push(text);
      if (text.includes("BLOCK_ME")) return ok(text, [finding("block")]);
      return ok(text, text.includes(SECRET) ? [finding("redact")] : []);
    },
    openStream: () => {
      throw new Error("not used");
    },
  } as unknown as AiContextBoundary;
  return { boundary, texts };
}

describe("the block-level key-context backstop, isolated", () => {
  test.each([
    ["a resource_link block", { type: "resource_link", uri: `https://example.test/?t=${SECRET}`, name: "link" }],
    ["a resource block", { type: "resource", resource: { uri: `file:///${SECRET}`, text: "body" } }],
    ["an image block", { type: "image", data: "AAAA", mimeType: `image/${SECRET}` }],
    ["a text block's other fields", { type: "text", text: "clean", _meta: { hint: SECRET } }],
  ])("%s is blocked as policy", (_name, block) => {
    const { boundary } = stubBoundary();
    const mcp = createMcpBoundaryWith(boundary, { binaryContent: "pass" });
    expect(mcp.sanitizeToolResult({ content: [block] })).toEqual(POLICY);
  });

  test("a result-level field is blocked as policy", () => {
    const { boundary } = stubBoundary();
    const mcp = createMcpBoundaryWith(boundary);
    expect(mcp.sanitizeToolResult({ content: [], _meta: { trace: SECRET } })).toEqual(POLICY);
  });

  test("a block finding in the backstop is blocked as policy", () => {
    const { boundary } = stubBoundary();
    const mcp = createMcpBoundaryWith(boundary);
    expect(mcp.sanitizeToolResult({ content: [{ type: "resource_link", uri: "u", name: "BLOCK_ME" }] })).toEqual(
      POLICY,
    );
  });

  test("the text the value pass already scanned is not scanned again", () => {
    const { boundary, texts } = stubBoundary();
    const mcp = createMcpBoundaryWith(boundary);
    const result = {
      content: [
        { type: "text", text: `a ${SECRET}` },
        { type: "resource", resource: { uri: "file:///synthetic", text: `b ${SECRET}` } },
      ],
    };
    expect(mcp.sanitizeToolResult(result)).toMatchObject({ outcome: "ok", value: result });
    expect(texts).toEqual(["{}", '{"type":"text"}', '{"type":"resource","resource":{"uri":"file:///synthetic"}}']);
  });

  test("a result without content is checked as one part", () => {
    const { boundary, texts } = stubBoundary();
    const mcp = createMcpBoundaryWith(boundary);
    expect(mcp.sanitizeToolResult({ isError: true })).toMatchObject({ outcome: "ok" });
    expect(texts).toEqual(['{"isError":true}']);
  });

  test("a content getter that throws is unsupported_value, never an exception", () => {
    const { boundary } = stubBoundary();
    const mcp = createMcpBoundaryWith(boundary);
    const result = throwingGetter({}, "content");
    expect(() => mcp.sanitizeToolResult(result)).not.toThrow();
    expect(mcp.sanitizeToolResult(result)).toEqual(UNSUPPORTED);
  });

  test("the same blocks without the secret pass, so the stub alone blocks nothing", () => {
    const { boundary, texts } = stubBoundary();
    const mcp = createMcpBoundaryWith(boundary, { binaryContent: "pass" });
    const result = {
      content: [
        { type: "resource_link", uri: "https://example.test/", name: "link" },
        { type: "resource", resource: { uri: "file:///synthetic", text: "body" } },
        { type: "image", data: "AAAA", mimeType: "image/png" },
      ],
    };
    expect(mcp.sanitizeToolResult(result)).toMatchObject({ outcome: "ok", value: result });
    // The backstop never sees what the value pass already scanned: the text
    // of a resource, or the binary data it detached.
    expect(texts.some((text) => text.includes("body") || text.includes("AAAA"))).toBe(false);
  });
});

describe("a result without content", () => {
  test("structuredContent alone is scanned and returned ok", () => {
    const { mcp } = setup();
    expect(mcp.sanitizeToolResult({ structuredContent: { note: `x ${SECRET}`, n: 1 } })).toMatchObject({
      outcome: "ok",
      value: { structuredContent: { note: "x <SECRET_1>", n: 1 } },
    });
  });

  test("isError alone is returned ok unchanged", () => {
    const { mcp } = setup();
    expect(mcp.sanitizeToolResult({ isError: true })).toEqual({
      outcome: "ok",
      value: { isError: true },
      findings: [],
    });
  });

  test("a block-worthy field still blocks without content", () => {
    const { mcp } = setup();
    expect(mcp.sanitizeToolResult({ structuredContent: { note: "BLOCK_ME" } })).toEqual(POLICY);
  });
});

describe("a getter that throws partway through a copy is unsupported_value, never a partial ok", () => {
  test("on a block", () => {
    const { mcp } = setup();
    const block = throwingGetter({}, "type");
    expect(() => mcp.sanitizeToolResult({ content: [{ type: "text", text: "a" }, block] })).not.toThrow();
    expect(mcp.sanitizeToolResult({ content: [{ type: "text", text: "a" }, block] })).toEqual(UNSUPPORTED);
  });

  test("on a result key after content", () => {
    const { mcp } = setup();
    const result = throwingGetter({ content: [{ type: "text", text: "a" }] }, "structuredContent");
    expect(mcp.sanitizeToolResult(result)).toEqual(UNSUPPORTED);
  });

  test("on a resources/read result key after contents", () => {
    const { mcp } = setup();
    const result = throwingGetter({ contents: [{ uri: "test://a", text: "a" }] }, "_meta");
    expect(mcp.sanitizeResourceResult(result)).toEqual(UNSUPPORTED);
  });

  test("on a resources/read entry", () => {
    const { mcp } = setup();
    const entry = throwingGetter({ uri: "test://a" }, "text");
    expect(mcp.sanitizeResourceResult({ contents: [entry] })).toEqual(UNSUPPORTED);
  });

  test("on a resources/read result a read callback returns", async () => {
    const { mcp, audits } = setup();
    const result = throwingGetter({ contents: [{ uri: "test://a", text: "a" }] }, "_meta");
    expect(await mcp.sanitizeResourceRead(() => result)).toEqual(UNSUPPORTED);
    expect(audits).toEqual([{ stage: "resource", outcome: "blocked", reason: "unsupported_value" }]);
  });
});

describe('binaryContent "pass" reads a binary field once', () => {
  /** A binary field that is a string on the first read and `later()` on every read after it. */
  function shifting<T extends object>(target: T, key: string, later: () => unknown): { value: T; reads: () => number } {
    let reads = 0;
    Object.defineProperty(target, key, {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1 ? "AAAA" : later();
      },
    });
    return { value: target, reads: () => reads };
  }
  const swapped = () => ({ text: SECRET });
  const throws = () => {
    throw new Error(`getter saw ${SECRET}`);
  };

  test.each([
    ["swaps in an unscanned object", swapped],
    ["throws", throws],
  ])("an image block whose data getter later %s passes the value it checked", (_name, later) => {
    const { mcp } = setup({ binaryContent: "pass" });
    const block = shifting({ type: "image", mimeType: "image/png" }, "data", later);
    expect(mcp.sanitizeToolResult({ content: [block.value] })).toEqual({
      outcome: "ok",
      value: { content: [{ type: "image", mimeType: "image/png", data: "AAAA" }] },
      findings: [],
    });
    expect(block.reads()).toBe(1);
  });

  test.each([
    ["swaps in an unscanned object", swapped],
    ["throws", throws],
  ])("an embedded resource whose blob getter later %s passes the value it checked", (_name, later) => {
    const { mcp } = setup({ binaryContent: "pass" });
    const resource = shifting({ uri: "file:///synthetic" }, "blob", later);
    expect(mcp.sanitizeToolResult({ content: [{ type: "resource", resource: resource.value }] })).toMatchObject({
      outcome: "ok",
      value: { content: [{ type: "resource", resource: { uri: "file:///synthetic", blob: "AAAA" } }] },
    });
    expect(resource.reads()).toBe(1);
  });

  test.each([
    ["swaps in an unscanned object", swapped],
    ["throws", throws],
  ])("a resources/read entry whose blob getter later %s passes the value it checked", (_name, later) => {
    const { mcp } = setup({ binaryContent: "pass" });
    const entry = shifting({ uri: "test://a" }, "blob", later);
    expect(mcp.sanitizeResourceResult({ contents: [entry.value] })).toMatchObject({
      outcome: "ok",
      value: { contents: [{ uri: "test://a", blob: "AAAA" }] },
    });
    expect(entry.reads()).toBe(1);
  });

  test('under "block" a binary field is refused without being read', () => {
    const { mcp } = setup();
    const block = shifting({ type: "image", mimeType: "image/png" }, "data", swapped);
    expect(mcp.sanitizeToolResult({ content: [block.value] })).toEqual(UNSUPPORTED);
    expect(block.reads()).toBe(0);
  });
});

describe("a signal that cannot be read is treated as cancelled", () => {
  const unreadable = throwingGetter({}, "aborted");

  test("a signal whose aborted getter throws", () => {
    const { mcp } = setup();
    expect(mcp.sanitizeToolResult({ content: [] }, { signal: unreadable as never })).toEqual({ outcome: "aborted" });
  });

  test("the MCP layer checks the signal itself, whatever the AI-context boundary does", async () => {
    const { boundary } = stubBoundary();
    const mcp = createMcpBoundaryWith(boundary);
    const signal = unreadable as never;
    expect(mcp.sanitizeToolResult({ content: [] }, { signal })).toEqual({ outcome: "aborted" });
    expect(mcp.sanitizeToolArguments({ q: "x" }, { signal })).toEqual({ outcome: "aborted" });
    expect(mcp.sanitizeResourceResult({ contents: [] }, { signal })).toEqual({ outcome: "aborted" });
    expect(await mcp.sanitizeToolCall(() => ({ content: [] }), { signal })).toEqual({ outcome: "aborted" });
  });

  test("a handler called with no context at all runs", async () => {
    const { boundary } = stubBoundary();
    const mcp = createMcpBoundaryWith(boundary);
    const handler = mcp.wrapToolHandler(() => ({ content: [{ type: "text", text: "ok" }] }));
    expect(await (handler as () => Promise<unknown>)()).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(await handler(null)).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  test.each([
    ["signal (v1)", throwingGetter({}, "signal")],
    ["mcpReq (v2)", throwingGetter({}, "mcpReq")],
  ])("a context whose %s getter throws", async (_name, context) => {
    const { mcp, audits } = setup();
    let called = false;
    const handler = mcp.wrapToolHandler(() => {
      called = true;
      return { content: [{ type: "text", text: "ok" }] };
    });
    expect(await handler({}, context)).toEqual(mcpBlockedResult());
    expect(called).toBe(false);
    expect(audits).toEqual([{ stage: "result", outcome: "aborted" }]);
  });
});

describe("a one-parameter handler with sanitizeArguments", () => {
  test("the context is passed through as the context, never sanitized as arguments", async () => {
    const { mcp, audits } = setup();
    const seen: unknown[] = [];
    const handler = mcp.wrapToolHandler(
      (ctx: unknown) => {
        seen.push(ctx);
        return { content: [{ type: "text", text: "ok" }] };
      },
      { sanitizeArguments: true },
    );
    const context = { requestId: "BLOCK_ME", signal: { aborted: false } };
    expect(await handler(context)).toEqual({ content: [{ type: "text", text: "ok" }] });
    expect(seen).toEqual([context]);
    expect(seen[0]).toBe(context);
    expect(audits).toEqual([{ stage: "result", outcome: "ok" }]);
  });

  test("the signal is read from the one parameter", async () => {
    const { mcp } = setup();
    let called = false;
    const handler = mcp.wrapToolHandler(
      () => {
        called = true;
        return { content: [] };
      },
      { sanitizeArguments: true },
    );
    expect(await handler({ signal: { aborted: true } })).toEqual(mcpBlockedResult());
    expect(called).toBe(false);
  });
});
