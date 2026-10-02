// #195: the AI-context scenarios and the browser lane IDs match the committed registry.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { discoverScenarios } from "../contract/envelope.mjs";

const contract = fileURLToPath(new URL("../contract/", import.meta.url));
const ids = (ns) => JSON.parse(readFileSync(`${contract}ids/${ns}.json`, "utf-8")).scenarios;

test("every aictx scenario module is registered, and only those", async () => {
  const found = await discoverScenarios(
    fileURLToPath(new URL("../services/node-consumer/scenarios/", import.meta.url)),
    "node",
    contract,
  );
  assert.deepEqual(
    [...found.keys()].filter((id) => id.startsWith("aictx.")).sort(),
    ids("aictx")
      .map((s) => s.id)
      .sort(),
  );
});

test("every browser ID is a Playwright test title in the browser spec", () => {
  const spec = readFileSync(
    fileURLToPath(new URL("../services/runner/tests/aictx-browser.spec.mjs", import.meta.url)),
    "utf-8",
  );
  for (const { id, host } of ids("browser")) {
    assert.equal(host, "browser");
    assert.ok(spec.includes(`"${id}"`) || spec.includes(`"${id}`), `${id} has a spec`);
  }
});

test("the shared cases module is browser-safe: no Node built-in import", () => {
  const text = readFileSync(`${contract}aictx-cases.mjs`, "utf-8");
  assert.ok(!/from "node:|require\(/.test(text));
});
