/**
 * Cases that kill the mutants still surviving in `boundary.ts` after #95, #91
 * and #92 (redact-secret/redact-secret-adapters#147): construction guards,
 * the abort listener of a streamed step, `iteratorOf`, rejected blocks and
 * entries, the key-context cache, audit stages, and fixed messages. The
 * AI-context boundary is a stub whose value pass is the identity, so whatever
 * a case sees comes from the MCP layer. Every value is synthetic.
 */

import type { AiContextBoundary, AiContextOutcome, SafeFinding } from "@redact-secret/adapter-ai-context";
import { describe, expect, test } from "vitest";

import {
  createMcpBoundaryWith,
  MCP_RESOURCE_BLOCKED_MESSAGE,
  type McpAuditRecord,
  McpResourceError,
  mcpAuditRecord,
  mcpResourceBlockedError,
  toCallToolResult,
  toReadResourceResponse,
} from "../src/index.js";

const SECRET = "SECRET_TOKEN_7";
const UNSUPPORTED = { outcome: "blocked", reason: "unsupported_value" };
const TOOL_ERROR = { outcome: "tool_error" };
const ABORTED = { outcome: "aborted" };

type StubOptions = {
  sanitizeText?: (text: string) => AiContextOutcome<string>;
  openStream?: AiContextBoundary["openStream"];
};

const okOutcome = <T>(value: T, findings: SafeFinding[] = []): AiContextOutcome<T> =>
  Object.freeze({ outcome: "ok", value, findings: Object.freeze(findings) });

function finding(action: SafeFinding["action"]): SafeFinding {
  return Object.freeze({
    id: "finding-1",
    type: "generic_token",
    detector: "stub",
    confidence: "high",
    action,
    obfuscation: "none",
    start: 0,
    end: 1,
  });
}

/** An AI-context stub: the value pass is the identity, the text pass reports nothing. */
function stub(options: StubOptions = {}): { boundary: AiContextBoundary; texts: string[] } {
  const texts: string[] = [];
  const boundary = {
    sanitizeValue: (value: unknown) => okOutcome(value),
    sanitizeText: (text: string) => {
      texts.push(text);
      return options.sanitizeText ? options.sanitizeText(text) : okOutcome(text);
    },
    openStream:
      options.openStream ??
      (() => {
        throw new Error("not used");
      }),
  } as unknown as AiContextBoundary;
  return { boundary, texts };
}

