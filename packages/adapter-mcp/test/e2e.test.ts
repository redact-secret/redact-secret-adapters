/**
 * End to end at the authoritative placement, on the real core, with real
 * MCP SDK clients of both lines over both transports: an MCP host that logs
 * every tool result, persists it, and builds model context from it. The
 * raw result exists only inside `sanitizeToolCall`; the log, the store, and
 * the model context receive `toCallToolResult(outcome)` and nothing else.
 *
 * Streamed tool output comes from a real subprocess (a Node child writing
 * to stdout in pieces), so the split, the early stop, and the producer
 * close are exercised against an OS pipe, not a test double.
 *
 * `resources/read` (redact-secret/redact-secret#843) at the same placement:
 * the host reads a resource through `sanitizeResourceRead`, and the log,
 * the store, and the model context receive `toReadResourceResponse(outcome)`
 * (the sanitized result, or the fixed JSON-RPC error) and nothing else.
 *
 * Tokens are synthetic (the core fixture's own `ghp_SYNTHETICREVOKED…`).
 */

import { spawn } from "node:child_process";

import { type AiContextBoundary, createAiContextBoundary } from "@redact-secret/adapter-ai-context";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createMcpBoundary,
  type McpAuditRecord,
  type McpBoundary,
  type McpOutcome,
  type McpResourceOutcome,
  mcpBlockedResult,
  mcpResourceBlockedError,
  mcpResourceReadError,
  toCallToolResult,
  toReadResourceResponse,
} from "../src/index.js";
import { loadResourceFixture } from "./conformance.js";
import { type Connection, connect, LINES, TRANSPORTS } from "./sdk/harness.js";
import { LIMITS } from "./sdk/servers.mjs";

const TOKEN = `ghp_${"SYNTHETICREVOKED"}${"0".repeat(20)}`;

/** A host: every tool result goes to a log, a store, and model context, only after the boundary. */
function createHost(ai: AiContextBoundary) {
  const log: string[] = [];
  const store = new Map<string, unknown>();
  const modelContexts: unknown[] = [];
  let turn = 0;
  async function deliver(outcome: McpOutcome<unknown>): Promise<unknown> {
    const delivered = toCallToolResult(outcome);
    if (delivered === null) return null; // cancelled: nothing is delivered anywhere
    turn += 1;
    log.push(JSON.stringify({ turn, tool: delivered }));
    store.set(`turn-${turn}`, delivered);
    const context = ai.buildContext([{ role: "tool", boundary: "tool-result", value: delivered }]);
    if (context.outcome !== "ok") throw new Error("context refused");
    modelContexts.push(context.value);
    return delivered;
  }
  /** A resource read: the sanitized result goes to every sink; a fixed error goes to the log and the store only. */
  async function deliverResource(outcome: McpResourceOutcome<unknown>): Promise<unknown> {
    const response = toReadResourceResponse(outcome);
    if (response === null) return null;
    turn += 1;
    log.push(JSON.stringify({ turn, resource: response }));
    store.set(`turn-${turn}`, response);
    if ("result" in response) {
      const context = ai.buildContext([{ role: "user", boundary: "resource", value: response.result }]);
      if (context.outcome !== "ok") throw new Error("context refused");
      modelContexts.push(context.value);
    }
    return response;
  }
  const sinks = () => JSON.stringify({ log, store: [...store.values()], modelContexts });
  return { deliver, deliverResource, sinks, log, store, modelContexts };
}

/** A real subprocess that writes `pieces` to stdout, one write per piece, then waits to be killed. */
function subprocess(pieces: string[], { linger = false } = {}) {
  const script = `
    const pieces = ${JSON.stringify(pieces)};
    let i = 0;
    const tick = () => { if (i < pieces.length) { process.stdout.write(pieces[i++]); setTimeout(tick, 5); } else if (!${linger}) process.exit(0); };
    tick();
    setInterval(() => {}, 1000);
  `;
  const child = spawn(process.execPath, ["-e", script], { stdio: ["ignore", "pipe", "ignore"] });
  child.stdout.setEncoding("utf-8");
  return child;
}

const resourceFixture = loadResourceFixture();
function resourceIndex(id: string): number {
  const index = resourceFixture.cases.findIndex((c) => c.id === id);
  if (index === -1) throw new Error(`no resource fixture case ${id}`);
  return index;
}

const audits: McpAuditRecord[] = [];
let mcp: McpBoundary;
let ai: AiContextBoundary;

