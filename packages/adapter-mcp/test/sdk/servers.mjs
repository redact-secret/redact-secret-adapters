/**
 * Real MCP servers for the SDK tests, built on either SDK line, used both
 * in process (Streamable HTTP) and from a child process (stdio,
 * `stdio-server.mjs`). Plain ESM so the child can run it without a build
 * step; it loads the built adapter from `dist/`.
 *
 * Two servers:
 *
 * - `buildLowLevelServer(line)`: the low-level `Server` with its own
 *   `tools/list` / `tools/call` dispatch, so every handler sees the raw
 *   `params.arguments`. Tools:
 *   - `replay:<index>`: returns fixture case <index>'s `result`, raw. The
 *     host applies the boundary (the authoritative placement).
 *   - `echo-args`: returns the arguments it received, as JSON text, raw.
 *   - `wrapped-args`: a handler wrapped with `sanitizeArguments: true`.
 *   - `wrapped-stream:<index>`: fixture streamed case <index>, served by
 *     `wrapStreamedToolHandler` (the preventive, server-side placement).
 *   - `slow-stream`: a wrapped streamed handler that yields one chunk and
 *     then waits until the request is cancelled.
 *   - `stats`: what the server saw (dispatch counts, producer closes).
 * - `buildMcpServer(line)`: the high-level `McpServer` with `registerTool`,
 *   to prove the wrapper works with the SDK's own handler signature and that
 *   it catches a handler error before the SDK turns it into result text.
 *
 * Every value is synthetic.
 */

import { readFileSync } from "node:fs";

import { createMcpBoundary } from "../../dist/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../fixtures/core/mcp-boundary.json", import.meta.url), "utf-8"),
);

export const LIMITS = Object.freeze({
  wholeInputLimits: fixture.limits.wholeInput,
  incrementalLimits: {
    maxInputCodeUnits: fixture.limits.incremental.maxInputBytes,
    maxBufferedCodeUnits: fixture.limits.incremental.maxBufferedBytes,
    maxTokenCodeUnits: fixture.limits.incremental.maxTokenBytes,
    maxMultilineCodeUnits: fixture.limits.incremental.maxMultilineBytes,
  },
  traversalLimits: fixture.limits.traversal,
});

/** A marker in a control handler's error message: not a secret, only proof of what the SDK does unwrapped. */
export const CONTROL_MARKER = "CONTROL_ERROR_MESSAGE_MARKER";

function materialize(chunk) {
  return typeof chunk === "string" ? chunk : chunk.repeat.repeat(chunk.count);
}

export async function loadLine(line) {
  if (line === "v1") {
    const [{ Server }, { McpServer }, types] = await Promise.all([
      import("@modelcontextprotocol/sdk/server/index.js"),
      import("@modelcontextprotocol/sdk/server/mcp.js"),
      import("@modelcontextprotocol/sdk/types.js"),
    ]);
    return {
      Server,
      McpServer,
      onListTools: (server, handler) => server.setRequestHandler(types.ListToolsRequestSchema, handler),
      onCallTool: (server, handler) => server.setRequestHandler(types.CallToolRequestSchema, handler),
    };
  }
  if (line === "v2") {
    const { Server, McpServer } = await import("@modelcontextprotocol/server");
    return {
      Server,
      McpServer,
      onListTools: (server, handler) => server.setRequestHandler("tools/list", handler),
      onCallTool: (server, handler) => server.setRequestHandler("tools/call", handler),
    };
  }
  throw new Error("unknown SDK line");
}

const INFO = { name: "redact-secret-adapter-mcp-test", version: "0.0.0" };

