// Shared helpers for the scenario-UI journeys (#196). Not a spec file (the leading underscore keeps
// it out of testMatch's `*.spec.mjs`).
//
// The journeys never trust a green label. They (1) run a scenario through the UI, (2) read the
// DISPLAYED expected/actual values, (3) compare them with literals fixed in the spec, and (4) run
// the same scenario directly against the consumer's own API (no UI in between) and require the UI
// to show exactly what the host returned. A UI that displays a wrong value or a wrong status fails
// at step 3 or 4.
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { expect } from "@playwright/test";

const OUT = process.env.TESTBED_OUT ?? "/out";
export const CONSUMERS = Object.fromEntries(
  (process.env.TESTBED_CONSUMER_URLS ?? "")
    .split(",")
    .filter(Boolean)
    .map((pair) => pair.split("=")),
);
const contractDir = new URL("../contract/", import.meta.url);
export const SENTINELS = readdirSync(new URL("sentinels.d/", contractDir))
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(new URL(`sentinels.d/${f}`, contractDir), "utf-8")).patterns)
  .map((p) => new RegExp(p));
export const REGISTRY = readdirSync(new URL("ids/", contractDir))
  .filter((f) => f.endsWith(".json"))
  .flatMap((f) => JSON.parse(readFileSync(new URL(`ids/${f}`, contractDir), "utf-8")).scenarios);
export const FIXTURE_ID = "ui.hostile-strings-fixture";

/** Direct call to the consumer's scenario API from inside the compose network: no UI involved. */
export async function hostRun(request, host, id) {
  const base = CONSUMERS[host];
  expect(base, `a consumer URL for host '${host}' (TESTBED_CONSUMER_URLS)`).toBeTruthy();
  const res = await request.post(`${base}/run/${id}`, { timeout: 30000 });
  expect(res.ok(), `host ${host} ran ${id}`).toBe(true);
  return res.json();
}

/**
 * Watches the sinks a stray sentinel could reach: the browser console, every response body the page
 * received, and the visible text. The claim is limited to those sanitized result surfaces; synthetic
 * inputs live in the consumers and are not on any of them.
 */
export function watch(page) {
  const seen = { console: [], bodies: [], origins: new Set() };
  page.on("console", (m) => seen.console.push(m.text()));
  page.on("pageerror", (e) => seen.console.push(String(e?.message ?? e)));
  page.on("request", (r) => seen.origins.add(new URL(r.url()).origin));
  page.on("response", async (r) => {
    if (new URL(r.url()).pathname.startsWith("/api/")) {
      try {
        seen.bodies.push(await r.text());
      } catch {
        // a response that was aborted has no body to scan
      }
    }
  });
  return {
    seen,
    async assertClean() {
      const text = await page.locator("body").innerText();
      for (const [sink, parts] of [
        ["console", seen.console],
        ["api response", seen.bodies],
        ["page text", [text]],
      ])
        for (const part of parts)
          for (const rx of SENTINELS) expect(rx.test(part), `a sentinel reached the ${sink}`).toBe(false);
      expect([...seen.origins], "the page contacts only its own origin").toEqual([new URL(page.url()).origin]);
    },
  };
}

export const row = (page, id) => page.locator(`tr[data-scenario="${id}"]`);

/** Runs `id` through the UI and waits for a terminal status. */
export async function runInUi(page, id) {
  const r = row(page, id);
  await expect(r).toBeVisible();
  await r.getByTestId("run").click();
  await expect(r.getByTestId("status")).not.toHaveText(/^(not run|running)$/, { timeout: 30000 });
  return r.getByTestId("status").textContent();
}

/** What the page displays for the current result, read from the DOM. */
export async function readResult(page) {
  const body = page.getByTestId("result-body");
  await expect(body).toBeVisible();
  const comparisons = await body.getByTestId("comparison").evaluateAll((trs) =>
    trs.map((tr) => ({
      kind: tr.dataset.kind,
      label: tr.children[1].textContent,
      badge: tr.children[0].textContent,
      expected: tr.querySelector('[data-testid="expected"]').textContent,
      actual: tr.querySelector('[data-testid="actual"]').textContent,
      match: tr.querySelector('[data-testid="match"]').textContent,
    })),
  );
  return {
    id: await body.getAttribute("data-result-for"),
    status: await body.getByTestId("result-status").textContent(),
    host: await body.getByTestId("result-host").textContent(),
    mode: await body.getByTestId("result-mode").textContent(),
    summary: await body.getByTestId("assertion-summary").textContent(),
    failedAssertions: await body.locator('[data-testid="assertions"] li[data-ok="false"]').count(),
    streamState:
      (await body.getByTestId("stream-state").count()) > 0
        ? await body.getByTestId("stream-state").getAttribute("data-complete")
        : null,
    comparisons,
  };
}

/** The UI must show exactly what the host's envelope says. Throws (via expect) on any difference. */
export function expectAgreement(dom, hostEnvelope) {
  expect(dom.id, "the result is for the scenario that was run").toBe(hostEnvelope.scenarioId);
  expect(dom.status, "UI status equals the host's final-output status").toBe(hostEnvelope.status);
  expect(dom.host).toBe(hostEnvelope.host);
  const failed = hostEnvelope.assertions.filter((a) => a.ok !== true).length;
  expect(dom.failedAssertions, "failed assertions shown equal the host's").toBe(failed);
  const hostRows = hostEnvelope.evidence.comparisons ?? [];
  expect(dom.comparisons.length, "number of compared outputs").toBe(hostRows.length);
  hostRows.forEach((h, i) => {
    const d = dom.comparisons[i];
    expect(d.label).toBe(h.label);
    expect(d.kind).toBe(h.kind);
    expect(d.expected, `expected shown for '${h.label}'`).toBe(String(h.expected));
    expect(d.actual, `actual shown for '${h.label}'`).toBe(String(h.actual));
    expect(d.match).toBe(h.match ? "match" : "MISMATCH");
  });
}

/**
 * One full journey: run through the UI, assert the displayed values against fixed literals, then
 * require agreement with the host's own result. `rows` are { label, kind, expected, actual } literals
 * written in the spec, independent of anything the UI or host returned.
 */
export async function journey(page, request, host, id, rows) {
  expect(await runInUi(page, id), `${id} status in the UI`).toBe("pass");
  const dom = await readResult(page);
  expect(dom.status).toBe("pass");
  expect(dom.failedAssertions).toBe(0);
  for (const want of rows) {
    const got = dom.comparisons.find((c) => c.label === want.label);
    expect(got, `a row '${want.label}' is displayed`).toBeDefined();
    expect(got.kind, `kind of '${want.label}'`).toBe(want.kind);
    expect(got.expected, `expected value of '${want.label}'`).toBe(want.expected);
    expect(got.actual, `actual value of '${want.label}'`).toBe(want.actual);
    expect(got.match).toBe("match");
  }
  const hostEnvelope = await hostRun(request, host, id);
  expect(hostEnvelope.status, `${id} on the host`).toBe("pass");
  expectAgreement(dom, hostEnvelope);
  return dom;
}

/** One of the few important-state screenshots (everything else is asserted by behavior). */
export async function shot(page, name) {
  mkdirSync(`${OUT}/screenshots`, { recursive: true });
  await page.screenshot({ path: `${OUT}/screenshots/${name}.png` });
}
