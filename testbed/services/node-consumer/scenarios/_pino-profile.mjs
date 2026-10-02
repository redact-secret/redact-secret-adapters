/**
 * One PII configuration of pino, run in its own process by the pino.pii-* scenarios (#194).
 * Activation is process-wide and one-shot, so each profile (and the conflict case) gets a
 * fresh process. Sources: examples/policy-js/index.mjs (#181). Prints one JSON object with the
 * final destination bytes and the counts; the parent asserts on them.
 */

import { createRedactingHooks } from "@redact-secret/adapter-pino";
import pino from "pino";

const TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000";
const EMAIL = "jane.doe@acme-corp.io";
const PASSWORD = "hunter2hunter2";
const SAMPLE = `token ${TOKEN}; customer email: ${EMAIL}; password=${PASSWORD}`;

// An explicit core policy replaces the built-in one for EVERY finding (examples/policy-js).
const explicitPolicy = { evaluate: (finding) => (finding.type === "private_key" ? "block" : "redact") };
const CONFIGURATIONS = {
  default: {},
  pii: { pii: ["pii:global"] },
  policy: { pii: ["pii:global"], policy: explicitPolicy },
};

const name = process.argv[2];
if (name === "conflict") {
  // Adapter-first activation, then a different selection: must reject, not run with PII off.
  await createRedactingHooks({ pii: ["pii:global"] });
  let rejected = false;
  let code = null;
  let leaksSelector = false;
  try {
    await createRedactingHooks({ pii: [] });
  } catch (err) {
    rejected = true;
    code = typeof err?.code === "string" ? err.code : null;
    leaksSelector = String(err?.message).includes("pii:global");
  }
  process.stdout.write(JSON.stringify({ rejected, code, leaksSelector }));
} else if (CONFIGURATIONS[name]) {
  let counts;
  let out = "";
  const hooks = await createRedactingHooks({
    ...CONFIGURATIONS[name],
    onOutcome: (o) => {
      counts = o.values;
    },
  });
  const log = pino({ base: null, timestamp: false, hooks }, { write: (t) => (out += t) });
  log.info(SAMPLE);
  process.stdout.write(JSON.stringify({ line: out.trimEnd(), counts }));
} else {
  process.exit(2);
}