beforeAll(async () => {
  mcp = await createMcpBoundary({
    ...LIMITS,
    onAudit: (record) => {
      audits.push(record);
      // A downstream audit sink that fails: never changes an outcome.
      throw new Error(`audit sink down ${TOKEN}`);
    },
    onFinding: () => {
      throw new Error(`telemetry sink down ${TOKEN}`);
    },
  });
  ai = await createAiContextBoundary(LIMITS);
});

describe.each(LINES.flatMap((line) => TRANSPORTS.map((transport) => [line, transport] as const)))(
  "host with SDK %s over %s",
  (line, transport) => {
    let connection: Connection;
    beforeAll(async () => {
      connection = await connect(line, transport, "low-level");
    }, 60_000);
    afterAll(async () => {
      await connection?.close();
    });

    test("a tool result is sanitized before the log, the store, and model context", async () => {
      const host = createHost(ai);
      const outcome = await mcp.sanitizeToolCall(({ signal }) =>
        connection.callTool({ name: "agent-tool" }, signal as AbortSignal | undefined),
      );
      expect(outcome.outcome).toBe("ok");
      const delivered = await host.deliver(outcome);
      expect(delivered).toEqual({
        content: [
          { type: "text", text: "deploy finished\nAPI_KEY=<SECRET_1>\n" },
          { type: "resource_link", uri: "https://example.test/run?token=<SECRET_1>", name: "run" },
        ],
        structuredContent: { deploy: { env: ["API_KEY=<SECRET_1>"], ok: true } },
        _meta: { upstream: "API_KEY=<SECRET_1>" },
      });
      expect(host.log).toHaveLength(1);
      expect(host.store.size).toBe(1);
      expect(host.modelContexts).toHaveLength(1);
      expect(host.sinks().includes(TOKEN)).toBe(false);
      expect(host.sinks()).toContain("<SECRET_1>");
    });

    test("a result over the traversal limit reaches every sink only as the fixed blocked result", async () => {
      const host = createHost(ai);
      const outcome = await mcp.sanitizeToolCall(({ signal }) =>
        connection.callTool({ name: "deep-result" }, signal as AbortSignal | undefined),
      );
      expect(outcome).toEqual({ outcome: "blocked", reason: "limit_exceeded" });
      expect(await host.deliver(outcome)).toEqual(mcpBlockedResult());
      expect(host.sinks()).not.toContain("ordinary text");
    });

    test("a JSON-RPC error reaches every sink only as the fixed tool-error result", async () => {
      const host = createHost(ai);
      const outcome = await mcp.sanitizeToolCall(({ signal }) =>
        connection.callTool({ name: "rpc-error" }, signal as AbortSignal | undefined),
      );
      expect(outcome).toEqual({ outcome: "tool_error" });
      await host.deliver(outcome);
      expect(host.sinks().includes(TOKEN)).toBe(false);
    });

    test("a resource read is sanitized before the log, the store, and model context", async () => {
      const host = createHost(ai);
      const index = resourceIndex("text-redacts-provider-token");
      const outcome = await mcp.sanitizeResourceRead(({ signal }) =>
        connection.readResource(`test://replay/${index}`, signal as AbortSignal | undefined),
      );
      expect(outcome.outcome).toBe("ok");
      expect(await host.deliverResource(outcome)).toEqual({
        result: {
          contents: [
            { uri: "file:///synthetic/.env", mimeType: "text/plain", text: "REGION=eu-west-1\nAPI_KEY=<SECRET_1>\n" },
          ],
        },
      });
      expect(host.modelContexts).toHaveLength(1);
      expect(host.sinks().includes(TOKEN)).toBe(false);
    });

    test.each([
      ["a block finding", "text-block-finding-blocks"],
      ["the input limit", "text-over-input-limit-blocked"],
      ["a blob under the default", "blob-blocked-by-default"],
    ])("a resource refused for %s reaches the log and store only as the fixed error", async (_name, id) => {
      const host = createHost(ai);
      const outcome = await mcp.sanitizeResourceRead(({ signal }) =>
        connection.readResource(`test://replay/${resourceIndex(id)}`, signal as AbortSignal | undefined),
      );
      expect(outcome.outcome).toBe("blocked");
      expect(await host.deliverResource(outcome)).toEqual({ error: mcpResourceBlockedError() });
      expect(host.modelContexts).toEqual([]);
      expect(host.sinks()).not.toContain("ordinary text");
      expect(host.sinks()).not.toContain("PRIVATE KEY");
    });

    test("a failed resource read reaches the log and store only as the fixed read error", async () => {
      const host = createHost(ai);
      const outcome = await mcp.sanitizeResourceRead(({ signal }) =>
        connection.readResource("test://rpc-error", signal as AbortSignal | undefined),
      );
      expect(outcome).toEqual({ outcome: "read_error" });
      expect(await host.deliverResource(outcome)).toEqual({ error: mcpResourceReadError() });
      expect(host.sinks().includes(TOKEN)).toBe(false);
    });

    test("a cancelled resource read delivers nothing to any sink", async () => {
      const host = createHost(ai);
      const controller = new AbortController();
      const pending = mcp.sanitizeResourceRead(
        ({ signal }) => connection.readResource("test://slow", signal as AbortSignal),
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 50);
      const outcome = await pending;
      expect(outcome).toEqual({ outcome: "aborted" });
      expect(await host.deliverResource(outcome)).toBeNull();
      expect(host.log).toEqual([]);
      expect(host.store.size).toBe(0);
    });

    test("a cancelled call delivers nothing to any sink", async () => {
      const host = createHost(ai);
      const controller = new AbortController();
      const pending = mcp.sanitizeToolCall(
        ({ signal }) => connection.callTool({ name: "slow-stream" }, signal as AbortSignal),
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 50);
      const outcome = await pending;
      expect(outcome).toEqual({ outcome: "aborted" });
      expect(await host.deliver(outcome)).toBeNull();
      expect(host.log).toEqual([]);
      expect(host.store.size).toBe(0);
      expect(host.modelContexts).toEqual([]);
    });
  },
);

