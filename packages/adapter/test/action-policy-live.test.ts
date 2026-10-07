/**
 * The declarative `actionPolicy` through the real core, from a clean consumer's
 * point of view (redact-secret-adapters#217). Every decision is the core's: the
 * expected output is spelled out, and each case is also checked against what
 * the core itself returns for the same text and the same document, so the
 * adapter is shown to add nothing. CI runs this at both ends of the declared
 * core range: from the verified floor up the option is applied, and below it
 * the option is rejected explicitly while every legacy option still works.
 */

import * as core from "@redact-secret/core";
import { describe, expect, test } from "vitest";

import {
  actionPolicyForms,
  CORE_HAS_ACTION_POLICY,
  MALFORMED_MARKER,
  MALFORMED_POLICY,
  UNMATCHED_POLICY,
} from "../../../fixtures/action-policy.js";
import { SYNTHETIC_TOKEN } from "../../../fixtures/action-semantics.js";
import { CoreOptionsError, createMaskSecrets } from "../src/index.js";

const TEXT = `x ${SYNTHETIC_TOKEN} y`;
const BLOCKED = "[REDACTED:BLOCKED]";

/** What the core decides for `TEXT` under `actionPolicy`, mapped to a leaf the way the adapter's own rules do. */
function direct(actionPolicy: unknown): string {
  const result = core.scanAndRedact(TEXT, { actionPolicy } as never);
  return result.findings.some((finding) => finding.action === "block") ? BLOCKED : result.text;
}

describe.skipIf(!CORE_HAS_ACTION_POLICY)("a core with actionPolicy", () => {
  test.each([
    ["allow", TEXT],
    ["warn", TEXT],
    ["redact", "x <SECRET_1> y"],
    ["block", BLOCKED],
    // `default` keeps the core's own action for the finding, which is redact.
    ["default", "x <SECRET_1> y"],
  ] as const)(
    "%s, as an object, as UTF-8 text and as bytes, equals the core's own decision",
    async (action, expected) => {
      const forms = actionPolicyForms(action);
      for (const actionPolicy of [forms.object, forms.text, forms.bytes]) {
        const maskSecrets = await createMaskSecrets({ actionPolicy });
        expect(maskSecrets([TEXT, { nested: TEXT }])).toEqual([expected, { nested: expected }]);
        expect(maskSecrets([TEXT])).toEqual([direct(actionPolicy)]);
      }
    },
  );

  test("a finding no rule matches keeps the default action", async () => {
    const maskSecrets = await createMaskSecrets({ actionPolicy: UNMATCHED_POLICY });
    expect(maskSecrets([TEXT])).toEqual(["x <SECRET_1> y"]);
    expect(maskSecrets([TEXT])).toEqual([direct(UNMATCHED_POLICY)]);
  });

  test("an empty rule list is the default policy, as data", async () => {
    const maskSecrets = await createMaskSecrets({
      actionPolicy: { actionPolicyRevision: 1, base: "default", rules: [] },
    });
    expect(maskSecrets([TEXT])).toEqual(["x <SECRET_1> y"]);
  });

  test("it is a snapshot: mutating the object or clobbering the bytes after construction changes nothing", async () => {
    const forms = actionPolicyForms("warn");
    const object = structuredClone(forms.object);
    const fromObject = await createMaskSecrets({ actionPolicy: object });
    const bytes = forms.bytes.slice();
    const fromBytes = await createMaskSecrets({ actionPolicy: bytes });
    (object.rules[0] as { action: string }).action = "block";
    object.rules.length = 0;
    bytes.fill(0);
    expect(fromObject([TEXT])).toEqual([TEXT]);
    expect(fromBytes([TEXT])).toEqual([TEXT]);
    expect(fromObject({ api_key: TEXT })).toEqual({ api_key: TEXT });
  });

  test("a malformed policy rejects at construction with INVALID_ACTION_POLICY and nothing of the document", async () => {
    for (const actionPolicy of [
      MALFORMED_POLICY,
      new TextEncoder().encode(MALFORMED_POLICY),
      { actionPolicyRevision: 2 },
    ]) {
      const error = await createMaskSecrets({ actionPolicy }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(CoreOptionsError);
      const typed = error as CoreOptionsError;
      expect(typed.code).toBe("CORE_OPTION_REJECTED");
      expect(typed.coreCode).toBe("INVALID_ACTION_POLICY");
      expect(typed.options).toEqual(["actionPolicy"]);
      expect(JSON.stringify({ ...typed, message: typed.message })).not.toContain(MALFORMED_MARKER);
    }
  });

  test("a callback policy beside an actionPolicy is rejected before the core is touched", async () => {
    await expect(
      createMaskSecrets({ policy: { evaluate: () => "redact" }, actionPolicy: actionPolicyForms("warn").object }),
    ).rejects.toThrow("policy and actionPolicy are mutually exclusive");
  });

  test("the legacy options still work beside it, and PII stays off", async () => {
    const maskSecrets = await createMaskSecrets({
      actionPolicy: actionPolicyForms("redact").object,
      scanLimits: { maxInputBytes: 4096, maxFindings: 8 },
      placeholderFormatter: (finding, context) => `[${finding.type}#${context.placeholderIndex}]`,
    });
    expect(maskSecrets([TEXT, "mail user@example.invalid"])).toEqual([
      expect.stringMatching(/^x \[github_token#1\] y$/),
      "mail user@example.invalid",
    ]);
  });
});

describe.skipIf(CORE_HAS_ACTION_POLICY)("a core older than actionPolicy", () => {
  test("a requested actionPolicy is rejected by name, never ignored", async () => {
    for (const actionPolicy of Object.values(actionPolicyForms("block"))) {
      const error = await createMaskSecrets({ actionPolicy }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(CoreOptionsError);
      expect((error as CoreOptionsError).code).toBe("CORE_OPTION_UNSUPPORTED");
      expect((error as CoreOptionsError).options).toEqual(["actionPolicy"]);
    }
  });

  test("every legacy option, and the callback policy, still work", async () => {
    const maskSecrets = await createMaskSecrets({
      policy: { evaluate: () => "block" },
      scanLimits: { maxInputBytes: 4096, maxFindings: 8 },
    });
    expect(maskSecrets([TEXT])).toEqual([BLOCKED]);
    expect((await createMaskSecrets())([TEXT])).toEqual(["x <SECRET_1> y"]);
  });
});
