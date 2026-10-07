/**
 * The declarative `actionPolicy` at the AI-context boundary
 * (redact-secret-adapters#217) over a recording fake core: it is validated
 * against a callback `policy` and snapshotted once at construction, and the one
 * snapshot goes to every whole-input scan and every incremental session. The
 * boundary does not read the document: the core decides. The real-core replay
 * is `action-policy-live.test.ts`.
 */

import { describe, expect, test } from "vitest";

import { actionPolicyForms } from "../../../fixtures/action-policy.js";
import { fakeScanAndRedact } from "../../../fixtures/fake-scanner.js";
import { type AiContextCore, createAiContextBoundaryWith, withDefaultLimits } from "../src/index.js";
import { LIMITS } from "./fake-core.js";

function recordingCore() {
  const scans: unknown[] = [];
  const sessions: unknown[] = [];
  const core = {
    scanAndRedact: (text: string, options?: unknown) => {
      scans.push(options);
      return fakeScanAndRedact(text);
    },
    createIncrementalSanitizer: (options: unknown) => {
      sessions.push(options);
      let staged = "";
      return {
        state: "accepting" as const,
        append: (chunk: string) => {
          staged += chunk;
          return { text: "", findings: [] };
        },
        finalize: () => fakeScanAndRedact(staged),
        abort: () => undefined,
      };
    },
  };
  return { core: core as unknown as AiContextCore, scans, sessions };
}

const JSON_TEXT = JSON.stringify(actionPolicyForms("warn").object);

describe("the snapshot and what reaches the core", () => {
  test.each([
    ["an object", () => actionPolicyForms("warn").object, JSON_TEXT],
    ["UTF-8 text", () => JSON_TEXT, JSON_TEXT],
  ] as const)("%s reaches every whole-input scan and every session unchanged", (_form, make, expected) => {
    const { core, scans, sessions } = recordingCore();
    const boundary = createAiContextBoundaryWith(core, { ...LIMITS, actionPolicy: make() });
    boundary.sanitizeText("plain");
    boundary.sanitizeValue({ a: "plain", b: ["plain"] });
    const stream = boundary.openStream();
    stream.append("plain");
    stream.finalize();
    expect(scans.length).toBeGreaterThanOrEqual(3);
    for (const options of [...scans, ...sessions]) {
      expect((options as { actionPolicy?: unknown }).actionPolicy).toBe(expected);
    }
    expect(sessions).toHaveLength(1);
  });

  test("bytes are copied: clobbering the caller's buffer, or mutating the object, after construction changes nothing", () => {
    const { core, scans, sessions } = recordingCore();
    const bytes = actionPolicyForms("warn").bytes.slice();
    const object = structuredClone(actionPolicyForms("warn").object);
    const fromBytes = createAiContextBoundaryWith(core, { ...LIMITS, actionPolicy: bytes });
    const fromObject = createAiContextBoundaryWith(core, { ...LIMITS, actionPolicy: object });
    bytes.fill(0);
    (object.rules[0] as { action: string }).action = "block";
    fromBytes.sanitizeText("plain");
    fromObject.sanitizeText("plain");
    fromObject.openStream();
    expect(new TextDecoder().decode((scans[0] as { actionPolicy: Uint8Array }).actionPolicy)).toBe(JSON_TEXT);
    expect((scans[1] as { actionPolicy: string }).actionPolicy).toBe(JSON_TEXT);
    expect((sessions[0] as { actionPolicy: string }).actionPolicy).toBe(JSON_TEXT);
  });

  test("without an actionPolicy the options carry no such key, as before", () => {
    const { core, scans, sessions } = recordingCore();
    const boundary = createAiContextBoundaryWith(core, { ...LIMITS, policy: { evaluate: () => "redact" } });
    boundary.sanitizeText("plain");
    boundary.openStream();
    for (const options of [...scans, ...sessions]) expect(Object.keys(options as object)).not.toContain("actionPolicy");
  });

  test("an actionPolicy reaching the options through a prototype is kept", () => {
    const { core, scans } = recordingCore();
    const layered = Object.create({ actionPolicy: JSON_TEXT }) as object;
    createAiContextBoundaryWith(core, withDefaultLimits(layered as never)).sanitizeText("plain");
    expect((scans[0] as { actionPolicy?: unknown }).actionPolicy).toBe(JSON_TEXT);
  });
});

describe("what is rejected at construction, before any scan", () => {
  test("a callback policy beside an actionPolicy, with a fixed message", () => {
    const { core, scans } = recordingCore();
    const options = { ...LIMITS, policy: { evaluate: () => "redact" as const }, actionPolicy: JSON_TEXT };
    expect(() => createAiContextBoundaryWith(core, options)).toThrow(
      new TypeError("createAiContextBoundary: policy and actionPolicy are mutually exclusive: pass one"),
    );
    expect(scans).toEqual([]);
  });

  test.each([42, true, null, { big: 1n }])(
    "a value that cannot be a document (%s) is a TypeError naming no value",
    (bad) => {
      const { core } = recordingCore();
      expect(() => createAiContextBoundaryWith(core, { ...LIMITS, actionPolicy: bad as never })).toThrow(
        /^createAiContextBoundary: actionPolicy must be/,
      );
    },
  );
});
