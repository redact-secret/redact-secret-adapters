/**
 * The scenario/result envelope and the fixed scenario-ID registry, Node side
 * (#192). Copied into the Node consumer image; the Python twin is
 * envelope.py and must stay in step (testbed/test checks both against
 * result.schema.json).
 *
 * A scenario is `{ id, title, classification, run(ctx, rec) }`. `run` records
 * assertions on `rec` and puts small, fixed-shape facts in `rec.evidence`.
 * `runScenario` turns that into the envelope: it bounds every string,
 * scrubs the registered sentinels, caps the evidence size, and turns a thrown
 * error into status "error" with a fixed code (never the error's message,
 * which could carry a value).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const RESULT_SCHEMA = "redact-secret-adapters/testbed-result-v1";
export const SCENARIO_ID = /^(smoke|pino|pylog|aictx|browser|ui)\.[a-z0-9]+(-[a-z0-9]+)*$/;
export const CLASSIFICATIONS = ["install-check", "qualification", "negative-control", "failure-injection"];
export const LIMITS = {
  assertions: 50,
  name: 120,
  detail: 240,
  message: 240,
  title: 200,
  evidenceBytes: 8192,
  comparisons: 12,
  comparisonValue: 100,
};
/** What a compared output demonstrates; the scenario UI renders each kind distinctly (#196). */
export const COMPARISON_KINDS = [
  "masking",
  "warn",
  "block",
  "limit",
  "init-failure",
  "cancellation",
  "stream",
  "policy",
  "other",
];

