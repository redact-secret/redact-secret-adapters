/**
 * `resources/read` (redact-secret/redact-secret#843) with real MCP SDK
 * instances of both supported lines, over both supported transports, on the
 * real core. CI runs this file at both endpoints of every declared SDK range
 * (`range-endpoints`), like `transport.test.ts`.
 *
 * - Host placement: a raw server returns each pinned resource fixture case's
 *   result, and the host applies `sanitizeResourceRead` to what its SDK
 *   client parsed.
 * - A server JSON-RPC error carrying a synthetic secret is `read_error`,
 *   its message never read.
 * - Server placement: `wrapResourceReadHandler` on the low-level `Server`
 *   and on `McpServer.registerResource` (a fixed URI and a URI template)
 *   sends the sanitized result, or exactly the fixed JSON-RPC error, and
 *   catches a throwing callback before the SDK sends its message.
 * - Cancellation: the host delivers nothing, and the server sends nothing.
 */

import * as core from "@redact-secret/core";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import {
  createMcpBoundary,
  MCP_RESOURCE_BLOCKED_MESSAGE,
  MCP_RESOURCE_READ_ERROR_MESSAGE,
  type McpBoundary,
  toReadResourceResponse,
} from "../src/index.js";
import {
  createAdapterBoundary,
  loadResourceFixture,
  materialize,
  type ResourceFixtureCase,
  type RunnerOptions,
} from "./conformance.js";
import {
  type Connection,
  connect,
  LINES,
  type Line,
  lineVersions,
  TRANSPORTS,
  type TransportKind,
} from "./sdk/harness.js";
import { CONTROL_MARKER, LIMITS } from "./sdk/servers.mjs";

const fixture = loadResourceFixture();
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

