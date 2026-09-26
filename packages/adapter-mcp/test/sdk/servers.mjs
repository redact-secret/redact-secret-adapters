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
 *   Resources (`resources/read`, redact-secret/redact-secret#843):
 *   - `test://replay/<index>`: returns resource fixture case <index>'s
 *     `result`, raw; the host applies the boundary.
 *   - `test://wrapped/<index>`: the same result through
 *     `wrapResourceReadHandler` (the preventive, server-side placement).
 *   - `test://rpc-error`: throws an error whose message carries a
 *     synthetic secret; the SDK sends it as the JSON-RPC error message.
 *   - `test://wrapped-throw`: the same throw, wrapped.
 *   - `test://slow`: a wrapped read that waits until it is cancelled.
 * - `buildMcpServer(line)`: the high-level `McpServer` with `registerTool`,
 *   to prove the wrapper works with the SDK's own handler signature and that
 *   it catches a handler error before the SDK turns it into result text,
 *   and `registerResource` (a fixed URI and a URI template) with wrapped and
 *   unwrapped read callbacks.
 *
 * Every value is synthetic.
 */

import { readFileSync } from "node:fs";

import { createMcpBoundary } from "../../dist/index.js";

const fixture = JSON.parse(
  readFileSync(new URL("../../../../fixtures/core/mcp-boundary.json", import.meta.url), "utf-8"),
);
const resourceFixture = JSON.parse(
  readFileSync(new URL("../../../../fixtures/core/mcp-resources-read.json", import.meta.url), "utf-8"),
);

/** A fixture value of the form `{ repeat, count }` materialized, as the core runner does. */
export function materializeValue(value) {
  if (Array.isArray(value)) return value.map(materializeValue);
  if (value !== null && typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 2 && typeof value.repeat === "string" && Number.isInteger(value.count)) {
      return value.repeat.repeat(value.count);
    }
    return Object.fromEntries(keys.map((key) => [key, materializeValue(value[key])]));
  }
  return value;
}

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
    const { ResourceTemplate } = await import("@modelcontextprotocol/sdk/server/mcp.js");
    return {
      Server,
      McpServer,
      ResourceTemplate,
      onListTools: (server, handler) => server.setRequestHandler(types.ListToolsRequestSchema, handler),
      onCallTool: (server, handler) => server.setRequestHandler(types.CallToolRequestSchema, handler),
      onReadResource: (server, handler) => server.setRequestHandler(types.ReadResourceRequestSchema, handler),
    };
  }
  if (line === "v2") {
    const { Server, McpServer, ResourceTemplate } = await import("@modelcontextprotocol/server");
    return {
      Server,
      McpServer,
      ResourceTemplate,
      onListTools: (server, handler) => server.setRequestHandler("tools/list", handler),
      onCallTool: (server, handler) => server.setRequestHandler("tools/call", handler),
      onReadResource: (server, handler) => server.setRequestHandler("resources/read", handler),
    };
  }
  throw new Error("unknown SDK line");
}

const INFO = { name: "redact-secret-adapter-mcp-test", version: "0.0.0" };

export async function buildLowLevelServer(line) {
  const sdk = await loadLine(line);
  const mcp = await createMcpBoundary(LIMITS);
  const stats = {
    echoCalls: 0,
    wrappedArgsCalls: 0,
    slowStreamClosed: 0,
    slowStreamPulled: 0,
    lastWrappedArgs: null,
    slowReads: 0,
    slowReadsCancelled: 0,
  };

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

  const resources = new Map();
  resourceFixture.cases.forEach((testCase, index) => {
    if (testCase.result === undefined || testCase.operation !== "resourceResult") return;
    const result = () => materializeValue(testCase.result);
    resources.set(`test://replay/${index}`, result);
    resources.set(
      `test://wrapped/${index}`,
      createMcpBoundary({ ...LIMITS, binaryContent: testCase.binaryContent ?? "block" }).then((boundary) =>
        boundary.wrapResourceReadHandler(result),
      ),
    );
  });
  const resourceToken = resourceFixture.cases[0].secrets[0];
  resources.set("test://rpc-error", () => {
    throw new Error(`${CONTROL_MARKER} ${resourceToken}`);
  });
  resources.set(
    "test://wrapped-throw",
    mcp.wrapResourceReadHandler(() => {
      throw new Error(`${CONTROL_MARKER} ${resourceToken}`);
    }),
  );
  resources.set(
    "test://slow",
    mcp.wrapResourceReadHandler(
      (_request, extra) =>
        new Promise((_resolve, reject) => {
          stats.slowReads += 1;
          const signal = extra?.signal ?? extra?.mcpReq?.signal;
          signal?.addEventListener("abort", () => {
            stats.slowReadsCancelled += 1;
            reject(new Error(`cancelled ${resourceToken}`));
          });
        }),
    ),
  );

  const server = new sdk.Server(INFO, { capabilities: { tools: {}, resources: {} } });
  sdk.onReadResource(server, async (request, extra) => {
    const entry = resources.get(request.params.uri);
    if (entry === undefined) throw new Error("unknown resource");
    const handler = await entry;
    return handler(request, extra);
  });
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
  server.registerResource(
    "wrapped-env",
    "test://mcp/env",
    { mimeType: "text/plain" },
    mcp.wrapResourceReadHandler((uri) => ({
      contents: [{ uri: uri.href, mimeType: "text/plain", text: `REGION=eu-west-1\nAPI_KEY=${token}\n` }],
    })),
  );
  server.registerResource(
    "wrapped-config",
    new sdk.ResourceTemplate("test://mcp/config/{name}", { list: undefined }),
    { mimeType: "application/json" },
    mcp.wrapResourceReadHandler((uri, variables) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify({ name: variables.name, password: "synthetic-not-a-secret" }),
        },
      ],
      _meta: { password: "synthetic-not-a-secret" },
    })),
  );
  server.registerResource(
    "wrapped-throw",
    "test://mcp/wrapped-throw",
    {},
    mcp.wrapResourceReadHandler(() => {
      throw new Error(`${CONTROL_MARKER} ${token}`);
    }),
  );
  server.registerResource("unwrapped-throw", "test://mcp/unwrapped-throw", {}, () => {
    throw new Error(CONTROL_MARKER);
  });
  return { server };
}
