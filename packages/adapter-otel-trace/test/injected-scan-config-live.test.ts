/**
 * An injected `scanConfig` through every live factory of this package
 * (redact-secret-adapters#213): a loose scan option beside it is rejected
 * with a fixed, input-free error before the core is touched, and the injected
 * configuration is the one verified against the installed core.
 */

import { CoreOptionsError, resolveScanConfig } from "@redact-secret/adapter";
import { expect, test } from "vitest";

import { createRedactingSpanProcessor } from "../src/index.js";

const FACTORIES = [createRedactingSpanProcessor] as const;
const next = { onStart() {}, onEnd() {}, onEmit() {}, shutdown: async () => {}, forceFlush: async () => {} };
const CONFLICTS = [
  { policy: { evaluate: () => "warn" as const } },
  { actionPolicy: '{"version":1,"rules":[]}' },
  { scanLimits: { maxInputBytes: 64, maxFindings: 3 } },
  { ruleset: "r" },
  { placeholderFormatter: () => "[x]" },
];

test("every live factory rejects a loose scan option beside an injected scanConfig, with a fixed message", async () => {
  const scanConfig = resolveScanConfig({});
  for (const factory of FACTORIES) {
    for (const conflict of CONFLICTS) {
      const error = await (factory as (...args: never[]) => Promise<unknown>)(
        ...([next, { scanConfig, ...conflict }] as never[]),
      ).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error, Object.keys(conflict)[0]).toBeInstanceOf(TypeError);
      expect((error as Error).message).toBe(
        "scanConfig already fixes the scan options: do not pass policy, actionPolicy, scanLimits, ruleset or placeholderFormatter with it",
      );
    }
  }
});

test("an injected scanConfig is the one verified against the core: a ruleset it rejects fails construction", async () => {
  const scanConfig = resolveScanConfig({ ruleset: "this is not a ruleset" });
  for (const factory of FACTORIES) {
    const error = await (factory as (...args: never[]) => Promise<unknown>)(
      ...([next, { scanConfig }] as never[]),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(CoreOptionsError);
    expect((error as CoreOptionsError).code).toBe("CORE_OPTION_REJECTED");
  }
});

test("a scanConfig that resolveScanConfig did not build is rejected by every live factory", async () => {
  for (const factory of FACTORIES) {
    const error = await (factory as (...args: never[]) => Promise<unknown>)(
      ...([next, { scanConfig: { options: {}, requested: [] } }] as never[]),
    ).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(TypeError);
  }
});
