/**
 * Browser entry (#195), bundled by esbuild (platform browser, ESM) from the
 * INSTALLED @redact-secret/adapter-ai-context and @redact-secret/core. It runs
 * the shared synthetic cases in a real browser and exposes only fixed-shape
 * results on window.__aictx for the Playwright spec. No network, no model:
 * the only fetches are the core's own same-origin .wasm assets.
 *
 *   /?pii=0            PII off
 *   /?pii=1            PII on (selector pii:global)
 *   /?pii=0&late=1     PII off first, then a late PII request: must fail closed
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
  TINY_OPTIONS,
} from "../contract/aictx-cases.mjs";

const query = new URLSearchParams(globalThis.location?.search ?? "");
const pii = query.get("pii") === "1";
const late = query.get("late") === "1";
const activation = pii ? { pii: ["pii:global"] } : {};
const result = { done: false, pii, late, status: "running" };
globalThis.__aictx = result;

try {
  const boundary = await createAiContextBoundary({ ...SHARED_OPTIONS, ...activation });
  const tiny = await createAiContextBoundary({ ...TINY_OPTIONS, ...activation });
  result.artifact = artifact();
  const cases = runSharedCases(boundary);
  const behavior = runBehaviorCases(boundary, tiny);
  result.digests = digestCases(cases);
  result.behavior = behavior;
  result.failures = [
    ...checkSharedCases(cases, pii),
    ...Object.entries(behavior)
      .filter(([, ok]) => !ok)
      .map(([k]) => `behavior: ${k}`),
  ];
  // The Unicode and key-aware outputs themselves (redacted text; the address only when PII is off).
  result.samples = {
    text: cases.text.v,
    keyAware: cases.keyAware.map((k) => k.v),
    emailExposed: cases.email.v.includes(SYNTHETIC_EMAIL),
  };
  if (late) {
    const lateBoundary = await createAiContextBoundary({ ...SHARED_OPTIONS, pii: ["pii:global"] });
    const o = brief(lateBoundary.sanitizeText(`customer email: ${SYNTHETIC_EMAIL} please`));
    const s = lateBoundary.openStream();
    result.late = { outcome: o.o, reason: o.r, accepting: s.accepting };
  }
  result.status = "ok";
} catch (err) {
  result.status = "error";
  result.errorName = String(err?.name ?? "Error").slice(0, 60);
}
result.done = true;