/** Sentinel patterns from every contract/sentinels.d/*.json. */
export function loadSentinels(contractDir) {
  const dir = join(contractDir, "sentinels.d");
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .flatMap((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")).patterns)
    .map((p) => new RegExp(p, "g"));
}

export function makeScrubber(sentinels) {
  return (value, max) => {
    let text = String(value);
    for (const re of sentinels) text = text.replace(re, "[SENTINEL]");
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
}

class Recorder {
  constructor(scrub) {
    this.scrub = scrub;
    this.assertions = [];
    this.evidence = {};
    this.status = null;
  }

  /** Records one assertion. `detail` (kept only for a failed check) must be a fixed label, never a value. */
  check(name, ok, detail) {
    if (this.assertions.length < LIMITS.assertions) {
      const entry = { name: this.scrub(name, LIMITS.name), ok: ok === true };
      if (detail !== undefined && ok !== true) entry.detail = this.scrub(detail, LIMITS.detail);
      this.assertions.push(entry);
    } else {
      this.overflow = true;
    }
    return ok === true;
  }

  /**
   * Records an expected-versus-actual pair for the scenario UI (#196) AND an assertion that they
   * are equal. Both values must be primitives that are safe to display: a sanitized output, a
   * placeholder, or a fixed label such as an outcome name. Never a raw input or a warn/negative-
   * control plaintext (use a label such as "unchanged" for those). Sentinels are scrubbed and long
   * values truncated, like every result string.
   *
   * Self-test fault \`wrong-expectation\` (testbed/run.mjs --fault) replaces every expected value
   * so the run must fail: it proves a wrong redaction expectation is caught.
   */
  compare(label, expected, actual, kind = "other") {
    const wrong = process.env.TESTBED_FAULT === "wrong-expectation";
    const want = wrong ? "[wrong expectation injected]" : expected;
    const show = (v) =>
      v === null || ["number", "boolean"].includes(typeof v)
        ? v
        : typeof v === "string"
          ? this.scrub(v, LIMITS.comparisonValue)
          : "[non-primitive]";
    const match = Object.is(want, actual);
    this.check(label, match, "expected and actual differ");
    this.comparisons ??= [];
    if (this.comparisons.length >= LIMITS.comparisons) {
      this.overflow = true;
      return match;
    }
    this.comparisons.push({
      label: this.scrub(label, LIMITS.name),
      kind: COMPARISON_KINDS.includes(kind) ? kind : "other",
      expected: show(want),
      actual: show(actual),
      match,
    });
    return match;
  }

  /** Marks the scenario as unsupported on this host. Recorded, never implied supported. */
  unsupported(reason) {
    this.status = "unsupported";
    this.check("supported", false, reason);
  }
}

export async function runScenario(def, host, ctx, scrub) {
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  const rec = new Recorder(scrub);
  let error;
  try {
    await def.run(ctx, rec);
  } catch (err) {
    error = { code: scrub(err?.name ?? "Error", 80), message: "scenario threw; message withheld" };
  }
  let status;
  if (error) status = "error";
  else if (rec.overflow) status = "error";
  else if (rec.status) status = rec.status;
  else status = rec.assertions.length > 0 && rec.assertions.every((a) => a.ok) ? "pass" : "fail";

  let evidence = rec.comparisons ? { ...rec.evidence, comparisons: rec.comparisons } : rec.evidence;
  const encoded = scrub(JSON.stringify(evidence), Number.MAX_SAFE_INTEGER);
  if (Buffer.byteLength(encoded) > LIMITS.evidenceBytes) {
    evidence = {};
    status = "error";
    error = { code: "evidence-too-large", message: `evidence exceeded ${LIMITS.evidenceBytes} bytes` };
  } else {
    evidence = JSON.parse(encoded);
  }
  const result = {
    schema: RESULT_SCHEMA,
    scenarioId: def.id,
    host,
    classification: def.classification,
    title: scrub(def.title, LIMITS.title),
    status,
    startedAt,
    durationMs: Date.now() - started,
    assertions: rec.assertions,
    evidence,
  };
  if (error) result.error = error;
  return result;
}

/**
 * Auto-discovers scenario modules in `dir` (every `*.mjs` not starting with `_`).
 * A module exports `scenarios`: an array of definitions. Each ID must match the
 * fixed pattern, sit in a namespace allowed for `host`, be unique, and appear in
 * the committed contract/ids/<namespace>.json list. A violation throws, which
 * fails service startup.
 */
export async function discoverScenarios(dir, host, contractDir) {
  const namespaces = JSON.parse(readFileSync(join(contractDir, "namespaces.json"), "utf-8")).namespaces;
  const fixed = new Set();
  for (const f of readdirSync(join(contractDir, "ids")).filter((x) => x.endsWith(".json"))) {
    for (const s of JSON.parse(readFileSync(join(contractDir, "ids", f), "utf-8")).scenarios)
      fixed.add(`${s.host}:${s.id}`);
  }
  const found = new Map();
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith(".mjs") && !f.startsWith("_"))
    .sort()) {
    const mod = await import(pathToFileURL(join(dir, file)).href);
    if (!Array.isArray(mod.scenarios)) throw new Error(`${file}: must export a 'scenarios' array`);
    for (const def of mod.scenarios) {
      const where = `${file}:${def?.id}`;
      if (typeof def?.id !== "string" || !SCENARIO_ID.test(def.id)) throw new Error(`${where}: invalid scenario id`);
      const ns = def.id.split(".")[0];
      if (!namespaces[ns]?.hosts.includes(host))
        throw new Error(`${where}: namespace '${ns}' is not allowed on host '${host}'`);
      if (!CLASSIFICATIONS.includes(def.classification)) throw new Error(`${where}: invalid classification`);
      if (typeof def.run !== "function" || typeof def.title !== "string")
        throw new Error(`${where}: needs title and run()`);
      if (!fixed.has(`${host}:${def.id}`)) throw new Error(`${where}: not listed in contract/ids/${ns}.json`);
      if (found.has(def.id)) throw new Error(`${where}: duplicate scenario id`);
      found.set(def.id, def);
    }
  }
  for (const key of fixed) {
    const [h, id] = [key.slice(0, key.indexOf(":")), key.slice(key.indexOf(":") + 1)];
    if (h === host && !found.has(id)) throw new Error(`${id}: listed in contract/ids but no module defines it`);
  }
  return found;
}
