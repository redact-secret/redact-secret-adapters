import { spawnSync } from "node:child_process";
import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";
import { createRedactingHooks } from "@redact-secret/adapter-pino";
import pino from "pino";

// Bundled synthetic sample: a credential, a PII value the core redacts at high confidence, and a
// credential-shaped value the core's default policy only warns about. None of them is real.
const TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000";
const EMAIL = "jane.doe@acme-corp.io";
const PASSWORD = "hunter2hunter2";
const SAMPLE = `token ${TOKEN}; customer email: ${EMAIL}; password=${PASSWORD}`;
const WARN_ONLY = `password=${PASSWORD}`; // a finding, but under the default policy no change

// snippet:start configurations
// An explicit core policy. It replaces the built-in one for EVERY finding, so keep `block` for the
// type the built-in policy blocks. This is an example choice, not a recommendation.
const explicitPolicy = {
  evaluate: (finding) => (finding.type === "private_key" ? "block" : "redact"),
};

const CONFIGURATIONS = {
  default: {}, // credentials only: PII stays off
  pii: { pii: ["pii:global"] }, // PII activated, the core's default policy
  policy: { pii: ["pii:global"], policy: explicitPolicy }, // PII activated, your policy
};
// snippet:end configurations

const NAMES = Object.keys(CONFIGURATIONS);

/** Runs inside a child process: activation is process-wide and one-shot, so each profile gets its own. */
async function runProfile(name) {
  const options = CONFIGURATIONS[name];

  // snippet:start ai-context
  const boundary = await createAiContextBoundary(options);
  const result = boundary.sanitizeText(SAMPLE, { boundary: "user-input" });
  // result.outcome === "ok": result.value is safe to use and result.findings says what the core decided.
  // `changed` is false when the value equals the input, even though findings were reported (a warn).
  // snippet:end ai-context
  const warnOnly = boundary.sanitizeText(WARN_ONLY, { boundary: "user-input" });
  if (result.outcome !== "ok" || warnOnly.outcome !== "ok") throw new Error("unexpected outcome");

  // snippet:start pino
  let counts;
  let line = "";
  const hooks = await createRedactingHooks({
    ...options,
    onOutcome: (outcome) => {
      counts = outcome.values;
    },
  });
  const logger = pino(
    { base: null, timestamp: false, hooks },
    {
      write(text) {
        line += text;
      },
    },
  );
  logger.info(SAMPLE);
  // counts: scanned, findings, redacted, blocked, limited, failed. No values, no finding details.
  // snippet:end pino

  process.stdout.write(
    JSON.stringify({
      value: result.value,
      changed: result.value !== SAMPLE,
      findings: result.findings.map((f) => `${f.type}/${f.confidence}/${f.action}`),
      warnOnly: {
        changed: warnOnly.value !== WARN_ONLY,
        findings: warnOnly.findings.map((f) => `${f.type}/${f.confidence}/${f.action}`),
      },
      counts,
      line: line.trimEnd(),
    }),
  );
}

function fail(message) {
  console.error(`FAIL: ${message}`);
  process.exit(1);
}

if (process.argv[2] !== undefined) {
  await runProfile(process.argv[2]);
} else {
  const results = {};
  for (const name of NAMES) {
    const child = spawnSync(process.execPath, [process.argv[1], name], { encoding: "utf-8" });
    if (child.status !== 0) fail(`the ${name} process did not finish`);
    results[name] = JSON.parse(child.stdout);
    const r = results[name];
    console.log(`== ${name} ==`);
    console.log(`ai-context  changed=${r.changed}  findings: ${r.findings.join(", ")}`);
    console.log(`            ${r.value}`);
    console.log(`warn-only   changed=${r.warnOnly.changed}  findings: ${r.warnOnly.findings.join(", ")}`);
    console.log(
      `pino        findings=${r.counts.findings} redacted=${r.counts.redacted} blocked=${r.counts.blocked} failed=${r.counts.failed}`,
    );
    console.log(`            ${r.line}`);
  }

  const has = (text, secret) => text.includes(secret);
  const surface = (r) => [r.value, r.line];
  for (const [name, r] of Object.entries(results)) {
    if (surface(r).some((text) => has(text, TOKEN))) fail(`${name}: the credential was not redacted`);
    if (r.counts.failed !== 0 || r.counts.blocked !== 0) fail(`${name}: an unexpected failure or block`);
  }
  // Default: credentials only. The email is untouched, the password is a reported warn.
  const d = results.default;
  if (!surface(d).every((t) => has(t, EMAIL) && has(t, PASSWORD)))
    fail("default: expected PII and the warn value to remain");
  if (!d.findings.includes("contextual_secret/medium/warn")) fail("default: the warn finding is missing");
  if (d.warnOnly.changed) fail("default: a warn-only input should come back unchanged");
  // PII on: the email is redacted at high confidence, the warn is still plaintext.
  const p = results.pii;
  if (surface(p).some((t) => has(t, EMAIL))) fail("pii: the high-confidence PII was not redacted");
  if (!surface(p).every((t) => has(t, PASSWORD))) fail("pii: the warn value should still be plaintext");
  if (!p.findings.includes("pii_global_email/high/redact")) fail("pii: the PII finding is missing");
  // Explicit policy: everything is masked.
  const x = results.policy;
  if (surface(x).some((t) => has(t, EMAIL) || has(t, PASSWORD))) fail("policy: a value was left unmasked");
  if (!x.findings.every((f) => f.endsWith("/redact"))) fail("policy: every finding should resolve to redact");
  if (!x.warnOnly.changed) fail("policy: the warn-only input should now be masked");

  console.log("OK: the three configurations differ as documented");
}
