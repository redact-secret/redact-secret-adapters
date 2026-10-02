/**
 * Shared synthetic cases for the AI-context server and browser consumers
 * (#195). Pure boundary calls: no Node built-in, no file or network access, so
 * the same module runs in a server child process and inside the esbuild
 * browser bundle. It exercises the installed boundary (consumer integration);
 * it is not a detector oracle, and the core stays authoritative.
 *
 * Every secret-shaped value is built from fixed synthetic parts. Results are
 * briefs: outcome, redacted text, fixed labels and finding ranges. A result
 * never carries a sentinel, because only redacted outputs are recorded.
 */

export const SYNTHETIC_TOKEN = `ghp_SYNTHETICREVOKED${"0".repeat(20)}`;
export const SYNTHETIC_EMAIL = "jane.doe@acme-corp.io";
export const SYNTHETIC_PEM =
  "-----BEGIN PRIVATE KEY-----\nU1lOVEhFVElDX1JFVk9LRURfQ09ORk9STUFOQ0U=\n-----END PRIVATE KEY-----";
export const SYNTHETIC_KEYED = "synthetic-example-value-0001";

/** Explicit limits so the limit case is deterministic and identical on every lane. */
export const SHARED_OPTIONS = Object.freeze({
  wholeInputLimits: { maxInputBytes: 4096, maxFindings: 16 },
  incrementalLimits: {
    maxInputCodeUnits: 16384,
    maxBufferedCodeUnits: 2176,
    maxTokenCodeUnits: 1024,
    maxMultilineCodeUnits: 2048,
  },
  traversalLimits: { maxDepth: 4, maxNodes: 64 },
});

/** A bounded, value-free summary of an outcome. */
export function brief(outcome) {
  if (outcome.outcome === "ok") {
    return {
      o: "ok",
      v: outcome.value,
      f: outcome.findings.map((f) => `${f.type}/${f.confidence}/${f.action}@${f.start}-${f.end}`),
    };
  }
  const b = { o: outcome.outcome };
  if (outcome.reason !== undefined) b.r = outcome.reason;
  if (outcome.code !== undefined) b.c = outcome.code;
  return b;
}

/**
 * Runs the shared cases against a boundary built with SHARED_OPTIONS.
 * The stream text has an astral emoji, so a split inside its surrogate pair is
 * the one boundary the core refuses (UNPAIRED_SURROGATE) on every lane.
 */
export function runSharedCases(boundary) {
  const streamText = `progress 1\nAPI_KEY=${SYNTHETIC_TOKEN}\n\u{1F680} done\n`;
  const whole = brief(boundary.sanitizeText(streamText));
  const splits = { total: 0, identical: 0, refusedAt: [], other: 0 };
  for (let i = 0; i <= streamText.length; i += 1) {
    const stream = boundary.openStream({ boundary: "tool-result" });
    stream.append(streamText.slice(0, i));
    stream.append(streamText.slice(i));
    const out = brief(stream.finalize());
    splits.total += 1;
    if (JSON.stringify(out) === JSON.stringify(whole)) splits.identical += 1;
    else if (out.o === "blocked" && out.c === "UNPAIRED_SURROGATE") splits.refusedAt.push(i);
    else splits.other += 1;
  }
  return {
    text: brief(boundary.sanitizeText(`토큰 ${SYNTHETIC_TOKEN} \u{1F680} 끝`)),
    keyAware: [
      brief(boundary.sanitizeValue({ api_key: SYNTHETIC_KEYED })),
      brief(boundary.sanitizeValue({ name: SYNTHETIC_KEYED })),
      brief(boundary.sanitizeValue({ client_secret: "한국어-가짜-비밀번호-1234" })),
    ],
    email: brief(boundary.sanitizeText(`customer email: ${SYNTHETIC_EMAIL} please`)),
    whole,
    splits,
    limit: brief(boundary.sanitizeText("ordinary text\n".repeat(400))),
    blocked: brief(boundary.sanitizeValue({ deep: { pem: SYNTHETIC_PEM } })),
  };
}

/**
 * The parity-relevant expectations both lanes must meet, as fixed-label
 * failures ([] when all hold). `pii` is whether PII was activated.
 */
export function checkSharedCases(r, pii) {
  const bad = [];
  const need = (ok, label) => {
    if (!ok) bad.push(label);
  };
  need(r.text.o === "ok" && /^토큰 <SECRET_\d+> \u{1F680} 끝$/u.test(r.text.v), "unicode text redacted");
  const [apiKey, benign, korean] = r.keyAware;
  need(apiKey.o === "ok" && apiKey.v?.api_key === "<SECRET_1>", "key-aware: api_key value redacted");
  need(benign.o === "ok" && benign.v?.name === SYNTHETIC_KEYED, "key-aware: benign key left alone");
  need(korean.o === "ok" && korean.v?.client_secret === "<SECRET_1>", "key-aware: Korean value under secret key");
  const exposed = r.email.o === "ok" && r.email.v.includes(SYNTHETIC_EMAIL);
  need(pii ? !exposed : exposed, pii ? "PII on redacts the address" : "PII off leaves the address");
  need(r.whole.o === "ok" && r.whole.v.includes("API_KEY=<SECRET_1>"), "whole-input redaction");
  need(
    r.splits.other === 0 && r.splits.refusedAt.length === 1,
    "every split equals whole or is the one surrogate refusal",
  );
  need(r.splits.identical === r.splits.total - 1, "all other splits are identical to whole-input");
  need(r.limit.o === "blocked" && r.limit.r === "limit_exceeded", "limit_exceeded");
  need(r.blocked.o === "blocked" && r.blocked.r === "policy", "private key blocks");
  return bad;
}

