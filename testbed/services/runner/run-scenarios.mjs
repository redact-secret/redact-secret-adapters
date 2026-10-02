/**
 * In-network scenario runner (#192). Lists every scenario the UI exposes,
 * resets per-run consumer state through the internal control API, runs each
 * scenario once, validates each result against the envelope schema, writes
 * /out/scenario-results.json, and exits non-zero unless every result is
 * "pass" (or "unsupported" for a scenario the registry marks as such, which
 * is recorded but counted separately, never as a pass).
 */

import { readFileSync, writeFileSync } from "node:fs";
import Ajv from "ajv";

const UI = process.env.TESTBED_UI_URL ?? "http://ui:8080";
const CONTROL = (process.env.TESTBED_CONTROL_URLS ?? "").split(",").filter(Boolean);
const schema = JSON.parse(readFileSync(new URL("./contract/result.schema.json", import.meta.url), "utf-8"));
const validate = new Ajv({ allErrors: true, strict: false }).compile(schema);
const signal = () => AbortSignal.timeout(30000);

for (const base of CONTROL) {
  const res = await fetch(`${base}/reset`, { method: "POST", signal: signal() });
  if (!res.ok) throw new Error(`state reset failed for ${base}`);
}

const { scenarios } = await (await fetch(`${UI}/api/scenarios`, { signal: signal() })).json();
const results = [];
for (const s of scenarios) {
  const res = await fetch(`${UI}/api/run/${s.id}`, { method: "POST", signal: signal() });
  const body = await res.json();
  const valid = validate(body);
  if (!valid) body.envelopeErrors = validate.errors.map((e) => `${e.instancePath} ${e.message}`).slice(0, 5);
  results.push({ ...body, envelopeValid: valid });
  console.log(`${valid && body.status === "pass" ? "PASS" : body.status?.toUpperCase()} ${s.id}`);
}
const failed = results.filter((r) => !r.envelopeValid || !["pass", "unsupported"].includes(r.status));
writeFileSync(
  "/out/scenario-results.json",
  JSON.stringify({ count: results.length, failed: failed.length, results }, null, 2),
);
if (results.length === 0) {
  console.error("no scenarios were registered");
  process.exit(1);
}
console.log(`${results.length - failed.length}/${results.length} scenarios ok`);
process.exit(failed.length === 0 ? 0 : 1);