export async function buildLowLevelServer(line) {
  const sdk = await loadLine(line);
  const mcp = await createMcpBoundary(LIMITS);
  const stats = { echoCalls: 0, wrappedArgsCalls: 0, slowStreamClosed: 0, slowStreamPulled: 0, lastWrappedArgs: null };

  const handlers = new Map();
  fixture.cases.forEach((testCase, index) => {
    if (testCase.result !== undefined) handlers.set(`replay:${index}`, () => testCase.result);
    if (testCase.operation === "streamedToolResult" && testCase.signal === undefined) {
      handlers.set(
        `wrapped-stream:${index}`,
        mcp.wrapStreamedToolHandler((_args, _extra) => {
          const chunks = testCase.chunks.map(materialize);
          const { throwBefore } = testCase.producer ?? {};
          return (function* produce() {
            for (let i = 0; i < chunks.length; i += 1) {
              if (throwBefore === i) throw new Error(`synthetic producer failure ${(testCase.secrets ?? [])[0] ?? ""}`);
              yield chunks[i];
            }
          })();
        }),
      );
    }
  });
  handlers.set("echo-args", (args) => {
    stats.echoCalls += 1;
    return { content: [{ type: "text", text: JSON.stringify(args ?? null) }] };
  });
  handlers.set(
    "wrapped-args",
    mcp.wrapToolHandler(
      (args) => {
        stats.wrappedArgsCalls += 1;
        stats.lastWrappedArgs = args ?? null;
        return { content: [{ type: "text", text: "arguments accepted" }] };
      },
      { sanitizeArguments: true },
    ),
  );
  handlers.set(
    "slow-stream",
    mcp.wrapStreamedToolHandler((_args, extra) => ({
      [Symbol.asyncIterator]() {
        let sent = false;
        return {
          next() {
            if (!sent) {
              sent = true;
              stats.slowStreamPulled += 1;
              return Promise.resolve({ done: false, value: "first chunk of a slow producer\n" });
            }
            stats.slowStreamPulled += 1;
            // Never resolves on its own: only cancellation ends it.
            return new Promise(() => {
              void extra;
            });
          },
          return() {
            stats.slowStreamClosed += 1;
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    })),
  );
  handlers.set("rpc-error", () => {
    // The low-level server turns this into a JSON-RPC error whose message
    // carries the synthetic secret: the host must never read it.
    throw new Error(`${CONTROL_MARKER} ${fixture.cases[0].secrets[0]}`);
  });
  handlers.set("agent-tool", () => {
    const token = fixture.cases[0].secrets[0];
    return {
      content: [
        { type: "text", text: `deploy finished\nAPI_KEY=${token}\n` },
        { type: "resource_link", uri: `https://example.test/run?token=${token}`, name: "run" },
      ],
      structuredContent: { deploy: { env: [`API_KEY=${token}`], ok: true } },
      _meta: { upstream: `API_KEY=${token}` },
    };
  });
  handlers.set("deep-result", () => {
    let nested = { leaf: "ordinary text" };
    for (let i = 0; i < 10; i += 1) nested = { nested };
    return { content: [], structuredContent: nested };
  });
  handlers.set("stats", () => ({ content: [{ type: "text", text: JSON.stringify(stats) }] }));

  const server = new sdk.Server(INFO, { capabilities: { tools: {} } });
  sdk.onListTools(server, () => ({
    tools: [...handlers.keys()].map((name) => ({ name, inputSchema: { type: "object" } })),
  }));
  sdk.onCallTool(server, (request, extra) => {
    const handler = handlers.get(request.params.name);
    if (handler === undefined) return { content: [{ type: "text", text: "unknown tool" }], isError: true };
    return handler(request.params.arguments, extra);
  });
  return { server, stats };
}

export async function buildMcpServer(line) {
  const sdk = await loadLine(line);
  const mcp = await createMcpBoundary(LIMITS);
  const server = new sdk.McpServer(INFO);
  const token = fixture.cases[0].secrets[0];
  server.registerTool(
    "wrapped-result",
    { description: "returns a result with a synthetic secret, sanitized by the wrapper" },
    mcp.wrapToolHandler(() => ({ content: [{ type: "text", text: `deploy log\nAPI_KEY=${token}` }] })),
  );
  server.registerTool(
    "wrapped-throw",
    { description: "throws an error whose message carries a synthetic secret" },
    mcp.wrapToolHandler(() => {
      throw new Error(`${CONTROL_MARKER} ${token}`);
    }),
  );
  server.registerTool("unwrapped-throw", { description: "control: the SDK's own conversion" }, () => {
    throw new Error(CONTROL_MARKER);
  });
  return { server };
}