describe("streamed tool output from a real subprocess", () => {
  test("a secret split across pipe writes is redacted and released once, then logged, stored and placed", async () => {
    const host = createHost(ai);
    const half = TOKEN.length / 2;
    const child = subprocess(["subprocess stdout: API_KEY=", TOKEN.slice(0, half), TOKEN.slice(half), "\ndone\n"]);
    const outcome = await mcp.sanitizeStreamedToolResult(child.stdout);
    expect(outcome).toMatchObject({
      outcome: "ok",
      value: { content: [{ type: "text", text: "subprocess stdout: API_KEY=<SECRET_1>\ndone\n" }] },
    });
    await host.deliver(outcome);
    expect(host.sinks().includes(TOKEN)).toBe(false);
    child.kill();
  });

  test.each([
    [
      "a block finding",
      [
        "ordinary\n",
        `-----BEGIN PRIVATE KEY-----\nU1lOVEhFVElDX1JFVk9LRURfQ09ORk9STUFOQ0U=\n-----END PRIVATE KEY-----\n`,
      ],
    ],
    ["the incremental input limit", Array.from({ length: 40 }, () => "ordinary text\n".repeat(22))],
  ])("%s stops reading the pipe, destroys it, and every sink gets only the fixed result", async (_name, pieces) => {
    const host = createHost(ai);
    const child = subprocess([...pieces, `late ${TOKEN}`], { linger: true });
    const outcome = await mcp.sanitizeStreamedToolResult(child.stdout);
    expect(outcome.outcome).toBe("blocked");
    expect(child.stdout.destroyed).toBe(true);
    expect(await host.deliver(outcome)).toEqual(mcpBlockedResult());
    expect(host.sinks().includes(TOKEN)).toBe(false);
    child.kill();
  });

  test("a cancelled subprocess stream delivers nothing and closes the pipe", async () => {
    const host = createHost(ai);
    const child = subprocess(["first piece\n"], { linger: true });
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 100);
    const outcome = await mcp.sanitizeStreamedToolResult(child.stdout, { signal: controller.signal });
    expect(outcome).toEqual({ outcome: "aborted" });
    expect(await host.deliver(outcome)).toBeNull();
    expect(child.stdout.destroyed).toBe(true);
    expect(host.log).toEqual([]);
    child.kill();
  });
});

test("failing audit and telemetry sinks never changed an outcome, and audit held only allowlisted fields", () => {
  expect(audits.length).toBeGreaterThan(0);
  for (const record of audits) {
    for (const key of Object.keys(record)) expect(["stage", "outcome", "reason", "code"]).toContain(key);
  }
  expect(new Set(audits.map((record) => record.stage))).toEqual(new Set(["result", "resource"]));
  expect(JSON.stringify(audits).includes(TOKEN)).toBe(false);
});
