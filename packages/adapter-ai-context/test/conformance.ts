/**
 * Replays the core's AI-context boundary fixture
 * (`fixtures/core/ai-context-boundary.json`, vendored at the commit recorded
 * in `fixtures/core/pins.json`) through this package's public API, the way
 * the core's reference runner (`conformance/ai-context-boundary.mjs`)
 * replays it through its reference model. An adapter qualifies by reaching
 * the same outcomes.
 *
 * Failure messages name a case ID and a field only, never an input, a
 * value, or a matched secret.
 */

import { readFileSync } from "node:fs";

import {
  type AiContextBoundary,
  type AiContextCore,
  type AiContextOutcome,
  BLOCK_REASONS,
  type ContextPart,
  createAiContextBoundaryWith,
  SAFE_FINDING_FIELDS,
} from "../src/index.js";

type Input = string | { repeat: string; count: number };

interface FixtureCase {
  id: string;
  operation: "sanitizeText" | "sanitizeValue" | "buildContext" | "stream";
  boundary?: "user-input" | "tool-result" | "context";
  phase?: "initialized" | "uninitialized";
  runtimes?: string[];
  policy?: "default" | "block-all" | "throwing";
  telemetry?: "throwing";
  signal?: "aborted-before";
  input?: Input;
  value?: unknown;
  parts?: ContextPart[];
  steps?: { op: "append" | "abort" | "signal" | "finalize"; chunk?: Input }[];
  secrets?: string[];
  valueMayContainSecrets?: boolean;
  incrementalEquivalence?: boolean;
  expected: unknown;
}

export interface Fixture {
  schemaVersion: number;
  limits: {
    wholeInput: { maxInputBytes: number; maxFindings: number };
    incremental: { maxInputBytes: number; maxBufferedBytes: number; maxTokenBytes: number; maxMultilineBytes: number };
    traversal: { maxDepth: number; maxNodes: number };
  };
  safeFindingFields: string[];
  blockReasons: string[];
  cases: FixtureCase[];
}

export function loadFixture(): Fixture {
  return JSON.parse(readFileSync(new URL("../../../fixtures/core/ai-context-boundary.json", import.meta.url), "utf-8"));
}

function materialize(input: Input | undefined): string {
  if (typeof input === "string") return input;
  if (input && typeof input.repeat === "string") return input.repeat.repeat(input.count);
  throw new Error("ai-context-boundary fixture: unsupported input form");
}

function materializeValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && typeof (value as { construct?: unknown }).construct === "string") {
    const spec = value as { construct: string; count?: number; item?: unknown; key?: string; repeat?: string };
    if (spec.construct === "array-of-strings") return Array.from({ length: spec.count ?? 0 }, () => spec.item);
    if (spec.construct === "non-plain-object") return { when: new Date(0) };
    if (spec.construct === "string-under-key") return { [spec.key ?? ""]: (spec.repeat ?? "").repeat(spec.count ?? 0) };
    if (spec.construct === "cycle") {
      const node: Record<string, unknown> = { label: "ordinary text" };
      node.self = node;
      return node;
    }
    throw new Error("ai-context-boundary fixture: unsupported construct");
  }
  return value;
}

const POLICIES = {
  default: () => undefined,
  "block-all": () => ({ evaluate: () => "block" as const }),
  throwing: () => ({
    evaluate: (): never => {
      throw new Error("synthetic policy failure");
    },
  }),
};

function fail(caseId: string, field: string): never {
  throw new Error(`ai-context-boundary ${caseId}: ${field}`);
}

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const observable = (outcome: unknown) => JSON.parse(JSON.stringify(outcome));

interface TelemetryEvent {
  finding: Record<string, unknown>;
  context: Record<string, unknown>;
}

function checkNoLeak(testCase: FixtureCase, outcome: AiContextOutcome<unknown>, events: TelemetryEvent[]): void {
  const metadata = JSON.stringify({ ...outcome, value: undefined }) + JSON.stringify(events);
  const value = outcome.outcome === "ok" ? JSON.stringify(outcome.value) : "";
  for (const secret of testCase.secrets ?? []) {
    if (metadata.includes(secret)) fail(testCase.id, "a secret reached outcome metadata or telemetry");
    if (!testCase.valueMayContainSecrets && value.includes(secret))
      fail(testCase.id, "a secret reached the safe value");
  }
  for (const event of events) {
    if (!sameJson(Object.keys(event.finding).sort(), [...SAFE_FINDING_FIELDS].sort())) {
      fail(testCase.id, "telemetry finding carries non-contract fields");
    }
    if (!sameJson(Object.keys(event.context), ["boundary"])) {
      fail(testCase.id, "telemetry context carries non-contract fields");
    }
  }
  if (outcome.outcome !== "ok" && ("value" in outcome || "findings" in outcome)) {
    fail(testCase.id, "a non-ok outcome carries a value or findings");
  }
  if (outcome.outcome === "blocked" && !(BLOCK_REASONS as readonly string[]).includes(outcome.reason)) {
    fail(testCase.id, "unknown block reason");
  }
}

