/**
 * Replays the core's MCP boundary fixture (`fixtures/core/mcp-boundary.json`)
 * with the core's own runner (`fixtures/core/mcp-boundary.mjs`), and its
 * `resources/read` fixture (`fixtures/core/mcp-resources-read.json`) with
 * `fixtures/core/mcp-resources-read.mjs`, all
 * vendored byte-for-byte at the commit recorded in `fixtures/core/pins.json`.
 * The runner takes the implementation under test through `createBoundary`:
 * here, this package's public API over `@redact-secret/adapter-ai-context`'s
 * public API. The runner's own reference model is never used.
 *
 * Failure messages come from the runner and name a case ID and a field only.
 */

import { readFileSync } from "node:fs";

import { type AiContextCore, createAiContextBoundaryWith } from "@redact-secret/adapter-ai-context";

import { createMcpBoundaryWith, type McpBoundary, type McpBoundaryOptions } from "../src/index.js";

const root = new URL("../../../", import.meta.url);

export interface McpFixtureCase {
  id: string;
  operation: "toolResult" | "toolArguments" | "toolCall" | "streamedToolResult";
  phase?: "initialized" | "uninitialized";
  policy?: string;
  signal?: string;
  binaryContent?: "block" | "pass";
  toolThrows?: boolean;
  result?: unknown;
  arguments?: unknown;
  secrets?: string[];
  valueMayContainSecrets?: boolean;
  expected: { outcome: string; value?: unknown; reason?: string; code?: string };
}

export interface McpFixture {
  schemaVersion: number;
  limits: {
    wholeInput: { maxInputBytes: number; maxFindings: number };
    incremental: { maxInputBytes: number; maxBufferedBytes: number; maxTokenBytes: number; maxMultilineBytes: number };
    traversal: { maxDepth: number; maxNodes: number };
  };
  fixedResults: { blocked: unknown; toolError: unknown };
  cases: McpFixtureCase[];
}

export interface RunnerOptions {
  wholeInputLimits: McpFixture["limits"]["wholeInput"];
  incrementalLimits: {
    maxInputCodeUnits: number;
    maxBufferedCodeUnits: number;
    maxTokenCodeUnits: number;
    maxMultilineCodeUnits: number;
  };
  traversalLimits: McpFixture["limits"]["traversal"];
  policy?: unknown;
  binaryContent: "block" | "pass";
  onFinding: (finding: unknown, context: unknown) => void;
}

interface RunnerModule {
  runMcpBoundaryConformance(
    api: AiContextCore,
    fixture: McpFixture,
    options: { phase: string; createBoundary: (api: AiContextCore, options: RunnerOptions) => unknown },
  ): Promise<{ cases: number; pulledChunks: number; telemetryEvents: number }>;
}

export function loadMcpFixture(): McpFixture {
  return JSON.parse(readFileSync(new URL("fixtures/core/mcp-boundary.json", root), "utf-8"));
}

export async function loadRunner(): Promise<RunnerModule> {
  // A computed specifier: the vendored runner is plain ESM with no types.
  const specifier = new URL("fixtures/core/mcp-boundary.mjs", root).href;
  return (await import(specifier)) as RunnerModule;
}

/** The implementation under test: this package's public API, built exactly as a host builds it. */
export function createAdapterBoundary(
  api: AiContextCore,
  options: RunnerOptions,
  extra: Omit<McpBoundaryOptions, "binaryContent"> = {},
): McpBoundary {
  const { binaryContent, ...aiContext } = options;
  const aiBoundary = createAiContextBoundaryWith(api, aiContext as Parameters<typeof createAiContextBoundaryWith>[1]);
  return createMcpBoundaryWith(aiBoundary, { binaryContent, ...extra });
}

export interface ResourceFixtureCase {
  id: string;
  operation: "resourceResult" | "resourceRead";
  phase?: "initialized" | "uninitialized";
  policy?: string;
  signal?: string;
  binaryContent?: "block" | "pass";
  readThrows?: boolean;
  result?: unknown;
  secrets?: string[];
  valueMayContainSecrets?: boolean;
  expected: { outcome: string; value?: unknown; reason?: string; code?: string };
}

export interface ResourceFixture {
  schemaVersion: number;
  label: string;
  limits: McpFixture["limits"];
  fixedErrors: { blocked: { code: number; message: string }; readError: { code: number; message: string } };
  cases: ResourceFixtureCase[];
}

interface ResourceRunnerModule {
  runMcpResourcesReadConformance(
    api: AiContextCore,
    fixture: ResourceFixture,
    options: { phase: string; createBoundary: (api: AiContextCore, options: RunnerOptions) => unknown },
  ): Promise<{ cases: number; reads: number; telemetryEvents: number }>;
}

/** A fixture value of the form `{ repeat, count }` materialized, as the core runner does. */
export function materialize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(materialize);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 2 && typeof record.repeat === "string" && Number.isInteger(record.count)) {
      return record.repeat.repeat(record.count as number);
    }
    return Object.fromEntries(keys.map((key) => [key, materialize(record[key])]));
  }
  return value;
}

export function loadResourceFixture(): ResourceFixture {
  return JSON.parse(readFileSync(new URL("fixtures/core/mcp-resources-read.json", root), "utf-8"));
}

export async function loadResourceRunner(): Promise<ResourceRunnerModule> {
  const specifier = new URL("fixtures/core/mcp-resources-read.mjs", root).href;
  return (await import(specifier)) as ResourceRunnerModule;
}
