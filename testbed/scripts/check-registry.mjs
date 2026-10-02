#!/usr/bin/env node
/**
 * Static check of the fixed scenario-ID registry (#192), no Docker needed:
 * every contract/ids/<namespace>.json file holds IDs of its own namespace, valid hosts,
 * no duplicates across files, and a namespace is declared in namespaces.json. The
 * consumers re-check at startup that discovered modules match this list exactly.
 *
 *   node testbed/scripts/check-registry.mjs
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { SCENARIO_ID } from "../contract/envelope.mjs";

const contract = fileURLToPath(new URL("../contract/", import.meta.url));
const { namespaces } = JSON.parse(readFileSync(`${contract}namespaces.json`, "utf-8"));
const problems = [];
const seen = new Map();
for (const file of readdirSync(`${contract}ids`)
  .filter((f) => f.endsWith(".json"))
  .sort()) {
  const { namespace, scenarios } = JSON.parse(readFileSync(`${contract}ids/${file}`, "utf-8"));
  if (file !== `${namespace}.json`) problems.push(`${file}: namespace '${namespace}' does not match the file name`);
  if (!namespaces[namespace]) problems.push(`${file}: namespace '${namespace}' is not declared in namespaces.json`);
  for (const { id, host } of scenarios) {
    if (!SCENARIO_ID.test(id)) problems.push(`${file}: invalid id '${id}'`);
    if (id.split(".")[0] !== namespace) problems.push(`${file}: '${id}' is outside namespace '${namespace}'`);
    if (!namespaces[namespace]?.hosts.includes(host))
      problems.push(`${file}: '${id}' host '${host}' not allowed in '${namespace}'`);
    if (seen.has(id)) problems.push(`${file}: '${id}' is also in ${seen.get(id)}`);
    seen.set(id, file);
  }
}
for (const ns of Object.keys(namespaces)) {
  try {
    readFileSync(`${contract}ids/${ns}.json`);
  } catch {
    problems.push(`namespace '${ns}' has no contract/ids/${ns}.json`);
  }
}
if (problems.length > 0) {
  console.error(`scenario registry check FAILED:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`scenario registry ok: ${seen.size} fixed IDs in ${Object.keys(namespaces).length} namespaces`);
