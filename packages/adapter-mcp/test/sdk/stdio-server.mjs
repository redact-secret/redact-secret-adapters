/**
 * The stdio child: `node stdio-server.mjs <v1|v2> <low-level|mcp-server>`.
 * Serves one of `servers.mjs`'s servers over the SDK's own stdio transport.
 * Nothing is written to stdout except protocol messages.
 */

import { buildLowLevelServer, buildMcpServer } from "./servers.mjs";

const [line, kind] = process.argv.slice(2);
const { StdioServerTransport } =
  line === "v1"
    ? await import("@modelcontextprotocol/sdk/server/stdio.js")
    : await import("@modelcontextprotocol/server/stdio");
const { server } = kind === "mcp-server" ? await buildMcpServer(line) : await buildLowLevelServer(line);
await server.connect(new StdioServerTransport());
