// Browser/WASM lane (#195): a real Chromium loads the esbuild bundle of the INSTALLED
// adapter-ai-context + core from the browser-consumer service, which serves the core's real
// .wasm. Nothing here substitutes a server request: if packaging cannot support the browser,
// the lane is reported `blocked-by-packaging` and the tests fail with that explicit reason.
// Test titles start with the fixed scenario IDs of contract/ids/browser.json.
import { mkdirSync, writeFileSync } from "node:fs";
import { expect, test } from "@playwright/test";

const BROWSER = process.env.TESTBED_BROWSER_URL;
const SAMPLE_PII_OFF_KEYS = ["text", "keyAware", "whole", "splits", "limit", "blocked"];

const lane = {
  schema: "redact-secret-adapters/testbed-browser-lane-v1",
  // supported/pass | blocked-by-packaging | failed (set by the last test or afterAll)
  status: "failed",
  packaging: null,
  runtime: {},
  parity: {},
  tests: {},
};

test.describe.configure({ mode: "serial" });

test.afterAll(() => {
  const outcomes = Object.values(lane.tests);
  if (lane.packaging?.packaging === "blocked-by-packaging") lane.status = "blocked-by-packaging";
  else if (outcomes.length === 6 && outcomes.every((o) => o === "pass")) lane.status = "supported/pass";
  else lane.status = "failed";
  try {
    mkdirSync("/out", { recursive: true });
    writeFileSync("/out/browser-lane.json", `${JSON.stringify(lane, null, 2)}\n`);
  } catch {
    // the Playwright JSON report still carries every test outcome
  }
});

// Records the outcome of one scenario ID; the test body runs inside the callback.
function lanetest(id, title, body) {
  test(`${id}: ${title}`, async ({ browser, request }) => {
    lane.tests[id] = "failed";
    await body({ browser, request });
    lane.tests[id] = "pass";
  });
}

async function openLane(browser, query) {
  const context = await browser.newContext({ baseURL: BROWSER });
  const external = [];
  const requests = [];
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(BROWSER).origin) {
      external.push(url.origin);
      return route.abort();
    }
    requests.push(url.pathname);
    return route.continue();
  });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", () => problems.push("pageerror"));
  page.on("console", (m) => {
    if (m.type() === "error") problems.push("console-error");
  });
  const wasm = [];
  page.on("response", (r) => {
    if (r.url().endsWith(".wasm"))
      wasm.push({ file: new URL(r.url()).pathname.slice(1), status: r.status(), type: r.headers()["content-type"] });
  });
  await page.goto(`/${query}`);
  await page.waitForFunction(() => globalThis.__aictx?.done === true, null, { timeout: 20000 });
  const result = await page.evaluate(() => globalThis.__aictx);
  return { context, page, result, external, requests, problems, wasm };
}

async function requireSupported(request) {
  const res = await request.get(`${BROWSER}/status`);
  expect(res.ok(), "browser consumer /status is reachable").toBe(true);
  lane.packaging = await res.json();
  expect(
    lane.packaging.packaging,
    `browser lane is blocked by packaging (${lane.packaging.code}); no server request is substituted`,
  ).toBe("supported");
  return lane.packaging;
}

lanetest(
  "browser.packaging-evidence",
  "the installed packages bundle for a browser with the core's WebAssembly assets",
  async ({ request }) => {
    const status = await requireSupported(request);
    expect(status.bundler).toMatchObject({ name: "esbuild", platform: "browser", format: "esm" });
    expect(status.bundle.bytes).toBeGreaterThan(1000);
    expect(status.assets.length).toBeGreaterThan(0);
    const prov = await (await request.get(`${BROWSER}/provenance`)).json();
    lane.provenance = {
      mode: prov.mode,
      adapters: prov.adapters.map((a) => ({ name: a.name, version: a.version, integrity: a.integrity })),
      core: prov.core,
      coreNative: prov.coreNative,
      esbuild: prov.hosts.find((h) => h.name === "esbuild")?.version ?? null,
    };
    expect(prov.adapters.some((a) => a.name === "@redact-secret/adapter-ai-context")).toBe(true);
    expect(lane.provenance.esbuild).toBe(status.bundler.version);
    // The page is served with a same-origin CSP that allows WebAssembly compilation and nothing else.
    const page = await request.get(`${BROWSER}/`);
    expect(page.headers()["content-security-policy"]).toContain("default-src 'none'");
    const wasm = await request.get(`${BROWSER}/${status.assets[0].name}`);
    expect(wasm.headers()["content-type"]).toBe("application/wasm");
  },
);

