import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { discoverScenarios, loadSentinels, makeScrubber, runScenario } from "../contract/envelope.mjs";

const contract = fileURLToPath(new URL("../contract/", import.meta.url));
const schema = JSON.parse(readFileSync(join(contract, "result.schema.json"), "utf-8"));
const validate = new Ajv({ strict: false }).compile(schema);
const scrub = makeScrubber(loadSentinels(contract));
const def = (run, extra = {}) => ({
  id: "smoke.node-public-imports",
  title: "t",
  classification: "install-check",
  run,
  ...extra,
});

test("a passing scenario yields a schema-valid envelope", async () => {
  const r = await runScenario(
    def((_c, rec) => rec.check("a", true)),
    "node",
    {},
    scrub,
  );
  assert.equal(r.status, "pass");
  assert.ok(validate(r), JSON.stringify(validate.errors));
});

test("no assertions is a failure, a false assertion is a failure", async () => {
  assert.equal(
    (
      await runScenario(
        def(() => {}),
        "node",
        {},
        scrub,
      )
    ).status,
    "fail",
  );
  assert.equal(
    (
      await runScenario(
        def((_c, rec) => rec.check("a", false)),
        "node",
        {},
        scrub,
      )
    ).status,
    "fail",
  );
});

test("a thrown error becomes status error and never echoes its message or a sentinel", async () => {
  const r = await runScenario(
    def(() => {
      throw new Error("ghp_SYNTHETICREVOKED0000");
    }),
    "node",
    {},
    scrub,
  );
  assert.equal(r.status, "error");
  assert.ok(!JSON.stringify(r).includes("ghp_SYNTHETIC"));
  assert.ok(validate(r));
});

test("sentinels in detail and evidence are scrubbed; oversized evidence is an error", async () => {
  const r = await runScenario(
    def((_c, rec) => {
      rec.check("a", true, "saw ghp_SYNTHETICREVOKED0000");
      rec.evidence.x = "ghp_SYNTHETICREVOKED0000";
    }),
    "node",
    {},
    scrub,
  );
  assert.ok(!JSON.stringify(r).includes("ghp_SYNTHETIC"));
  const big = await runScenario(
    def((_c, rec) => {
      rec.check("a", true);
      rec.evidence.x = "y".repeat(9000);
    }),
    "node",
    {},
    scrub,
  );
  assert.equal(big.status, "error");
  assert.equal(big.error.code, "evidence-too-large");
});

test("unsupported is recorded, not passed", async () => {
  const r = await runScenario(
    def((_c, rec) => rec.unsupported("no wasm here")),
    "node",
    {},
    scrub,
  );
  assert.equal(r.status, "unsupported");
});

test("discovery enforces the fixed registry", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tb-"));
  writeFileSync(
    join(dir, "a.mjs"),
    `export const scenarios = [{ id: "pino.not-registered", title: "t", classification: "qualification", run() {} }];`,
  );
  await assert.rejects(discoverScenarios(dir, "node", contract), /not listed in contract\/ids/);
  rmSync(join(dir, "a.mjs"));
  writeFileSync(
    join(dir, "b.mjs"),
    `export const scenarios = [{ id: "pylog.x", title: "t", classification: "qualification", run() {} }];`,
  );
  await assert.rejects(discoverScenarios(dir, "node", contract), /not allowed on host/);
  rmSync(join(dir, "b.mjs"));
  writeFileSync(
    join(dir, "c.mjs"),
    `export const scenarios = [{ id: "Bad ID", title: "t", classification: "qualification", run() {} }];`,
  );
  await assert.rejects(discoverScenarios(dir, "node", contract), /invalid scenario id/);
});

test("the real node scenarios match the committed smoke IDs", async () => {
  const found = await discoverScenarios(
    fileURLToPath(new URL("../services/node-consumer/scenarios/", import.meta.url)),
    "node",
    contract,
  );
  assert.deepEqual([...found.keys()].sort(), [
    "smoke.node-core-active",
    "smoke.node-install-isolation",
    "smoke.node-public-imports",
  ]);
});

test("the Python twin agrees with the schema and the registry", () => {
  const script = `
import json, sys, pathlib
sys.path.insert(0, "${contract}")
import envelope
c = pathlib.Path("${contract}")
scrub = envelope.make_scrubber(envelope.load_sentinels(c))
def ok(ctx, rec): rec.check("a", True, "ghp_SYNTHETICREVOKED0000"); rec.evidence["x"] = 1
r = envelope.run_scenario({"id": "smoke.python-core-active", "title": "t", "classification": "install-check", "run": ok}, "python", {}, scrub)
found = envelope.discover_scenarios(pathlib.Path("${fileURLToPath(new URL("../services/python-consumer/scenarios/", import.meta.url))}"), "python", c)
print(json.dumps({"result": r, "ids": sorted(found)}))`;
  const out = JSON.parse(execFileSync("python3", ["-c", script], { encoding: "utf-8" }));
  assert.ok(validate(out.result), JSON.stringify(validate.errors));
  assert.ok(!JSON.stringify(out.result).includes("ghp_SYNTHETIC"));
  assert.deepEqual(out.ids, [
    "smoke.python-core-active",
    "smoke.python-install-isolation",
    "smoke.python-public-imports",
  ]);
});
