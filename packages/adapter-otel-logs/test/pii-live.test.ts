/**
 * PII off and on, through the live factory, a real `LoggerProvider` and the
 * **real installed core**, down to the serialized OTLP bytes
 * (redact-secret/redact-secret-adapters#178).
 *
 * The core's PII selection is one-shot and process-wide, so each case runs in
 * a fresh `node` process, as `packages/adapter/test/activation-live.test.ts`
 * does. These import the built `dist/`, not `src/`; `vitest.global-setup.ts`
 * builds every package before the suite runs.
 *
 * The value is a synthetic address on a made-up domain. With PII off the core
 * detects credentials only, so it must pass through untouched: that is the
 * documented default, and asserting it keeps "PII off" from being read as a
 * bug. With PII on, the same value is redacted before it reaches the bytes.
 */

import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

const ROOT = new URL("../../../", import.meta.url);
const EMAIL = "jane.doe@acme-corp.io";
const CORE = new URL("node_modules/@redact-secret/core/dist/index.js", ROOT).href;
const dist = new URL("packages/adapter-otel-logs/dist/index.js", ROOT).href;

function run(body: string): string {
  try {
    return execFileSync(process.execPath, ["--input-type=module", "-e", body], {
      cwd: fileURLToPath(ROOT),
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    throw new Error(`probe failed:\n${(error as { stderr?: string }).stderr ?? ""}`);
  }
}

const PII_API =
  run(`
  const core = await import(${JSON.stringify(CORE)});
  console.log(typeof core.piiActivation === "function" && typeof core.initialize === "function");
`) === "true";

/** Emits one record through the live factory and prints the OTLP-shaped fields an exporter would send. */
function emitScript(options: string, before = ""): string {
  return `
    const { LoggerProvider, SimpleLogRecordProcessor } = await import("@opentelemetry/sdk-logs");
    const { createRedactingLogRecordProcessor } = await import(${JSON.stringify(dist)});
    ${before}
    const records = [];
    const exporter = {
      export(batch, done) { records.push(...batch.map((r) => ({ body: r.body, attributes: { ...r.attributes } }))); done({ code: 0 }); },
      shutdown: async () => {}, forceFlush: async () => {},
    };
    // Simple takes (exporter) at the low end of the SDK range and ({ exporter }) at the high end.
    const probe = new SimpleLogRecordProcessor({ exporter });
    const next = probe._exporter === exporter ? probe : new SimpleLogRecordProcessor(exporter);
    const redacting = await createRedactingLogRecordProcessor(next, ${options});
    // addLogRecordProcessor through 0.202, the \`processors\` option from 0.201: use the option only where the method is gone.
    let provider = new LoggerProvider();
    if (typeof provider.addLogRecordProcessor === "function") provider.addLogRecordProcessor(redacting);
    else provider = new LoggerProvider({ processors: [redacting] });
    provider.getLogger("pii-live").emit({ body: ${JSON.stringify(`customer email: ${EMAIL} please`)}, attributes: { note: ${JSON.stringify(`email: ${EMAIL}`)}, user_email: ${JSON.stringify(EMAIL)} } });
    await new Promise((resolve) => setImmediate(resolve));
    console.log(JSON.stringify(records));
  `;
}

test("PII off (the default): a credentials-only core leaves an email address alone", () => {
  const records = JSON.parse(run(emitScript("{}")));
  expect(records[0].body).toBe(`customer email: ${EMAIL} please`);
  expect(records[0].attributes.note).toBe(`email: ${EMAIL}`);
});

test.skipIf(!PII_API)("PII on, asked for by the factory: the address is redacted in body and attribute", () => {
  const records = JSON.parse(run(emitScript('{ pii: ["pii:global"] }')));
  expect(records[0].body).toMatch(/^customer email: <SECRET_\d+> please$/);
  expect(records[0].attributes.note).toMatch(/^email: <SECRET_\d+>$/);
  // The core's email detector needs context in the same string. An attribute whose
  // KEY says "email" and whose value is a bare address is not detected, because the
  // adapter scans values and never keys (README, "PII detection").
  expect(records[0].attributes.user_email).toBe(EMAIL);
});

test.skipIf(!PII_API)(
  "PII on, activated by the application first: the factory accepts it and the address is redacted",
  () => {
    const before = `
    const core = await import(${JSON.stringify(CORE)});
    await core.initialize({ pii: ["pii:global"] });
  `;
    const records = JSON.parse(run(emitScript("{}", before)));
    expect(records[0].body).toMatch(/^customer email: <SECRET_\d+> please$/);
  },
);
