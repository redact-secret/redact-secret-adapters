// Runs app.mjs and checks the bytes it wrote. Its messages never include the app's output.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000";
const expected = readFileSync(new URL("expected.txt", import.meta.url), "utf-8");

const run = spawnSync(process.execPath, [new URL("app.mjs", import.meta.url).pathname], { encoding: "utf-8" });
const output = run.stdout ?? "";

if (run.status !== 0) {
  console.error(`FAIL: app.mjs exited with status ${run.status}`);
  process.exit(1);
}
if (output.includes(TOKEN) || (run.stderr ?? "").includes(TOKEN)) {
  console.error("FAIL: the synthetic token reached the model context");
  process.exit(1);
}
if (output !== expected) {
  console.error("FAIL: the model context is not the expected redacted output");
  process.exit(1);
}
process.stdout.write(output);
console.log("OK: the synthetic token never reached the model context");
