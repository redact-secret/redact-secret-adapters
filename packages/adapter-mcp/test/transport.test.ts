/**
 * The adapter with real MCP SDK instances of both supported lines, over
 * both supported transports (stdio in a child process, Streamable HTTP on
 * 127.0.0.1), on the real core. CI runs this file at both endpoints of every
 * declared SDK range (`range-endpoints`); the installed versions and the
 * negotiated protocol revision are printed and asserted.
 *
 * - The pinned MCP fixture is replayed over the wire at the authoritative
 *   placement: a raw server returns each case's result, and the host applies
 *   the boundary to what its SDK client parsed.
 * - Opt-in argument sanitation happens before dispatch: a blocked argument
 *   set never reaches the server.
 * - The server-side (preventive) wrappers: streamed fixture cases, argument
 *   sanitation, a throwing `registerTool` handler caught before the SDK
 *   converts its message, and cancellation that delivers nothing.
 */

import * as core from "@redact-secret/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { createMcpBoundary, type McpBoundary, type McpOutcome, toCallToolResult } from "../src/index.js";
import { createAdapterBoundary, loadMcpFixture, type McpFixtureCase, type RunnerOptions } from "./conformance.js";
import {
  CLAIMED_PROTOCOLS,
  type Connection,
  connect,
  LINES,
  type Line,
  lineVersions,
  TRANSPORTS,
  type TransportKind,
} from "./sdk/harness.js";
import { CONTROL_MARKER, LIMITS } from "./sdk/servers.mjs";

const fixture = loadMcpFixture();
const SECRETS = [...new Set(fixture.cases.flatMap((c) => c.secrets ?? []))];

const POLICIES: Record<string, () => unknown> = {
  default: () => undefined,
  "block-all": () => ({ evaluate: () => "block" }),
  throwing: () => ({
    evaluate: () => {
      throw new Error("synthetic policy failure");
    },
  }),
};

function boundaryFor(testCase: McpFixtureCase, events: unknown[] = []): McpBoundary {
  const options: RunnerOptions = {
    ...LIMITS,
    policy: POLICIES[testCase.policy ?? "default"]?.(),
    binaryContent: testCase.binaryContent ?? "block",
    onFinding: (finding, context) => events.push({ finding, context }),
  };
  return createAdapterBoundary(core, options);
}

const observable = (value: unknown) => JSON.parse(JSON.stringify(value));

function expectNoSecret(value: unknown): void {
  const text = JSON.stringify(value) ?? "";
  for (const secret of SECRETS) expect(text.includes(secret)).toBe(false);
  expect(text.includes(CONTROL_MARKER)).toBe(false);
}

async function stats(connection: Connection): Promise<Record<string, number>> {
  const result = (await connection.callTool({ name: "stats" })) as { content: { text: string }[] };
  return JSON.parse(result.content[0]?.text ?? "{}");
}

beforeAll(async () => {
  await core.initialize();
});

