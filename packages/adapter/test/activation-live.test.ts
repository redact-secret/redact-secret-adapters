/**
 * Core activation through every live factory, against the **real installed
 * core** (redact-secret/redact-secret-adapters#57).
 *
 * `activation.test.ts` covers `activateCore` with an injected core, and each
 * host package covers its own factory with `vi.mock`. Neither can cover this,
 * for the reason those files give: the core's PII selection cell is one-shot
 * per process, so a single vitest worker can exercise exactly one ordering
 * against a real core. That left a hole — a live factory that stopped routing
 * through `activateCore` failed nothing — and `createMaskSecrets` was sitting
 * in it, still calling a bare `initialize()` after #51 fixed the other four.
 *
 * So each case runs in a fresh `node` process, the way
 * `python/tests/test_pii_activation.py` does. One ordering per process is the
 * only honest way to cover a one-shot, process-wide selection.
 *
 * These import the built `dist/`, not `src/`: a spawned plain `node` does not
 * resolve TypeScript. CI runs `npm run build` before `npm test` in both the
 * `node` and `range-endpoints` jobs, which is what makes that safe.
 *
 * Every value here is synthetic. `ghp_` + 36 characters is the shape of a
 * GitHub token, not a token; no credential, revoked or otherwise, appears in
 * this file.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const ROOT = new URL("../../../", import.meta.url);
const SECRET = `ghp_${"S".repeat(6)}YNTHETIC${"0".repeat(22)}`;

/** Absolute `file:` URL of a built entry point, for a spawned process. */
const dist = (pkg: string) => new URL(`packages/${pkg}/dist/index.js`, ROOT).href;
const CORE = new URL("node_modules/@redact-secret/core/dist/index.js", ROOT).href;

/**
 * Runs `body` in a fresh interpreter and returns its stdout. A non-zero exit
 * fails the case with the child's stderr, which is where an unexpected
 * activation rejection shows up.
 */
function run(body: string): string {
  try {
    return execFileSync(process.execPath, ["--input-type=module", "-e", body], {
      cwd: fileURLToPath(ROOT),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    const stderr = (error as { stderr?: string }).stderr ?? "";
    throw new Error(`probe failed:\n${stderr}`);
  }
}

/**
 * Whether the installed core exposes the opt-in PII activation API. It
 * arrived in `0.1.0-beta.10`, and the declared range still starts at
 * `0.1.0-beta.6` — deliberately, since a factory that passes no selectors
 * needs nothing newer. CI installs both ends, so at the lowest end the PII
 * cases have no behaviour to pin and skipping is the honest outcome. The
 * ordering-independent case below still runs at both ends.
 */
const PII_API =
  run(`
  const core = await import(${JSON.stringify(CORE)});
  console.log(typeof core.piiActivation === "function" && typeof core.initialize === "function");
`) === "true";

/** Every live factory, driven far enough to prove activation actually ran. */
const FACTORIES: readonly { name: string; build: string; probe: string }[] = [
  {
    name: "@redact-secret/adapter createMaskSecrets",
    build: `const { createMaskSecrets } = await import(${JSON.stringify(dist("adapter"))});
            const made = await createMaskSecrets(OPTIONS);`,
    probe: `console.log(JSON.stringify(made({ v: SECRET })).includes(SECRET) ? "LEAKED" : "MASKED");`,
  },
  {
    name: "@redact-secret/adapter-pino createRedactingHooks",
    build: `const { createRedactingHooks } = await import(${JSON.stringify(dist("adapter-pino"))});
            const made = await createRedactingHooks(OPTIONS);`,
    probe: `console.log(typeof made.logMethod === "function" && typeof made.streamWrite === "function" ? "MASKED" : "LEAKED");`,
  },
  {
    name: "@redact-secret/adapter-otel createRedactingSpanProcessor",
    build: `const { createRedactingSpanProcessor } = await import(${JSON.stringify(dist("adapter-otel"))});
            const next = { onStart() {}, onEnd() {}, shutdown: async () => {}, forceFlush: async () => {} };
            const made = await createRedactingSpanProcessor(next, OPTIONS);`,
    probe: `console.log(typeof made.onEnd === "function" ? "MASKED" : "LEAKED");`,
  },
  {
    name: "@redact-secret/adapter-ai-context createAiContextBoundary",
    build: `const { createAiContextBoundary } = await import(${JSON.stringify(dist("adapter-ai-context"))});
            const made = await createAiContextBoundary(OPTIONS);`,
    // This factory never rejects: an activation failure would show up as
    // every operation failing closed, so the outcome is the assertion.
    probe: `const r = made.sanitizeText(SECRET);
            console.log(r.outcome === "blocked" ? "LEAKED" : (JSON.stringify(r).includes(SECRET) ? "LEAKED" : "MASKED"));`,
  },
  {
    name: "@redact-secret/adapter-mcp createMcpBoundary",
    build: `const { createMcpBoundary } = await import(${JSON.stringify(dist("adapter-mcp"))});
            const made = await createMcpBoundary(OPTIONS);`,
    probe: `const r = made.sanitizeToolResult({ content: [{ type: "text", text: SECRET }] });
            console.log(r.outcome === "blocked" ? "LEAKED" : (JSON.stringify(r).includes(SECRET) ? "LEAKED" : "MASKED"));`,
  },
];

const preamble = (options: string, before = "") => `
  const SECRET = ${JSON.stringify(SECRET)};
  const OPTIONS = ${options};
  ${before}
`;

test.each(FACTORIES)("$name masks a synthetic secret against the real core", ({ build, probe }) => {
  expect(run(`${preamble("{}")}\n${build}\n${probe}`)).toBe("MASKED");
});

test.skipIf(!PII_API).each(FACTORIES)("$name survives an application that activated PII first", ({ build, probe }) => {
  const before = `
      const core = await import(${JSON.stringify(CORE)});
      await core.initialize({ pii: ["pii:global"] });
    `;
  // The regression this exists for: a factory calling a bare initialize()
  // rejects here with PII_ACTIVATION_CONFLICT, and run() reports it.
  expect(run(`${preamble("{}", before)}\n${build}\n${probe}`)).toBe("MASKED");
});

test.skipIf(!PII_API).each(FACTORIES)("$name activates PII itself when asked", ({ build, probe }) => {
  const script = `${preamble('{ pii: ["pii:global"] }')}
    ${build}
    const core = await import(${JSON.stringify(CORE)});
    if (!core.piiActivation().includes("pii:global")) throw new Error("selection not active");
    ${probe}`;
  expect(run(script)).toBe("MASKED");
});

test.skipIf(!PII_API)("a selection the core cannot honour is refused, without echoing it", () => {
  const script = `${preamble('{ pii: ["pii:global"] }')}
    const core = await import(${JSON.stringify(CORE)});
    await core.initialize({ pii: [] });
    const { createMaskSecrets } = await import(${JSON.stringify(dist("adapter"))});
    try {
      await createMaskSecrets(OPTIONS);
      console.log("NOT_REFUSED");
    } catch (error) {
      const message = String(error && error.message);
      console.log([
        error.code ?? error.name,
        message.includes("pii:global") ? "LEAKS_SELECTOR" : "no-selector",
        message.includes(SECRET) ? "LEAKS_INPUT" : "no-input",
      ].join(" "));
    }`;
  expect(run(script)).toBe("PII_ACTIVATION_NOT_ACTIVE no-selector no-input");
});