function isValidStringBoundary(input: string, index: number): boolean {
  if (index <= 0 || index >= input.length) return true;
  const before = input.charCodeAt(index - 1);
  const after = input.charCodeAt(index);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export interface ConformanceSummary {
  cases: number;
  partitions: number;
  telemetryEvents: number;
}

/**
 * Replays every fixture case for `phase` against `core` through
 * `createAiContextBoundaryWith`, and returns a count-only summary. Throws
 * on the first divergence.
 */
export function runConformance(
  core: AiContextCore,
  fixture: Fixture,
  phase: "initialized" | "uninitialized",
): ConformanceSummary {
  if (fixture.schemaVersion !== 1) throw new Error("ai-context-boundary fixture: unsupported schema");
  if (!sameJson(fixture.safeFindingFields, SAFE_FINDING_FIELDS)) {
    throw new Error("ai-context-boundary fixture: safe finding fields diverge from the package");
  }
  if (!sameJson(fixture.blockReasons, BLOCK_REASONS)) {
    throw new Error("ai-context-boundary fixture: block reasons diverge from the package");
  }
  const summary: ConformanceSummary = { cases: 0, partitions: 0, telemetryEvents: 0 };
  const incremental = fixture.limits.incremental;

  for (const testCase of fixture.cases) {
    if (testCase.runtimes && !testCase.runtimes.includes("javascript")) continue;
    if ((testCase.phase ?? "initialized") !== phase) continue;
    const events: TelemetryEvent[] = [];
    const makeBoundary = (): AiContextBoundary =>
      createAiContextBoundaryWith(core, {
        wholeInputLimits: fixture.limits.wholeInput,
        incrementalLimits: {
          maxInputCodeUnits: incremental.maxInputBytes,
          maxBufferedCodeUnits: incremental.maxBufferedBytes,
          maxTokenCodeUnits: incremental.maxTokenBytes,
          maxMultilineCodeUnits: incremental.maxMultilineBytes,
        },
        traversalLimits: fixture.limits.traversal,
        policy: POLICIES[testCase.policy ?? "default"](),
        onFinding: (finding, context) => {
          events.push({ finding: { ...finding }, context: { ...context } });
          if (testCase.telemetry === "throwing") throw new Error("synthetic telemetry failure");
        },
      });
    const boundary = makeBoundary();
    const signal = { aborted: testCase.signal === "aborted-before" };

    if (testCase.operation === "stream") {
      const stream = boundary.openStream({ boundary: testCase.boundary, signal });
      const outcomes: AiContextOutcome<string>[] = [];
      for (const step of testCase.steps ?? []) {
        if (step.op === "append") stream.append(materialize(step.chunk));
        else if (step.op === "abort") stream.abort();
        else if (step.op === "signal") signal.aborted = true;
        else if (step.op === "finalize") outcomes.push(stream.finalize());
        else fail(testCase.id, "unknown step");
      }
      if (!sameJson(outcomes.map(observable), testCase.expected)) fail(testCase.id, "stream outcomes");
      for (const outcome of outcomes) checkNoLeak(testCase, outcome, events);
    } else {
      let outcome: AiContextOutcome<unknown>;
      if (testCase.operation === "sanitizeText") {
        outcome = boundary.sanitizeText(materialize(testCase.input), { boundary: testCase.boundary, signal });
      } else if (testCase.operation === "sanitizeValue") {
        outcome = boundary.sanitizeValue(materializeValue(testCase.value), { boundary: testCase.boundary, signal });
      } else if (testCase.operation === "buildContext") {
        outcome = boundary.buildContext(testCase.parts ?? [], { signal });
      } else {
        fail(testCase.id, "unknown operation");
      }
      if (!sameJson(observable(outcome), testCase.expected)) fail(testCase.id, "outcome");
      checkNoLeak(testCase, outcome, events);

      // Whole-input / incremental equivalence: the staged stream outcome for
      // every two-chunk partition (sampled for a long input), and one chunk
      // per UTF-16 unit, equals the whole-input outcome.
      if (
        testCase.operation === "sanitizeText" &&
        testCase.incrementalEquivalence !== false &&
        testCase.signal === undefined
      ) {
        const input = materialize(testCase.input);
        const partitions: string[][] = [];
        const step = input.length <= 256 ? 1 : Math.ceil(input.length / 64);
        for (let index = 0; index <= input.length; index += 1) {
          const sampled = index % step === 0 || index === input.length;
          if (sampled && isValidStringBoundary(input, index))
            partitions.push([input.slice(0, index), input.slice(index)]);
        }
        if (input.length <= 256) partitions.push(Array.from(input));
        for (const chunks of partitions) {
          const stream = makeBoundary().openStream({ boundary: testCase.boundary, signal: { aborted: false } });
          for (const chunk of chunks) stream.append(chunk);
          const streamed = stream.finalize();
          if (!sameJson(observable(streamed), testCase.expected)) {
            fail(testCase.id, "incremental outcome diverges from whole-input");
          }
          checkNoLeak(testCase, streamed, events);
          summary.partitions += 1;
        }
      }
    }
    summary.cases += 1;
    summary.telemetryEvents += events.length;
  }
  return summary;
}
