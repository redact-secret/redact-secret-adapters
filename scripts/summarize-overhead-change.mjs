#!/usr/bin/env node
/**
 * Reads one or more `overhead-v2` outputs measured with --baseline and prints
 * the baseline-to-current change of every result as a table, then the spread
 * of |relative change| per compared value across all results (#97). Run on an
 * A/A output (`npm run bench:docker -- --aa`), that spread is the machine's
 * noise floor. Like the harnesses, it reports and never judges.
 *
 *   node scripts/summarize-overhead-change.mjs out/overhead-js.json [out/overhead-python.json ...]
 *   node scripts/summarize-overhead-change.mjs --json out/overhead-js.json
 */

import { readFileSync } from "node:fs";

const TABLE = [
  "traversal",
  "adapterOverhead",
  "adapterCoreLatencyP95",
  "adapterCoreLatencyP99",
  "scannerCallsPerEvent",
];

const args = process.argv.slice(2);
const asJson = args.includes("--json");
const files = args.filter((a) => a !== "--json");
if (files.length === 0) {
  console.error("usage: summarize-overhead-change.mjs [--json] <overhead-v2.json> ...");
  process.exit(2);
}

const nearestRank = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];
const percent = (x) => (x === null || x === undefined ? "-" : `${(x * 100).toFixed(1)}%`);

const spread = {};
const rows = [];
for (const file of files) {
  const output = JSON.parse(readFileSync(file, "utf-8"));
  if (output.schema !== "redact-secret-adapters/overhead-v2") throw new Error(`${file}: not an overhead-v2 output`);
  if (output.baseline === null) throw new Error(`${file}: measured without --baseline`);
  for (const result of output.results) {
    const label = `${output.language}/${result.host}/${result.profileId}`;
    if (result.change === undefined) {
      rows.push({ label, comparable: false, reason: result.baseline?.reason ?? "no baseline" });
      continue;
    }
    rows.push({ label, comparable: true, change: result.change });
    for (const [name, value] of Object.entries(result.change)) {
      if (typeof value.relative !== "number") continue;
      if (spread[name] === undefined) spread[name] = [];
      spread[name].push(Math.abs(value.relative));
    }
  }
}

const summary = Object.fromEntries(
  Object.entries(spread).map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return [
      name,
      {
        results: sorted.length,
        medianAbsRelative: nearestRank(sorted, 0.5),
        p95AbsRelative: nearestRank(sorted, 0.95),
        maxAbsRelative: sorted.at(-1),
      },
    ];
  }),
);

if (asJson) {
  process.stdout.write(`${JSON.stringify({ files, rows, summary }, null, 2)}\n`);
} else {
  const width = Math.max(...rows.map((r) => r.label.length), 6);
  console.log(`${"result".padEnd(width)}  ${TABLE.map((n) => n.padStart(22)).join("")}`);
  for (const row of rows) {
    if (!row.comparable) {
      console.log(`${row.label.padEnd(width)}  not comparable: ${row.reason}`);
      continue;
    }
    console.log(
      `${row.label.padEnd(width)}  ${TABLE.map((n) => percent(row.change[n]?.relative).padStart(22)).join("")}`,
    );
  }
  console.log("\n|relative change| across results (an A/A run: the noise floor)");
  console.log(
    `${"value".padEnd(36)}${"results".padStart(8)}${"median".padStart(10)}${"p95".padStart(10)}${"max".padStart(10)}`,
  );
  for (const [name, s] of Object.entries(summary)) {
    console.log(
      `${name.padEnd(36)}${String(s.results).padStart(8)}${percent(s.medianAbsRelative).padStart(10)}${percent(s.p95AbsRelative).padStart(10)}${percent(s.maxAbsRelative).padStart(10)}`,
    );
  }
}