describe.each(LINES.flatMap((line) => TRANSPORTS.map((transport) => [line, transport] as const)))(
  "SDK %s over %s",
  (line: Line, transport: TransportKind) => {
    let connection: Connection;
    let mcpServer: Connection;

    beforeAll(async () => {
      connection = await connect(line, transport, "low-level");
      mcpServer = await connect(line, transport, "mcp-server");
      console.log(
        `adapter-mcp: ${line} ${JSON.stringify(lineVersions(line))} over ${transport}, protocol ${connection.protocolVersion}`,
      );
    }, 60_000);

    afterAll(async () => {
      await connection?.close();
      await mcpServer?.close();
    });

    test("negotiates a claimed protocol revision", () => {
      expect(CLAIMED_PROTOCOLS).toContain(connection.protocolVersion);
      expect(CLAIMED_PROTOCOLS).toContain(mcpServer.protocolVersion);
    });

    test("host placement: every fixture result, carried by the SDK, reaches the contract's outcome", async () => {
      let replayed = 0;
      const refusedBySdk: string[] = [];
      for (const [index, testCase] of fixture.cases.entries()) {
        if (testCase.result === undefined || (testCase.phase ?? "initialized") !== "initialized") continue;
        if (testCase.signal !== undefined) continue;
        const events: unknown[] = [];
        const mcp = boundaryFor(testCase, events);
        const outcome = await mcp.sanitizeToolCall(({ signal }) =>
          connection.callTool({ name: `replay:${index}` }, signal as AbortSignal | undefined),
        );
        if (outcome.outcome === "tool_error" && testCase.expected.outcome !== "tool_error") {
          // The server SDK refused the malformed result (its result schema)
          // and answered with a JSON-RPC error, so the call rejected before
          // the boundary ran. That is still fail-closed, and it is allowed
          // only where the contract itself blocks the shape as unsupported.
          expect(testCase.expected, testCase.id).toEqual({ outcome: "blocked", reason: "unsupported_value" });
          await expect(connection.callTool({ name: `replay:${index}` }), testCase.id).rejects.toBeDefined();
          refusedBySdk.push(testCase.id);
        } else {
          expect(observable(outcome), testCase.id).toEqual(testCase.expected);
        }
        const delivered = toCallToolResult(outcome);
        if (!testCase.valueMayContainSecrets) expectNoSecret(delivered);
        expectNoSecret(events);
        replayed += 1;
      }
      console.log(
        `adapter-mcp: ${line} over ${transport}: ${replayed} results replayed, refused by the server SDK: ${refusedBySdk.join(", ") || "none"}`,
      );
      expect(refusedBySdk.length).toBeLessThan(replayed / 2);
      expect(replayed).toBe(
        fixture.cases.filter(
          (c) => c.result !== undefined && (c.phase ?? "initialized") === "initialized" && c.signal === undefined,
        ).length,
      );
    }, 60_000);

    test("host placement: a JSON-RPC error from the server is tool_error, its message never read", async () => {
      const mcp = await createMcpBoundary(LIMITS);
      const outcome = await mcp.sanitizeToolCall(({ signal }) =>
        connection.callTool({ name: "rpc-error" }, signal as AbortSignal | undefined),
      );
      expect(outcome).toEqual({ outcome: "tool_error" });
      expect(toCallToolResult(outcome)).toEqual(fixture.fixedResults.toolError);
    });

    test("opt-in arguments: sanitized before dispatch; a non-ok outcome is never dispatched", async () => {
      for (const testCase of fixture.cases.filter((c) => c.operation === "toolArguments")) {
        const mcp = boundaryFor(testCase);
        const before = (await stats(connection)).echoCalls ?? 0;
        const outcome: McpOutcome<unknown> = await mcp.sanitizeToolCall(
          ({ signal, arguments: args }) =>
            connection.callTool(
              args === undefined ? { name: "echo-args" } : { name: "echo-args", arguments: args },
              signal as AbortSignal | undefined,
            ),
          { arguments: testCase.arguments },
        );
        const after = (await stats(connection)).echoCalls ?? 0;
        if (testCase.expected.outcome === "ok") {
          expect(after, testCase.id).toBe(before + 1);
          expect(outcome.outcome, testCase.id).toBe("ok");
          const echoed = (outcome as { value: { content: { text: string }[] } }).value.content[0]?.text;
          expect(JSON.parse(echoed ?? ""), testCase.id).toEqual(testCase.expected.value ?? null);
        } else {
          expect(after, testCase.id).toBe(before);
          expect(observable(outcome), testCase.id).toEqual(testCase.expected);
        }
        expectNoSecret(toCallToolResult(outcome));
      }
    });

    test("server placement: every streamed fixture case, served by wrapStreamedToolHandler, delivers its mapped result", async () => {
      let replayed = 0;
      for (const [index, testCase] of fixture.cases.entries()) {
        if (testCase.operation !== "streamedToolResult" || testCase.signal !== undefined) continue;
        if ((testCase.phase ?? "initialized") !== "initialized") continue;
        if ((testCase as { producer?: { abortBefore?: number } }).producer?.abortBefore !== undefined) continue;
        const received = await connection.callTool({ name: `wrapped-stream:${index}` });
        const expected = toCallToolResult(testCase.expected as McpOutcome<unknown>);
        expect(observable(received), testCase.id).toEqual(expected);
        expectNoSecret(received);
        replayed += 1;
      }
      expect(replayed).toBeGreaterThanOrEqual(4);
    });

    test("server placement: wrapped arguments are sanitized, and blocked arguments never reach the handler", async () => {
      const token = SECRETS[0] ?? "";
      const before = await stats(connection);
      const redacted = await connection.callTool({ name: "wrapped-args", arguments: { query: `API_KEY=${token}` } });
      expect(redacted).toEqual({ content: [{ type: "text", text: "arguments accepted" }] });
      const afterRedacted = await stats(connection);
      expect(afterRedacted.wrappedArgsCalls).toBe((before.wrappedArgsCalls ?? 0) + 1);
      expect(afterRedacted.lastWrappedArgs).toEqual({ query: "API_KEY=<SECRET_1>" });
      const blocked = await connection.callTool({
        name: "wrapped-args",
        arguments: { username: "deploy-bot", password: "synthetic-not-a-secret" },
      });
      expect(blocked).toEqual(fixture.fixedResults.blocked);
      expect((await stats(connection)).wrappedArgsCalls).toBe(afterRedacted.wrappedArgsCalls);
    });

    test("McpServer.registerTool: the wrapper sanitizes, and catches a throw before the SDK reads its message", async () => {
      const sanitized = await mcpServer.callTool({ name: "wrapped-result" });
      expect(sanitized).toEqual({ content: [{ type: "text", text: "deploy log\nAPI_KEY=<SECRET_1>" }] });
      const failed = await mcpServer.callTool({ name: "wrapped-throw" });
      expect(failed).toEqual(fixture.fixedResults.toolError);
      expectNoSecret(failed);
      // Control: unwrapped, the SDK itself puts the handler's message into the result text.
      const control = await mcpServer.callTool({ name: "unwrapped-throw" });
      expect(JSON.stringify(control)).toContain(CONTROL_MARKER);
    });

    test("cancellation: the host delivers nothing, and the server closes its producer and sends no response", async () => {
      const mcp = await createMcpBoundary(LIMITS);
      const controller = new AbortController();
      const before = await stats(connection);
      const sentBefore = connection.serverSent.length;
      const pending = mcp.sanitizeToolCall(
        ({ signal }) => connection.callTool({ name: "slow-stream" }, signal as AbortSignal),
        { signal: controller.signal },
      );
      // Let the request reach the server and the producer yield its first chunk.
      for (
        let i = 0;
        i < 100 && ((await stats(connection)).slowStreamPulled ?? 0) < (before.slowStreamPulled ?? 0) + 2;
        i++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      controller.abort();
      const outcome = await pending;
      expect(outcome).toEqual({ outcome: "aborted" });
      expect(toCallToolResult(outcome)).toBeNull();
      let closed = before.slowStreamClosed ?? 0;
      for (let i = 0; i < 100 && closed === (before.slowStreamClosed ?? 0); i++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        closed = (await stats(connection)).slowStreamClosed ?? 0;
      }
      expect(closed).toBe((before.slowStreamClosed ?? 0) + 1);
      if (transport === "http") {
        const texts = connection.serverSent.slice(sentBefore).map((message) => JSON.stringify(message));
        expect(texts.some((text) => text.includes("This MCP tool call") || text.includes("first chunk"))).toBe(false);
      }
    });
  },
);