for (const pii of [false, true]) {
  const id = pii ? "browser.wasm-pii-on" : "browser.wasm-pii-off";
  lanetest(
    id,
    `real WebAssembly core, Unicode and key-aware values, streams (PII ${pii ? "on" : "off"})`,
    async ({ browser, request }) => {
      await requireSupported(request);
      const lap = await openLane(browser, `?pii=${pii ? 1 : 0}`);
      try {
        const r = lap.result;
        expect(r.status, `page status (${r.errorName ?? "ok"})`).toBe("ok");
        expect(r.artifact, "core.artifact() in a browser").toBe("wasm");
        expect(r.failures, "shared cases and lifecycle behaviors").toEqual([]);
        expect(Object.values(r.behavior).every(Boolean)).toBe(true);
        expect(r.samples.text).toMatch(/^토큰 <SECRET_\d+> \u{1F680} 끝$/u);
        expect(r.samples.keyAware[0]).toEqual({ api_key: "<SECRET_1>" });
        expect(r.samples.keyAware[1]).toEqual({ name: "synthetic-example-value-0001" });
        expect(r.samples.keyAware[2]).toEqual({ client_secret: "<SECRET_1>" });
        expect(r.samples.emailExposed, "the address is exposed exactly when PII is off").toBe(!pii);
        expect(lap.problems, "no page error and no console error").toEqual([]);
        const files = lap.wasm.map((w) => w.file);
        expect(files.length, "the core's .wasm was fetched from the consumer").toBeGreaterThan(0);
        expect(lap.wasm.every((w) => w.status === 200 && w.type === "application/wasm")).toBe(true);
        if (pii)
          expect(
            files.some((f) => f.includes("pii")),
            "the PII runtime loads only when PII is requested",
          ).toBe(true);
        else
          expect(
            files.some((f) => f.includes("pii")),
            "PII off loads no PII runtime",
          ).toBe(false);
        lane.runtime[pii ? "piiOn" : "piiOff"] = {
          artifact: r.artifact,
          wasmFetched: files,
          digests: r.digests,
          behavior: r.behavior,
        };
      } finally {
        await lap.context.close();
      }
    },
  );
}

lanetest(
  "browser.context-isolation",
  "PII on and off run in separate browser contexts; a late PII request fails closed",
  async ({ browser, request }) => {
    await requireSupported(request);
    const off = await openLane(browser, "?pii=0");
    const on = await openLane(browser, "?pii=1");
    const late = await openLane(browser, "?pii=0&late=1");
    try {
      // Both contexts are alive at once; neither one's activation reached the other.
      expect(off.result.samples.emailExposed).toBe(true);
      expect(on.result.samples.emailExposed).toBe(false);
      expect(off.result.digests.email).not.toBe(on.result.digests.email);
      expect(late.result.late, "PII requested after init without it").toMatchObject({
        outcome: "blocked",
        reason: "core_error",
        accepting: false,
      });
      // A fresh context after the late page is back to its configured state.
      const again = await openLane(browser, "?pii=0");
      try {
        expect(again.result.samples.emailExposed).toBe(true);
        expect(again.result.digests).toEqual(off.result.digests);
      } finally {
        await again.context.close();
      }
    } finally {
      await Promise.all([off.context.close(), on.context.close(), late.context.close()]);
    }
  },
);

lanetest(
  "browser.server-parity",
  "shared synthetic cases give the same outcomes in the browser and on the Node server",
  async ({ browser, request }) => {
    await requireSupported(request);
    const res = await request.post("/api/run/aictx.shared-baseline");
    const baseline = await res.json();
    expect(baseline.status, "the server baseline scenario").toBe("pass");
    const off = await openLane(browser, "?pii=0");
    const on = await openLane(browser, "?pii=1");
    try {
      const different = [];
      for (const [label, mine, theirs] of [
        ["off", off.result.digests, baseline.evidence.digests.off],
        ["on", on.result.digests, baseline.evidence.digests.on],
      ]) {
        for (const key of Object.keys(theirs)) if (mine[key] !== theirs[key]) different.push(`${label}:${key}`);
      }
      expect(different, "cases whose outcome differs between browser and server").toEqual([]);
      expect(off.result.behavior).toEqual(baseline.evidence.behavior.off);
      expect(on.result.behavior).toEqual(baseline.evidence.behavior.on);
      expect(
        SAMPLE_PII_OFF_KEYS.every((k) => off.result.digests[k] === on.result.digests[k]),
        "non-PII cases are unaffected by PII",
      ).toBe(true);
      lane.parity = {
        serverArtifact: baseline.evidence.artifact,
        browserArtifact: off.result.artifact,
        compared: Object.keys(baseline.evidence.digests.off),
        differing: different,
      };
    } finally {
      await Promise.all([off.context.close(), on.context.close()]);
    }
  },
);

lanetest(
  "browser.no-external-network",
  "the lane needs no network: only same-origin requests, none blocked",
  async ({ browser, request }) => {
    await requireSupported(request);
    const lap = await openLane(browser, "?pii=1");
    try {
      expect(lap.external, "requests to any other origin").toEqual([]);
      expect(lap.requests.every((p) => p === "/" || p === "/bundle.mjs" || p.endsWith(".wasm"))).toBe(true);
      expect(lap.result.status).toBe("ok");
      lane.runtime.requests = [...new Set(lap.requests)].sort();
    } finally {
      await lap.context.close();
    }
  },
);