/** cyrb53: a small synchronous string hash (not cryptographic) so parity can be compared without recording values. */
function cyrb53(text) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/** One short hash per shared case, for server/browser parity. Outputs may hold PII-off text, so values are never recorded. */
export function digestCases(r) {
  return {
    text: cyrb53(JSON.stringify(r.text)),
    keyAware: cyrb53(JSON.stringify(r.keyAware)),
    email: cyrb53(JSON.stringify(r.email)),
    whole: cyrb53(JSON.stringify(r.whole)),
    splits: cyrb53(JSON.stringify(r.splits)),
    limit: cyrb53(JSON.stringify(r.limit)),
    blocked: cyrb53(JSON.stringify(r.blocked)),
  };
}

/**
 * Lifecycle and outcome behaviors both lanes must show, as fixed-label
 * booleans. `tiny` is a second boundary built with TINY_OPTIONS (same PII
 * configuration). The stub downstream is an in-memory array: only ok.value is
 * ever pushed, which is what the final check inspects.
 */
export const TINY_OPTIONS = Object.freeze({
  wholeInputLimits: { maxInputBytes: 64, maxFindings: 4 },
  incrementalLimits: {
    maxInputCodeUnits: 4096,
    maxBufferedCodeUnits: 2176,
    maxTokenCodeUnits: 1024,
    maxMultilineCodeUnits: 2048,
  },
  traversalLimits: { maxDepth: 3, maxNodes: 6 },
});

export function runBehaviorCases(boundary, tiny) {
  const downstream = [];
  const forward = (o) => {
    if (o.outcome === "ok") downstream.push(typeof o.value === "string" ? o.value : JSON.stringify(o.value));
  };
  const r = {};
  const ok = boundary.sanitizeText(`deploy ${SYNTHETIC_TOKEN}`);
  r.ok = ok.outcome === "ok" && ok.value === "deploy <SECRET_1>";
  forward(ok);
  const blocked = boundary.sanitizeText(SYNTHETIC_PEM);
  r.blockedPolicy = blocked.outcome === "blocked" && blocked.reason === "policy" && !("value" in blocked);
  forward(blocked);
  const ac = new AbortController();
  ac.abort();
  const aborted = boundary.sanitizeText(`x ${SYNTHETIC_TOKEN}`, { signal: ac.signal });
  r.aborted = aborted.outcome === "aborted" && !("value" in aborted);
  forward(aborted);
  const unsupported = boundary.sanitizeValue({ a: () => 1 });
  r.unsupportedValue = unsupported.outcome === "blocked" && unsupported.reason === "unsupported_value";
  forward(unsupported);
  const warn = boundary.sanitizeText("password=hunter2hunter2");
  r.warnUnchanged =
    warn.outcome === "ok" && warn.value === "password=hunter2hunter2" && warn.findings[0]?.action === "warn";
  const limited = tiny.sanitizeText("a".repeat(65));
  r.inputLimit = limited.outcome === "blocked" && limited.reason === "limit_exceeded";
  const deep = tiny.sanitizeValue({ a: { b: { c: { d: 1 } } } });
  r.traversalLimit = deep.outcome === "blocked" && deep.reason === "limit_exceeded";
  forward(limited);
  forward(deep);

  const text = `line one\nAPI_KEY=${SYNTHETIC_TOKEN}\n\u{1F680} done\n`;
  const s = boundary.openStream();
  const chunks = [text.slice(0, 20), text.slice(20, 35), text.slice(35, 50), text.slice(50)];
  let released = 0;
  let stillAccepting = true;
  for (const c of chunks) {
    if (s.append(c) !== undefined) released += 1;
    stillAccepting = stillAccepting && s.accepting;
  }
  r.noProgressiveRelease = released === 0 && stillAccepting && downstream.length === 1;
  const fin = s.finalize();
  r.finalizeOk = fin.outcome === "ok" && fin.value === boundary.sanitizeText(text).value && s.accepting === false;
  forward(fin);
  const again = s.finalize();
  r.secondFinalizeLifecycle = again.outcome === "blocked" && again.reason === "lifecycle";
  const a = boundary.openStream();
  a.append(`x ${SYNTHETIC_TOKEN}`);
  a.abort();
  r.abortStopsAccepting = a.accepting === false && a.finalize().outcome === "aborted";

  const chunksPem = [
    "ok\n",
    "-----BEGIN PRIVATE KEY-----\n",
    "U1lOVEhFVElDX1JFVk9LRURfQ09ORk9STUFOQ0U=\n",
    "-----END PRIVATE KEY-----\n",
    "tail\n",
  ];
  const p = boundary.openStream();
  let pulled = 0;
  for (const c of chunksPem) {
    if (!p.accepting) break;
    pulled += 1;
    p.append(c);
  }
  const pf = p.finalize();
  r.producerStopsOnBlock =
    p.accepting === false && pulled < chunksPem.length && pf.outcome === "blocked" && pf.reason === "policy";
  forward(pf);

  const joined = downstream.join("\n");
  r.onlyOkValueForwarded =
    downstream.length === 2 && !joined.includes(SYNTHETIC_TOKEN) && !joined.includes("BEGIN PRIVATE KEY");
  return r;
}