function boundaryFor(testCase: ResourceFixtureCase, events: unknown[] = []): McpBoundary {
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

/** The JSON-RPC error a rejected `readResource` carried, as the client SDK exposes it. */
async function rejection(promise: Promise<unknown>): Promise<{ code: unknown; message: string }> {
  try {
    await promise;
  } catch (error) {
    const { code, message } = error as { code?: unknown; message?: unknown };
    return { code, message: String(message) };
  }
  throw new Error("expected the read to reject");
}

/** A result the SDK delivered, without fields the SDK itself adds (2.x cache hints). */
function withoutSdkFields(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value;
  const { ttlMs: _ttl, cacheScope: _scope, ...rest } = value as Record<string, unknown>;
  return rest;
}

/**
 * `actual` is `expected` with at most some object fields removed. The client
 * SDKs parse a `ReadResourceResult` with their own schema, which drops
 * unknown fields inside a `contents` entry: that only removes content, so
 * the boundary's claim holds, but the delivered value is smaller.
 */
function isSubset(actual: unknown, expected: unknown): boolean {
  if (Array.isArray(actual)) {
    return (
      Array.isArray(expected) && actual.length === expected.length && actual.every((v, i) => isSubset(v, expected[i]))
    );
  }
  if (actual !== null && typeof actual === "object") {
    if (expected === null || typeof expected !== "object" || Array.isArray(expected)) return false;
    const target = expected as Record<string, unknown>;
    return Object.entries(actual).every(([key, value]) => key in target && isSubset(value, target[key]));
  }
  return actual === expected;
}

/** Deep equality that ignores key order (the SDKs reorder `_meta`). */
const sameValue = (a: unknown, b: unknown) => isSubset(a, b) && isSubset(b, a);

/** Exactly the fixture's value, or (counted in `reshaped`) that value minus fields the SDK dropped. */
function expectDelivered(actual: unknown, testCase: ResourceFixtureCase, reshaped: string[]): void {
  const expected = materialize(testCase.expected.value);
  const received = withoutSdkFields(observable(actual));
  if (sameValue(received, expected)) return;
  expect(isSubset(received, expected), testCase.id).toBe(true);
  reshaped.push(testCase.id);
}

const replayable = (c: ResourceFixtureCase) =>
  c.operation === "resourceResult" &&
  c.result !== undefined &&
  (c.phase ?? "initialized") === "initialized" &&
  c.signal === undefined;

beforeAll(async () => {
  await core.initialize();
});

describe.each(LINES.flatMap((line) => TRANSPORTS.map((transport) => [line, transport] as const)))(
  "resources/read with SDK %s over %s",
  (line: Line, transport: TransportKind) => {
    let connection: Connection;
    let mcpServer: Connection;
    beforeAll(async () => {
      connection = await connect(line, transport, "low-level");
      mcpServer = await connect(line, transport, "mcp-server");
      console.log(
        `adapter-mcp resources/read: ${line} ${JSON.stringify(lineVersions(line))} over ${transport}, protocol ${connection.protocolVersion}`,
      );
    }, 60_000);
    afterAll(async () => {
      await connection?.close();
      await mcpServer?.close();
    });

    test("host placement: every fixture result, carried by the SDK, reaches the contract's outcome", async () => {
      let replayed = 0;
      const refusedBySdk: string[] = [];
      const reshaped: string[] = [];
      for (const [index, testCase] of fixture.cases.entries()) {
        if (!replayable(testCase)) continue;
        const events: unknown[] = [];
        const mcp = boundaryFor(testCase, events);
        let parsed: unknown;
        const outcome = await mcp.sanitizeResourceRead(async ({ signal }) => {
          parsed = await connection.readResource(`test://replay/${index}`, signal as AbortSignal | undefined);
          return parsed;
        });
        const sent = materialize(testCase.result);
        if (outcome.outcome === "read_error") {
          // The client SDK refused the malformed result (its result schema),
          // so the read rejected before the boundary ran. Still fail-closed,
          // and allowed only where the contract blocks the shape itself.
          expect(testCase.expected, testCase.id).toEqual({ outcome: "blocked", reason: "unsupported_value" });
          refusedBySdk.push(testCase.id);
        } else if (sameValue(withoutSdkFields(observable(parsed)), sent)) {
          // The SDK carried the result unchanged: the contract's own outcome.
          if (outcome.outcome === "ok") expectDelivered(outcome.value, testCase, []);
          else expect(observable(outcome), testCase.id).toEqual(testCase.expected);
        } else {
          // The client SDK's schema dropped fields (an unknown entry field,
          // the `blob` of an entry that also has `text`) before the host saw
          // the result. Only removal is allowed, and the host's outcome is
          // then exactly the contract's outcome for what it received.
          expect(isSubset(withoutSdkFields(observable(parsed)), sent), testCase.id).toBe(true);
          expect(observable(outcome), testCase.id).toEqual(
            observable(boundaryFor(testCase).sanitizeResourceResult(parsed)),
          );
          reshaped.push(testCase.id);
        }
        const delivered = toReadResourceResponse(outcome);
        if (!testCase.valueMayContainSecrets) expectNoSecret(delivered);
        expectNoSecret(events);
        replayed += 1;
      }
      console.log(
        `adapter-mcp resources/read: ${line} over ${transport}: ${replayed} results replayed, refused by the client SDK: ${refusedBySdk.join(", ") || "none"}, reshaped by the client SDK: ${reshaped.join(", ") || "none"}`,
      );
      expect(replayed).toBe(fixture.cases.filter(replayable).length);
      expect(refusedBySdk.length).toBeLessThan(replayed / 2);
      expect(reshaped.length).toBeLessThanOrEqual(3);
    }, 60_000);

    test("host placement: a JSON-RPC error from the server is read_error, its message never read", async () => {
      const mcp = await createMcpBoundary(LIMITS);
      // Control: unwrapped, the server SDK sends the thrown message.
      const control = await rejection(connection.readResource("test://rpc-error"));
      expect(control.message).toContain(CONTROL_MARKER);
      const outcome = await mcp.sanitizeResourceRead(({ signal }) =>
        connection.readResource("test://rpc-error", signal as AbortSignal | undefined),
      );
      expect(outcome).toEqual({ outcome: "read_error" });
      expect(toReadResourceResponse(outcome)).toEqual({ error: fixture.fixedErrors.readError });
    });

    test("server placement: wrapResourceReadHandler sends the sanitized result or exactly the fixed error", async () => {
      let replayed = 0;
      const reshaped: string[] = [];
      for (const [index, testCase] of fixture.cases.entries()) {
        if (!replayable(testCase) || (testCase.policy ?? "default") !== "default") continue;
        const read = connection.readResource(`test://wrapped/${index}`);
        if (testCase.expected.outcome === "ok") {
          const received = await read.catch(() => undefined);
          if (received === undefined) {
            // Only a shape the contract blocks may be refused by an SDK.
            throw new Error(`${testCase.id}: wrapped read rejected`);
          }
          expectDelivered(received, testCase, reshaped);
          if (!testCase.valueMayContainSecrets) expectNoSecret(received);
        } else {
          const error = await rejection(read);
          expect(error.code, testCase.id).toBe(fixture.fixedErrors.blocked.code);
          // The 2.x client exposes the server's message verbatim; the 1.x
          // client prefixes it with "MCP error <code>: ".
          expect(error.message.endsWith(MCP_RESOURCE_BLOCKED_MESSAGE), testCase.id).toBe(true);
          expectNoSecret(error);
        }
        replayed += 1;
      }
      expect(replayed).toBeGreaterThanOrEqual(20);
      expect(reshaped.length).toBeLessThanOrEqual(3);
    }, 60_000);

    test("server placement: a throwing read callback is caught before the SDK sends its message", async () => {
      const error = await rejection(connection.readResource("test://wrapped-throw"));
      expect(error.code).toBe(-32603);
      expect(error.message.endsWith(MCP_RESOURCE_READ_ERROR_MESSAGE)).toBe(true);
      expectNoSecret(error);
      if (transport === "http") {
        const sent = connection.serverSent.filter((message) => message?.error !== undefined).at(-1);
        expect(sent.error).toEqual(fixture.fixedErrors.readError);
      }
    });

    test("McpServer.registerResource: fixed URI and URI template callbacks are sanitized, a throw is caught", async () => {
      const env = await mcpServer.readResource("test://mcp/env");
      expect(withoutSdkFields(env)).toEqual({
        contents: [{ uri: "test://mcp/env", mimeType: "text/plain", text: "REGION=eu-west-1\nAPI_KEY=<SECRET_1>\n" }],
      });
      const config = await mcpServer.readResource("test://mcp/config/db");
      expect(withoutSdkFields(config)).toEqual({
        contents: [
          { uri: "test://mcp/config/db", mimeType: "application/json", text: '{"name":"db","password":"<SECRET_1>"}' },
        ],
        _meta: { password: "<SECRET_1>" },
      });
      const failed = await rejection(mcpServer.readResource("test://mcp/wrapped-throw"));
      expect(failed.code).toBe(-32603);
      expect(failed.message.endsWith(MCP_RESOURCE_READ_ERROR_MESSAGE)).toBe(true);
      expectNoSecret(failed);
      // Control: unwrapped, the SDK sends the callback's own message.
      const control = await rejection(mcpServer.readResource("test://mcp/unwrapped-throw"));
      expect(control.message).toContain(CONTROL_MARKER);
    });

    test("cancellation: the host delivers nothing, and the server sends no response", async () => {
      const mcp = await createMcpBoundary(LIMITS);
      const controller = new AbortController();
      const sentBefore = connection.serverSent.length;
      const pending = mcp.sanitizeResourceRead(
        ({ signal }) => connection.readResource("test://slow", signal as AbortSignal),
        { signal: controller.signal },
      );
      setTimeout(() => controller.abort(), 100);
      const outcome = await pending;
      expect(outcome).toEqual({ outcome: "aborted" });
      expect(toReadResourceResponse(outcome)).toBeNull();
      await new Promise((resolve) => setTimeout(resolve, 100));
      if (transport === "http") {
        const texts = connection.serverSent.slice(sentBefore).map((message) => JSON.stringify(message));
        expect(texts.some((text) => text.includes("This MCP resource read"))).toBe(false);
      }
    });
  },
);