function caught(run: () => unknown): unknown {
  try {
    run();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectTypeError(run: () => unknown, message: string): void {
  const error = caught(run);
  expect(error).toBeInstanceOf(TypeError);
  expect((error as TypeError).message).toBe(message);
}

describe("createMcpBoundaryWith rejects what is not an AI-context boundary", () => {
  const message = "createMcpBoundaryWith: an AI-context boundary is required";
  const valid = () => stub().boundary;

  test.each([
    ["null", null],
    ["a string", "x"],
    ["an empty object", {}],
    ["a function", () => undefined],
  ])("%s", (_name, boundary) => {
    expectTypeError(() => createMcpBoundaryWith(boundary as never), message);
  });

  test.each(["sanitizeValue", "sanitizeText", "openStream"])("an object missing %s", (method) => {
    const boundary = { ...valid() } as Record<string, unknown>;
    delete boundary[method];
    expectTypeError(() => createMcpBoundaryWith(boundary as never), message);
    boundary[method] = "not a function";
    expectTypeError(() => createMcpBoundaryWith(boundary as never), message);
  });
});

describe("createMcpBoundaryWith rejects malformed options", () => {
  test.each([
    ["null", null],
    ["a string", "pass"],
  ])("options of %s", (_name, options) => {
    expectTypeError(
      () => createMcpBoundaryWith(stub().boundary, options as never),
      "createMcpBoundaryWith: options must be an object",
    );
  });

  test("an unknown binaryContent", () => {
    expectTypeError(
      () => createMcpBoundaryWith(stub().boundary, { binaryContent: "allow" as never }),
      'createMcpBoundaryWith: binaryContent must be "block" or "pass"',
    );
  });

  test("a non-function onAudit", () => {
    expectTypeError(
      () => createMcpBoundaryWith(stub().boundary, { onAudit: 1 as never }),
      "createMcpBoundaryWith: onAudit must be a function",
    );
  });
});

type Listener = (...args: unknown[]) => void;

function countingSignal({ removeThrows = false }: { removeThrows?: boolean } = {}) {
  const added: { type: unknown; listener: Listener }[] = [];
  const removed: { type: unknown; listener: Listener }[] = [];
  const signal = {
    aborted: false,
    addEventListener: (type: unknown, listener: Listener) => {
      added.push({ type, listener });
    },
    removeEventListener: (type: unknown, listener: Listener) => {
      removed.push({ type, listener });
      if (removeThrows) throw new Error(`remove saw ${SECRET}`);
    },
  };
  return { signal, added, removed };
}

function acceptingStream(record: { aborted: number } = { aborted: 0 }) {
  const chunks: string[] = [];
  const openStream = () => ({
    accepting: true,
    append: (chunk: string) => {
      chunks.push(chunk);
    },
    abort: () => {
      record.aborted += 1;
    },
    finalize: () => okOutcome(chunks.join("")),
  });
  return openStream as unknown as AiContextBoundary["openStream"];
}

/** An async iterable over `steps`, recording `return()` calls. */
function producer(steps: (() => unknown)[]) {
  const state = { pulled: 0, returned: 0 };
  const iterator = {
    next: () => {
      const step = steps[state.pulled] ?? (() => ({ done: true, value: undefined }));
      state.pulled += 1;
      return step();
    },
    return: () => {
      state.returned += 1;
      return { done: true, value: undefined };
    },
  };
  return { iterable: { [Symbol.asyncIterator]: () => iterator }, state };
}

const chunk = (value: string) => () => Promise.resolve({ done: false, value });

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

describe("the abort listener of a streamed step is always removed", () => {
  test("every added listener is removed with the same function and type", async () => {
    const { boundary } = stub({ openStream: acceptingStream() });
    const mcp = createMcpBoundaryWith(boundary);
    const { signal, added, removed } = countingSignal();
    const { iterable } = producer([chunk("a"), chunk("b"), chunk("c")]);
    expect(await mcp.sanitizeStreamedToolResult(iterable, { signal })).toMatchObject({ outcome: "ok" });
    expect(added.length).toBe(4);
    expect(removed.length).toBe(added.length);
    expect(added.every((entry) => entry.type === "abort")).toBe(true);
    expect(removed.map((entry) => entry.type)).toEqual(added.map((entry) => entry.type));
    expect(removed.map((entry) => entry.listener)).toEqual(added.map((entry) => entry.listener));
  });

  test("a signal whose removeEventListener throws still gives ok", async () => {
    const { boundary } = stub({ openStream: acceptingStream() });
    const mcp = createMcpBoundaryWith(boundary);
    const { signal, removed } = countingSignal({ removeThrows: true });
    const { iterable } = producer([chunk("a"), chunk("b")]);
    expect(await mcp.sanitizeStreamedToolResult(iterable, { signal })).toMatchObject({ outcome: "ok" });
    expect(removed.length).toBe(3);
  });

  test("a signal with no removeEventListener still gives ok", async () => {
    const { boundary } = stub({ openStream: acceptingStream() });
    const mcp = createMcpBoundaryWith(boundary);
    const signal = { aborted: false, addEventListener: () => undefined };
    const { iterable } = producer([chunk("a")]);
    expect(await mcp.sanitizeStreamedToolResult(iterable, { signal })).toMatchObject({ outcome: "ok" });
  });

  test("a producer that rejects after the race was lost is not an unhandled rejection", async () => {
    const { boundary } = stub({ openStream: acceptingStream() });
    const mcp = createMcpBoundaryWith(boundary);
    const controller = new AbortController();
    let rejectLate: (reason: unknown) => void = () => undefined;
    const { iterable } = producer([
      () => {
        controller.abort();
        return new Promise((_resolve, reject) => {
          rejectLate = reject;
        });
      },
    ]);
    const seen: unknown[] = [];
    const listener = (reason: unknown) => seen.push(reason);
    process.on("unhandledRejection", listener);
    try {
      expect(await mcp.sanitizeStreamedToolResult(iterable, { signal: controller.signal })).toEqual(ABORTED);
      rejectLate(new Error(`late ${SECRET}`));
      await flush();
    } finally {
      process.off("unhandledRejection", listener);
    }
    expect(seen).toEqual([]);
  });
});

describe("a chunk source that is not iterable is unsupported_value", () => {
  test.each([
    ["a primitive string", SECRET],
    ["null", null],
    ["a number", 42],
    ["a non-function Symbol.iterator", { [Symbol.iterator]: 1 }],
    ["a non-function Symbol.asyncIterator", { [Symbol.asyncIterator]: 1 }],
  ])("%s", async (_name, chunks) => {
    let opened = 0;
    const { boundary } = stub({
      openStream: (() => {
        opened += 1;
        return acceptingStream()();
      }) as unknown as AiContextBoundary["openStream"],
    });
    const mcp = createMcpBoundaryWith(boundary);
    expect(await mcp.sanitizeStreamedToolResult(chunks)).toEqual(UNSUPPORTED);
    expect(opened).toBe(0);
  });
});

describe("the AI-context stream is aborted when the producer fails", () => {
  test("a next() that rejects", async () => {
    const record = { aborted: 0 };
    const { boundary } = stub({ openStream: acceptingStream(record) });
    const mcp = createMcpBoundaryWith(boundary);
    const { iterable } = producer([() => Promise.reject(new Error(`boom ${SECRET}`))]);
    expect(await mcp.sanitizeStreamedToolResult(iterable)).toEqual(TOOL_ERROR);
    expect(record.aborted).toBe(1);
  });

  test("a next() that resolves null", async () => {
    const record = { aborted: 0 };
    const { boundary } = stub({ openStream: acceptingStream(record) });
    const mcp = createMcpBoundaryWith(boundary);
    const { iterable, state } = producer([() => Promise.resolve(null)]);
    expect(await mcp.sanitizeStreamedToolResult(iterable)).toEqual(TOOL_ERROR);
    expect(record.aborted).toBe(1);
    expect(state.returned).toBe(0);
  });

  test("an abort while next() is pending", async () => {
    const record = { aborted: 0 };
    const { boundary } = stub({ openStream: acceptingStream(record) });
    const mcp = createMcpBoundaryWith(boundary);
    const controller = new AbortController();
    const { iterable, state } = producer([
      () => {
        controller.abort();
        return new Promise(() => undefined);
      },
    ]);
    expect(await mcp.sanitizeStreamedToolResult(iterable, { signal: controller.signal })).toEqual(ABORTED);
    expect(record.aborted).toBe(1);
    expect(state.returned).toBe(1);
  });
});

describe('binaryContent "pass" keeps every other result key as it is', () => {
  test("a tool result with an image block and structuredContent", () => {
    const mcp = createMcpBoundaryWith(stub().boundary, { binaryContent: "pass" });
    const result = {
      content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
      structuredContent: { a: "b" },
    };
    expect(mcp.sanitizeToolResult(result)).toMatchObject({ outcome: "ok", value: result });
  });

  test("a resource result with a blob entry and _meta", () => {
    const mcp = createMcpBoundaryWith(stub().boundary, { binaryContent: "pass" });
    const result = { contents: [{ uri: "file:///synthetic", blob: "AAAA" }], _meta: { k: "v" } };
    expect(mcp.sanitizeResourceResult(result)).toMatchObject({ outcome: "ok", value: result });
  });
});

describe('a rejected block or entry is blocked, not passed on, under "pass"', () => {
  const pass = () => createMcpBoundaryWith(stub().boundary, { binaryContent: "pass" });

  test.each([
    ["image data that is not a string", { type: "image", data: 1, mimeType: "image/png" }],
    ["audio data that is not a string", { type: "audio", data: 1, mimeType: "audio/wav" }],
    ["a resource that is a string", { type: "resource", resource: "x" }],
    ["a resource that is null", { type: "resource", resource: null }],
    ["a resource that is an array", { type: "resource", resource: [] }],
    ["a resource blob that is not a string", { type: "resource", resource: { uri: "u", blob: 1 } }],
  ])("a tool result block with %s", (_name, block) => {
    expect(pass().sanitizeToolResult({ content: [block] })).toEqual(UNSUPPORTED);
  });

  test.each([
    ["a null entry", null],
    ["a string entry", "x"],
    ["an array entry", []],
    ["text and blob together", { uri: "u", text: "t", blob: "AAAA" }],
    ["neither text nor blob", { uri: "u" }],
    ["a non-string text", { uri: "u", text: 1 }],
    ["a non-string blob", { uri: "u", blob: 1 }],
  ])("a resources/read entry that is %s", (_name, entry) => {
    expect(pass().sanitizeResourceResult({ contents: [entry] })).toEqual(UNSUPPORTED);
  });
});

describe("isPlainObject", () => {
  test("a null-prototype result, block and resource are ok", () => {
    const nullProto = <T extends object>(value: T): T => Object.assign(Object.create(null), value);
    const mcp = createMcpBoundaryWith(stub().boundary, { binaryContent: "pass" });
    const result = nullProto({
      content: [nullProto({ type: "resource", resource: nullProto({ uri: "u", text: "t" }) })],
    });
    expect(mcp.sanitizeToolResult(result)).toMatchObject({ outcome: "ok" });
    const read = nullProto({ contents: [nullProto({ uri: "u", text: "t" })] });
    expect(mcp.sanitizeResourceResult(read)).toMatchObject({ outcome: "ok" });
  });

  test("null is unsupported_value without throwing", () => {
    const mcp = createMcpBoundaryWith(stub().boundary);
    expect(mcp.sanitizeToolResult(null)).toEqual(UNSUPPORTED);
    expect(mcp.sanitizeToolResult({ content: [null] })).toEqual(UNSUPPORTED);
    expect(mcp.sanitizeToolResult({ content: [{ type: "resource", resource: null }] })).toEqual(UNSUPPORTED);
    expect(mcp.sanitizeResourceResult(null)).toEqual(UNSUPPORTED);
    expect(mcp.sanitizeToolArguments(null)).toEqual(UNSUPPORTED);
  });
});

describe("a value that is absent or has no binary field", () => {
  test("undefined is unsupported_value without throwing", () => {
    const mcp = createMcpBoundaryWith(stub().boundary);
    expect(mcp.sanitizeToolResult(undefined)).toEqual(UNSUPPORTED);
    expect(mcp.sanitizeResourceResult(undefined)).toEqual(UNSUPPORTED);
  });

  test.each(["block", "pass"] as const)(
    "blocks without their binary field keep their shape under %s",
    (binaryContent) => {
      const mcp = createMcpBoundaryWith(stub().boundary, { binaryContent });
      const result = {
        content: [
          { type: "image", mimeType: "image/png" },
          { type: "resource", resource: { uri: "u", text: "t" } },
        ],
      };
      expect(mcp.sanitizeToolResult(result)).toMatchObject({ outcome: "ok", value: result });
      const ok = mcp.sanitizeToolResult(result);
      expect(ok.outcome === "ok" ? ok.value : undefined).toStrictEqual(result);
    },
  );

  test("a function with the three methods is not an AI-context boundary", () => {
    const real = stub().boundary;
    const fn = Object.assign(() => undefined, {
      sanitizeValue: real.sanitizeValue,
      sanitizeText: real.sanitizeText,
      openStream: real.openStream,
    });
    expectTypeError(
      () => createMcpBoundaryWith(fn as never),
      "createMcpBoundaryWith: an AI-context boundary is required",
    );
  });

  test("a resources/read contents that is iterable but not an array is unsupported_value", () => {
    const mcp = createMcpBoundaryWith(stub().boundary);
    expect(mcp.sanitizeResourceResult({ contents: new Set([{ uri: "u", text: "t" }]) })).toEqual(UNSUPPORTED);
  });
});

describe("the call and read callbacks", () => {
  test("a non-function invoke is tool_error, and a non-function read is read_error", async () => {
    const mcp = createMcpBoundaryWith(stub().boundary);
    expect(await mcp.sanitizeToolCall(1 as never)).toEqual(TOOL_ERROR);
    expect(await mcp.sanitizeResourceRead(1 as never)).toEqual({ outcome: "read_error" });
  });

  test("the read callback receives the caller's signal by identity", async () => {
    const mcp = createMcpBoundaryWith(stub().boundary);
    const signal = { aborted: false };
    let seen: unknown = "unset";
    await mcp.sanitizeResourceRead(
      (context) => {
        seen = context.signal;
        return { contents: [] };
      },
      { signal },
    );
    expect(seen).toBe(signal);
  });
});

describe("the key-context backstop's cache", () => {
  test("an abort while skipping a repeated part is aborted", () => {
    const state = { aborted: false };
    const { boundary } = stub({
      sanitizeText: (text) => {
        if (state.aborted === false && text === '{"type":"text"}') state.aborted = true;
        return okOutcome(text);
      },
    });
    const mcp = createMcpBoundaryWith(boundary);
    const signal = {
      get aborted() {
        return state.aborted;
      },
    };
    const block = { type: "text", text: "a" };
    expect(mcp.sanitizeToolResult({ content: [block, block, block] }, { signal })).toEqual(ABORTED);
  });

  test("a part with a non-blocking finding is scanned again", () => {
    const { boundary, texts } = stub({
      sanitizeText: (text) => okOutcome(text, text.includes("resource_link") ? [finding("warn")] : []),
    });
    const mcp = createMcpBoundaryWith(boundary);
    const block = { type: "resource_link", uri: "u", name: "n" };
    expect(mcp.sanitizeToolResult({ content: [block, block] })).toMatchObject({ outcome: "ok" });
    expect(texts.filter((text) => text.includes("resource_link")).length).toBe(2);
  });
});

describe("audit records", () => {
  function record() {
    const audits: McpAuditRecord[] = [];
    const mcp = createMcpBoundaryWith(stub().boundary, { onAudit: (entry) => audits.push(entry) });
    return { mcp, audits };
  }

  test("an ok outcome carries exactly stage and outcome", () => {
    const { mcp, audits } = record();
    mcp.sanitizeToolResult({ content: [] });
    expect(audits).toStrictEqual([{ stage: "result", outcome: "ok" }]);
    expect(mcpAuditRecord({ outcome: "aborted" }, "arguments")).toStrictEqual({
      stage: "arguments",
      outcome: "aborted",
    });
  });

  test("a blocked outcome carries a reason, and a code only when there is one", () => {
    expect(mcpAuditRecord({ outcome: "blocked", reason: "policy" }, "resource")).toStrictEqual({
      stage: "resource",
      outcome: "blocked",
      reason: "policy",
    });
    expect(
      mcpAuditRecord({ outcome: "blocked", reason: "core_error", code: "NOT_INITIALIZED" }, "result"),
    ).toStrictEqual({
      stage: "result",
      outcome: "blocked",
      reason: "core_error",
      code: "NOT_INITIALIZED",
    });
  });

  test("a wrapped handler with sanitizeArguments audits arguments, then result", async () => {
    const { mcp, audits } = record();
    const handler = mcp.wrapToolHandler(() => ({ content: [] }), { sanitizeArguments: true });
    await handler({ q: "x" }, {});
    expect(audits).toStrictEqual([
      { stage: "arguments", outcome: "ok" },
      { stage: "result", outcome: "ok" },
    ]);
  });

  test("sanitizeToolCall with arguments audits arguments, then result", async () => {
    const { mcp, audits } = record();
    await mcp.sanitizeToolCall(() => ({ content: [] }), { arguments: { q: "x" } });
    expect(audits).toStrictEqual([
      { stage: "arguments", outcome: "ok" },
      { stage: "result", outcome: "ok" },
    ]);
  });

  test("sanitizeToolCall without arguments audits only result and passes no arguments", async () => {
    const { mcp, audits } = record();
    let context: unknown;
    await mcp.sanitizeToolCall((received) => {
      context = received;
      return { content: [] };
    });
    expect(audits).toStrictEqual([{ stage: "result", outcome: "ok" }]);
    expect(Object.keys(context as object)).not.toContain("arguments");
  });
});

describe("fixed messages and names", () => {
  test("wrapper construction guards", () => {
    const mcp = createMcpBoundaryWith(stub().boundary);
    expectTypeError(() => mcp.wrapToolHandler(1 as never), "wrapToolHandler: handler must be a function");
    expectTypeError(() => mcp.wrapStreamedToolHandler(1 as never), "wrapToolHandler: handler must be a function");
    expectTypeError(
      () => mcp.wrapResourceReadHandler(1 as never),
      "wrapResourceReadHandler: handler must be a function",
    );
  });

  test("the thrown resource error", async () => {
    const mcp = createMcpBoundaryWith(stub().boundary);
    const handler = mcp.wrapResourceReadHandler(() => ({ contents: [{ uri: "u", text: 1 }] }));
    const error = (await handler("u", {}).catch((thrown: unknown) => thrown)) as McpResourceError;
    expect(error).toBeInstanceOf(McpResourceError);
    expect(error.name).toBe("McpResourceError");
    expect(error.code).toBe(-32603);
    expect(error.message).toBe(
      "This MCP resource read was blocked by secret-redaction policy. No content, URI, or error detail is included.",
    );
    expect(mcpResourceBlockedError().message).toBe(MCP_RESOURCE_BLOCKED_MESSAGE);
  });

  test("toCallToolResult, toReadResourceResponse and mcpAuditRecord reject what they cannot map", () => {
    expectTypeError(() => toCallToolResult(undefined as never), "toCallToolResult: not an MCP boundary outcome");
    expectTypeError(
      () => toCallToolResult({ outcome: "read_error" } as never),
      "toCallToolResult: not an MCP boundary outcome",
    );
    expectTypeError(
      () => toReadResourceResponse(undefined as never),
      "toReadResourceResponse: not an MCP resources/read outcome",
    );
    expectTypeError(
      () => toReadResourceResponse({ outcome: "tool_error" } as never),
      "toReadResourceResponse: not an MCP resources/read outcome",
    );
    expectTypeError(() => mcpAuditRecord({ outcome: "ok" } as never, "" as never), "mcpAuditRecord: unknown stage");
  });
});
