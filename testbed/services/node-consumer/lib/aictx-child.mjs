/**
 * One PII configuration of the AI-context boundary, in its own process (#195).
 * PII activation is process-wide and one-shot, so every configuration (and
 * every deliberate misuse of the init order) gets a fresh process. Spawned by
 * scenarios/aictx.mjs with a fixed profile name; prints one JSON line made of
 * briefs and hashes only (no raw sample value), and nothing else.
 *
 *   node lib/aictx-child.mjs <default|pii|policy|pii-first|late-pii|bad-pii>
 */

import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";
import { artifact } from "@redact-secret/core";
import {
  brief,
  checkSharedCases,
  digestCases,
  runBehaviorCases,
  runSharedCases,
  SHARED_OPTIONS,
  SYNTHETIC_EMAIL,
  SYNTHETIC_PEM,
  SYNTHETIC_TOKEN,
  TINY_OPTIONS,
} from "../contract/aictx-cases.mjs";

const profile = process.argv[2];
const PII = ["pii:global"];
const WARN_ONLY = "password=hunter2hunter2";
// An explicit core policy replaces the built-in one for EVERY finding (examples/policy-js).
const explicitPolicy = { evaluate: (finding) => (finding.type === "private_key" ? "block" : "redact") };

const out = { profile };

async function shared(options, pii) {
  const boundary = await createAiContextBoundary({ ...SHARED_OPTIONS, ...options });
  const cases = runSharedCases(boundary);
  const tiny = await createAiContextBoundary({ ...TINY_OPTIONS, ...options });
  const behavior = runBehaviorCases(boundary, tiny);
  const failures = [
    ...checkSharedCases(cases, pii),
    ...Object.entries(behavior)
      .filter(([, ok]) => !ok)
      .map(([k]) => `behavior: ${k}`),
  ];
  return { boundary, cases, digests: digestCases(cases), behavior, failures };
}

if (profile === "default") {
  const r = await shared({}, false);
  Object.assign(out, { digests: r.digests, behavior: r.behavior, failures: r.failures });
  out.warn = brief(r.boundary.sanitizeText(WARN_ONLY));
} else if (profile === "pii") {
  const r = await shared({ pii: PII }, true);
  Object.assign(out, { digests: r.digests, behavior: r.behavior, failures: r.failures });
  out.warn = brief(r.boundary.sanitizeText(WARN_ONLY));
} else if (profile === "policy") {
  const boundary = await createAiContextBoundary({ ...SHARED_OPTIONS, pii: PII, policy: explicitPolicy });
  out.email = brief(boundary.sanitizeText(`customer email: ${SYNTHETIC_EMAIL} please`));
  out.warn = brief(boundary.sanitizeText(WARN_ONLY));
  out.token = brief(boundary.sanitizeText(`x ${SYNTHETIC_TOKEN}`));
  out.pem = brief(boundary.sanitizeText(SYNTHETIC_PEM));
} else if (profile === "pii-first") {
  // PII activated first; a later PII-less boundary shares that process-wide state.
  const a = await createAiContextBoundary({ ...SHARED_OPTIONS, pii: PII });
  const b = await createAiContextBoundary({ ...SHARED_OPTIONS });
  out.first = brief(a.sanitizeText(`customer email: ${SYNTHETIC_EMAIL} please`));
  out.second = brief(b.sanitizeText(`customer email: ${SYNTHETIC_EMAIL} please`));
} else if (profile === "late-pii") {
  // Default first; asking for PII afterwards must fail closed, never silently switch on or stay off.
  const a = await createAiContextBoundary({ ...SHARED_OPTIONS });
  const b = await createAiContextBoundary({ ...SHARED_OPTIONS, pii: PII });
  out.first = brief(a.sanitizeText(`customer email: ${SYNTHETIC_EMAIL} please`));
  out.late = brief(b.sanitizeText(`customer email: ${SYNTHETIC_EMAIL} please`));
  const s = b.openStream();
  s.append("x");
  out.lateStream = { accepting: s.accepting, final: brief(s.finalize()) };
} else if (profile === "bad-pii") {
  // Initialization failure: an unknown selector. The factory resolves; every operation fails closed.
  const b = await createAiContextBoundary({ ...SHARED_OPTIONS, pii: ["pii:not-a-selector"] });
  out.text = brief(b.sanitizeText(`x ${SYNTHETIC_TOKEN}`));
  out.value = brief(b.sanitizeValue({ api_key: "x" }));
  out.context = brief(b.buildContext([{ role: "user", text: "x" }]));
  const s = b.openStream();
  out.stream = { accepting: s.accepting, final: brief(s.finalize()) };
} else {
  process.exit(64);
}
try {
  out.artifact = artifact(); // valid once a boundary has initialized the core
} catch {
  out.artifact = null; // initialization failed
}
process.stdout.write(`${JSON.stringify(out)}\n`);
