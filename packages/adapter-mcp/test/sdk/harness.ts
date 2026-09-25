/**
 * Connects a real MCP client of either SDK line to a real server
 * (`servers.mjs`) over stdio (a child process) or Streamable HTTP (a Node
 * `http` server on 127.0.0.1). Whatever SDK version is installed is the one
 * under test: CI installs both endpoints of every declared line
 * (`npm run range-endpoint -- lowest|highest`), and `installedVersion`
 * reports which one ran.
 *
 * The SDKs are loaded with computed specifiers and typed structurally here,
 * so this file typechecks against either line.
 */

import { readFileSync } from "node:fs";
import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export type Line = "v1" | "v2";
export type TransportKind = "stdio" | "http";
export type ServerKind = "low-level" | "mcp-server";

export const LINES: readonly Line[] = ["v1", "v2"];
export const TRANSPORTS: readonly TransportKind[] = ["stdio", "http"];

const REQUEST_TIMEOUT_MS = 2_000;

/** The protocol revisions the contract claims. */
export const CLAIMED_PROTOCOLS = ["2025-06-18", "2025-11-25"];

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
// biome-ignore lint/suspicious/noExplicitAny: the SDK modules are loaded by computed specifier, typed structurally.
type Any = any;

const load = (specifier: string): Promise<Any> => import(specifier);

/** The installed version of an SDK package, read from its own manifest. */
export function installedVersion(name: string, entry: string): string {
  let dir = dirname(require.resolve(entry));
  for (;;) {
    try {
      const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
      if (manifest.name === name) return manifest.version;
    } catch {
      // keep walking up
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error(`cannot find the manifest of ${name}`);
    dir = parent;
  }
}

export function lineVersions(line: Line): Record<string, string> {
  return line === "v1"
    ? {
        "@modelcontextprotocol/sdk": installedVersion(
          "@modelcontextprotocol/sdk",
          "@modelcontextprotocol/sdk/client/index.js",
        ),
      }
    : {
        "@modelcontextprotocol/client": installedVersion(
          "@modelcontextprotocol/client",
          "@modelcontextprotocol/client",
        ),
        "@modelcontextprotocol/server": installedVersion(
          "@modelcontextprotocol/server",
          "@modelcontextprotocol/server",
        ),
      };
}

export interface Connection {
  readonly line: Line;
  readonly transport: TransportKind;
  readonly protocolVersion: string | undefined;
  /**
   * `client.callTool` of this line, with the line's own argument order. The
   * request timeout is short: SDK 1.13.0's client never settles a call whose
   * result is not an object, so without it that case would hang, not fail.
   */
  callTool(params: { name: string; arguments?: Record<string, unknown> }, signal?: AbortSignal): Promise<unknown>;
  /** Every JSON-RPC message the server sent (HTTP only; stdio leaves it empty). */
  readonly serverSent: Any[];
  close(): Promise<void>;
}

async function clientModules(line: Line) {
  if (line === "v1") {
    const [{ Client }, { StdioClientTransport }, { StreamableHTTPClientTransport }] = await Promise.all([
      load("@modelcontextprotocol/sdk/client/index.js"),
      load("@modelcontextprotocol/sdk/client/stdio.js"),
      load("@modelcontextprotocol/sdk/client/streamableHttp.js"),
    ]);
    return { Client, StdioClientTransport, StreamableHTTPClientTransport };
  }
  const [{ Client, StreamableHTTPClientTransport }, { StdioClientTransport }] = await Promise.all([
    load("@modelcontextprotocol/client"),
    load("@modelcontextprotocol/client/stdio"),
  ]);
  return { Client, StdioClientTransport, StreamableHTTPClientTransport };
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** Serves one server over the line's Streamable HTTP server transport, one session. */
async function serveHttp(
  line: Line,
  server: Any,
  serverSent: Any[],
): Promise<{ url: URL; close: () => Promise<void> }> {
  const { randomUUID } = await import("node:crypto");
  let transport: Any;
  let handle: (req: IncomingMessage, res: ServerResponse) => Promise<void>;
  if (line === "v1") {
    const { StreamableHTTPServerTransport } = await load("@modelcontextprotocol/sdk/server/streamableHttp.js");
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    handle = async (req, res) => {
      const body = await readBody(req);
      await transport.handleRequest(req, res, body.length > 0 ? JSON.parse(body.toString("utf-8")) : undefined);
    };
  } else {
    const { WebStandardStreamableHTTPServerTransport } = await load("@modelcontextprotocol/server");
    transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() });
    handle = async (req, res) => {
      const body = await readBody(req);
      const headers = new Headers();
      for (const [key, value] of Object.entries(req.headers)) {
        if (typeof value === "string") headers.set(key, value);
        else if (Array.isArray(value)) for (const item of value) headers.append(key, item);
      }
      const controller = new AbortController();
      res.on("close", () => controller.abort());
      const request = new Request(`http://127.0.0.1${req.url ?? "/"}`, {
        method: req.method,
        headers,
        body: body.length > 0 ? body : undefined,
        signal: controller.signal,
      });
      const response: Response = await transport.handleRequest(request);
      res.writeHead(response.status, Object.fromEntries(response.headers.entries()));
      if (response.body === null) {
        res.end();
        return;
      }
      const reader = response.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(value);
        }
      } catch {
        // The client went away mid-stream.
      }
      res.end();
    };
  }
  const send = transport.send.bind(transport);
  transport.send = (message: Any, options?: Any) => {
    serverSent.push(message);
    return send(message, options);
  };
  await server.connect(transport);
  const http: HttpServer = createServer((req, res) => {
    handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const { port } = http.address() as AddressInfo;
  return {
    url: new URL(`http://127.0.0.1:${port}/mcp`),
    close: async () => {
      await server.close().catch(() => undefined);
      http.closeAllConnections?.();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}

/** Connects a client of `line` to a fresh server of `kind` over `transport`. */
export async function connect(
  line: Line,
  transport: TransportKind,
  kind: ServerKind = "low-level",
): Promise<Connection> {
  const { Client, StdioClientTransport, StreamableHTTPClientTransport } = await clientModules(line);
  const client = new Client({ name: "redact-secret-adapter-mcp-host", version: "0.0.0" });
  const serverSent: Any[] = [];
  let closeServer: () => Promise<void> = async () => undefined;
  let clientTransport: Any;
  if (transport === "stdio") {
    clientTransport = new StdioClientTransport({
      command: process.execPath,
      args: [join(here, "stdio-server.mjs"), line, kind],
      stderr: "pipe",
    });
  } else {
    const servers = await import("./servers.mjs");
    const { server } =
      kind === "mcp-server" ? await servers.buildMcpServer(line) : await servers.buildLowLevelServer(line);
    const served = await serveHttp(line, server, serverSent);
    closeServer = served.close;
    clientTransport = new StreamableHTTPClientTransport(served.url);
  }
  let negotiated: string | undefined;
  const setProtocolVersion = clientTransport.setProtocolVersion?.bind(clientTransport);
  clientTransport.setProtocolVersion = (version: string) => {
    negotiated = version;
    setProtocolVersion?.(version);
  };
  await client.connect(clientTransport);
  negotiated ??= client.getNegotiatedProtocolVersion?.();
  return {
    line,
    transport,
    protocolVersion: negotiated,
    serverSent,
    callTool(params, signal) {
      const options = { signal, timeout: REQUEST_TIMEOUT_MS };
      return line === "v1" ? client.callTool(params, undefined, options) : client.callTool(params, options);
    },
    async close() {
      await client.close().catch(() => undefined);
      await closeServer();
    },
  };
}
