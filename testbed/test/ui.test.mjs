import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import { COMPARISON_KINDS, loadSentinels, makeScrubber, runScenario } from "../contract/envelope.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const contract = join(root, "contract/");
const scrub = makeScrubber(loadSentinels(contract));
const validate = new Ajv({ strict: false }).compile(
  JSON.parse(readFileSync(join(contract, "result.schema.json"), "utf-8")),
);
const def = (run) => ({ id: "smoke.node-public-imports", title: "t", classification: "install-check", run });

test("ui.json IDs and the journey spec titles are the same set", () => {
  const ids = JSON.parse(readFileSync(join(contract, "ids/ui.json"), "utf-8")).scenarios.map((s) => s.id);
  const spec = readFileSync(join(root, "services/runner/tests/ui-journeys.spec.mjs"), "utf-8");
  const titled = [...spec.matchAll(/^test\("(ui\.[a-z0-9-]+):/gm)].map((m) => m[1]);
  // The fixture ID is a scenario the UI serves, not a journey; every other ID has exactly one journey.
  assert.deepEqual([...titled].sort(), ids.filter((i) => i !== "ui.hostile-strings-fixture").sort());
});

test("compare records the pair, asserts equality and stays schema-valid", async () => {
  const r = await runScenario(
    def((_c, rec) => {
      rec.compare("same", "x", "x", "masking");
      rec.compare("number", 0, 0, "stream");
      rec.compare("unknown kind", true, true, "not-a-kind");
    }),
    "node",
    {},
    scrub,
  );
  assert.equal(r.status, "pass");
  assert.ok(validate(r), JSON.stringify(validate.errors));
  assert.deepEqual(
    r.evidence.comparisons.map((c) => [c.kind, c.match]),
    [
      ["masking", true],
      ["stream", true],
      ["other", true],
    ],
  );
  assert.ok(COMPARISON_KINDS.includes("other"));
});

test("a differing pair fails the scenario and shows MISMATCH data, scrubbed", async () => {
  const r = await runScenario(
    def((_c, rec) => rec.compare("leaky", "expected", "ghp_SYNTHETICREVOKEDabc", "masking")),
    "node",
    {},
    scrub,
  );
  assert.equal(r.status, "fail");
  assert.equal(r.evidence.comparisons[0].match, false);
  assert.equal(r.evidence.comparisons[0].actual, "[SENTINEL]");
  assert.ok(!JSON.stringify(r).includes("ghp_SYNTHETIC"));
});

test("the wrong-expectation fault makes every compare fail", async () => {
  process.env.TESTBED_FAULT = "wrong-expectation";
  try {
    const r = await runScenario(
      def((_c, rec) => rec.compare("a", "x", "x")),
      "node",
      {},
      scrub,
    );
    assert.equal(r.status, "fail");
    assert.equal(r.evidence.comparisons[0].match, false);
  } finally {
    delete process.env.TESTBED_FAULT;
  }
});

test("more comparisons than the cap is an error, not silent truncation", async () => {
  const r = await runScenario(
    def((_c, rec) => {
      for (let i = 0; i < 13; i++) rec.compare(`c${i}`, 1, 1);
    }),
    "node",
    {},
    scrub,
  );
  assert.equal(r.status, "error");
});

test("the Python twin records comparisons the same way", () => {
  const code = `
import json, os, sys
sys.path.insert(0, ${JSON.stringify(contract)})
import envelope
scrub = envelope.make_scrubber(envelope.load_sentinels(__import__("pathlib").Path(${JSON.stringify(contract)})))
def ok(ctx, rec):
    rec.compare("same", "x", "x", "block")
    rec.compare("zero", 0, 0)
d = {"id": "smoke.python-core-active", "title": "t", "classification": "install-check", "run": ok}
print(json.dumps(envelope.run_scenario(d, "python", {}, scrub)))
os.environ["TESTBED_FAULT"] = "wrong-expectation"
print(json.dumps(envelope.run_scenario(d, "python", {}, scrub)["status"]))`;
  const lines = execFileSync("python3", ["-c", code], { encoding: "utf-8" }).trim().split("\n");
  const r = JSON.parse(lines[0]);
  assert.equal(r.status, "pass");
  assert.ok(validate(r), JSON.stringify(validate.errors));
  assert.equal(r.evidence.comparisons[0].kind, "block");
  assert.equal(JSON.parse(lines[1]), "fail");
});
