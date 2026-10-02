// Scenario-UI journeys (#196). Every test title starts with a fixed ID from contract/ids/ui.json.
// Each journey asserts the VALUES the page displays against literals written here and against the
// consumer's own result fetched without the UI (see _ui-lib.mjs); a green label alone proves nothing.
// Only the hostile-string journeys and the failure paths use fixed fixtures or intercepted
// responses; everything else is the real consumers.
import { expect, test } from "@playwright/test";
import {
  CONSUMERS,
  expectAgreement,
  FIXTURE_ID,
  hostRun,
  journey,
  REGISTRY,
  readResult,
  row,
  runInUi,
  shot,
  watch,
} from "./_ui-lib.mjs";

const BLOCK = "[REDACTED:BLOCKED]";
const r = (label, kind, expected, actual = expected) => ({ label, kind, expected, actual });

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Adapter consumer testbed" })).toBeVisible();
  await expect(page.getByTestId("list-status")).toHaveText(/scenarios loaded/);
});

test("ui.environment-and-catalog: the page lists exactly the registered scenarios and the installed versions", async ({
  page,
  request,
}) => {
  const guard = watch(page);
  await page.reload();
  await expect(page.getByTestId("list-status")).toHaveText(/scenarios loaded/);
  const shown = await page.locator("tr[data-scenario]").evaluateAll((trs) => trs.map((t) => t.dataset.scenario));
  const registered = REGISTRY.filter((s) => s.host === "node" || s.host === "python").map((s) => s.id);
  expect([...shown].sort(), "the rows are the registered node and python scenarios plus the UI fixture").toEqual(
    [...registered, FIXTURE_ID].sort(),
  );
  await expect(page.getByTestId("fault-mode")).toContainText("Service fault mode: none");
  for (const host of ["node", "python"]) {
    const prov = await (await request.get(`${CONSUMERS[host]}/provenance`)).json();
    const card = page.locator(`.host[data-host="${host}"]`);
    await expect(card).toContainText(prov.core.version ?? prov.core["redact-secret"]);
    await expect(card).toContainText(prov.mode === "published" ? "published versions" : "candidate (this checkout");
    for (const a of prov.adapters) await expect(card).toContainText(`${a.name} ${a.version}`);
  }
  await expect(page.locator('.host[data-host="browser"] dt:text-is("Browser support") + dd')).toHaveText("supported");
  // Every row names its host and states whether it uses the real core or injects a fake one.
  const injected = await page.locator("tr[data-scenario]", { hasText: "failure-injection" }).count();
  expect(injected, "failure-injection scenarios are labelled").toBeGreaterThan(0);
  await guard.assertClean();
});

test("ui.masking-journey: masked text and key-aware values show the exact sanitized outputs", async ({
  page,
  request,
}) => {
  const guard = watch(page);
  await journey(page, request, "node", "aictx.text-and-value-ok", [
    r("sanitized Unicode text", "masking", "토큰 <SECRET_1> \u{1F680} 끝"),
    r("value under a secret-named key", "masking", "<SECRET_1>"),
  ]);
  await expect(page.getByTestId("result-mode")).toHaveText("real core");
  await shot(page, "ui-masking");
  await guard.assertClean();
});

test("ui.distinct-outcome-kinds: masking, warn, block, limit, initialization failure and cancellation are shown apart", async ({
  page,
  request,
}) => {
  test.setTimeout(120000);
  const guard = watch(page);
  const seen = new Map();
  const runs = [
    [
      "aictx.policy-warn-block",
      [
        r("default policy, password-shaped value", "warn", "unchanged (warn)"),
        r("default policy, private key", "block", "blocked/policy"),
        r("explicit redact policy, same value", "policy", "password=<SECRET_1>"),
      ],
    ],
    [
      "aictx.limits",
      [r("input over maxInputBytes", "limit", "blocked/limit_exceeded"), r("value within the limits", "limit", "ok")],
    ],
    [
      "aictx.aborted",
      [
        r("sanitizeText on a cancelled signal", "cancellation", "aborted"),
        r("stream cancelled mid-way, finalize", "cancellation", "aborted"),
      ],
    ],
    [
      "aictx.init-failure",
      [
        r("failing core, sanitizeText", "init-failure", "blocked/core_error"),
        r("unknown PII selector, sanitizeText", "init-failure", "blocked/core_error"),
      ],
    ],
  ];
  for (const [id, rows] of runs) {
    const dom = await journey(page, request, "node", id, rows);
    for (const c of dom.comparisons) seen.set(c.kind, c.badge);
    if (id === "aictx.policy-warn-block") await shot(page, "ui-warn-and-block");
    if (id === "aictx.init-failure") await expect(page.getByTestId("result-mode")).toContainText("failure-injection");
  }
  await journey(page, request, "node", "aictx.text-and-value-ok", [
    r("value under a secret-named key", "masking", "<SECRET_1>"),
  ]);
  for (const c of (await readResult(page)).comparisons) seen.set(c.kind, c.badge);
  expect([...seen.keys()].sort()).toEqual([
    "block",
    "cancellation",
    "init-failure",
    "limit",
    "masking",
    "policy",
    "warn",
  ]);
  expect(new Set(seen.values()).size, "every kind has its own label").toBe(seen.size);
  await guard.assertClean();
});

test("ui.staged-stream: a stream shows completion at finalize and no progressive output", async ({ page, request }) => {
  const guard = watch(page);
  const dom = await journey(page, request, "node", "aictx.stream-lifecycle", [
    r("chunks that released output before finalize", "stream", "0"),
    r("stream accepting after finalize", "stream", "false"),
    r(
      "finalized stream value equals the whole-input value",
      "stream",
      "line one\nAPI_KEY=<SECRET_1>\n\u{1F680} done\n",
    ),
  ]);
  expect(dom.streamState).toBe("true");
  await expect(page.getByTestId("stream-state")).toContainText("nothing is shown progressively");
  await guard.assertClean();
});

test("ui.final-output-agreement: Pino and Python logging show the destination's final markers and agree with the hosts", async ({
  page,
  request,
}) => {
  const guard = watch(page);
  const node = await journey(page, request, "node", "pino.policy-block", [
    r("structured private-key field", "block", BLOCK),
  ]);
  expect(node.host).toBe("node");
  const py = await journey(page, request, "python", "pylog.policy-block", [r("private-key message", "block", BLOCK)]);
  expect(py.host).toBe("python");
  // A warn control is a negative control: the page must say so and show a label, never the value.
  const warn = await journey(page, request, "node", "pino.policy-warn", [
    r("warn value in the destination", "warn", "unchanged (warn)"),
  ]);
  expect(warn.mode).toContain("negative control");
  await journey(page, request, "python", "pylog.policy-warn", [
    r("warn value in the handler output", "warn", "unchanged (warn)"),
  ]);
  await guard.assertClean();
});

test("ui.policy-fixtures: the credential and PII policy configurations show their outcomes (examples/policy-js)", async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  const guard = watch(page);
  await journey(page, request, "node", "aictx.pii-isolated-processes", [
    r("PII off vs on: only the address case differs", "policy", "true"),
    r("explicit policy, warn-only value", "policy", "password=<SECRET_1>"),
    r("explicit policy, private key", "block", "blocked/policy"),
    r("PII requested after init without it", "init-failure", "blocked/core_error"),
  ]);
  await expect(page.getByTestId("guidance")).toContainText("docs/troubleshooting.md");
  await guard.assertClean();
});

test("ui.hostile-strings-render-as-text: markup in results is shown as characters and nothing executes", async ({
  page,
}) => {
  const dialogs = [];
  page.on("dialog", (d) => dialogs.push(d.type()));
  const guard = watch(page);
  expect(await runInUi(page, FIXTURE_ID)).toBe("pass");
  const result = page.getByTestId("result");
  await expect(result).toContainText('<img src=x onerror="window.__xss=1">');
  await expect(result).toContainText("<script>window.__xss=1</script>");
  await expect(result).toContainText("javascript:window.__xss=1");
  // Rendered as text: the result region holds no element the strings could have created.
  for (const tag of ["img", "script", "svg", "a", "iframe"])
    expect(await result.locator(tag).count(), `<${tag}> elements in the result`).toBe(0);
  expect(await page.evaluate(() => globalThis.__xss), "nothing executed").toBeUndefined();
  expect(dialogs).toEqual([]);
  const dom = await readResult(page);
  expect(dom.comparisons.length).toBe(5);
  expect(dom.comparisons.every((c) => c.expected === c.actual && c.match === "match")).toBe(true);
  await guard.assertClean();
});

test("ui.unavailable-and-retry: a service failure is shown as unavailable, never as stale success, and retry recovers", async ({
  page,
}) => {
  const guard = watch(page);
  const id = "pino.policy-warn";
  // 1. A good run first, so there IS a success that must not survive a failure.
  expect(await runInUi(page, id)).toBe("pass");
  await expect(page.getByTestId("result-body")).toBeVisible();
  // 2. The run endpoint fails: the row and the result must not keep or show a pass.
  await page.route("**/api/run/**", (route) => route.fulfill({ status: 502, json: { error: "consumer unavailable" } }));
  expect(await runInUi(page, id)).toBe("unavailable");
  await expect(row(page, id).getByTestId("status")).not.toHaveText("pass");
  await expect(page.getByTestId("result-body")).toHaveCount(0);
  await expect(page.getByTestId("problem")).toContainText("unavailable");
  // 3. Recovery through the retry control.
  await page.unroute("**/api/run/**");
  await page.getByTestId("retry-run").click();
  await expect(row(page, id).getByTestId("status")).toHaveText("pass");
  await expect(page.getByTestId("result-body")).toBeVisible();
  // 4. The scenario list itself failing leaves no stale rows, then retry loads them.
  await page.route("**/api/scenarios", (route) => route.abort());
  await page.getByTestId("filter").fill("");
  await page.reload();
  await expect(page.getByTestId("list-status")).toContainText("unavailable");
  await expect(page.locator("tr[data-scenario]")).toHaveCount(0);
  await page.unroute("**/api/scenarios");
  await page.getByTestId("retry").click();
  await expect(page.getByTestId("list-status")).toHaveText(/scenarios loaded/);
  expect(await page.locator("tr[data-scenario]").count()).toBeGreaterThan(0);
  await shot(page, "ui-unavailable-recovered");
  await guard.assertClean();
});

test("ui.timeout-bounded: a run that never answers ends as timed out within the bound, with no result", async ({
  page,
}) => {
  const id = "pino.policy-block";
  await page.goto("/?runTimeoutMs=1500");
  await expect(page.getByTestId("list-status")).toHaveText(/scenarios loaded/);
  await page.route("**/api/run/**", () => {
    // Never answered: the page must give up by itself.
  });
  const started = Date.now();
  expect(await runInUi(page, id)).toBe("timed out");
  expect(Date.now() - started, "gave up within the bound").toBeLessThan(8000);
  await expect(page.getByTestId("result-body")).toHaveCount(0);
  await expect(page.getByTestId("problem")).toContainText("did not finish within 1500 ms");
  // The control is usable again: a different, answered request works.
  await page.unroute("**/api/run/**");
  expect(await runInUi(page, id)).toBe("pass");
});

test("ui.keyboard-and-labels: the page works by keyboard and exposes labelled controls and regions", async ({
  page,
}) => {
  await expect(page.getByRole("status").first()).toBeAttached();
  await expect(page.getByRole("table")).toBeVisible();
  const filter = page.getByLabel("Filter scenarios by ID or title");
  await filter.fill("pino.policy-warn");
  await expect(page.locator("tr[data-scenario]:visible")).toHaveCount(1);
  const run = page.getByRole("button", { name: "Run pino.policy-warn" });
  await run.focus();
  await page.keyboard.press("Enter");
  await expect(row(page, "pino.policy-warn").getByTestId("status")).toHaveText("pass");
  await expect(page.getByTestId("result")).toHaveAttribute("aria-live", "polite");
  await expect(page.getByTestId("assertions")).toHaveAttribute("aria-label", "Assertions");
  await expect(page.getByRole("heading", { name: "Environment" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Result" })).toBeVisible();
});

const agreement = async (page, host) => expectAgreement(await readResult(page), host);

test("ui.incorrect-response-fails-journey: a wrong response from the service makes the journey fail", async ({
  page,
  request,
}) => {
  const id = "pino.policy-block";
  const rows = [r("structured private-key field", "block", BLOCK)];
  // Control: the unmodified service passes the very same journey.
  await journey(page, request, "node", id, rows);
  const real = await hostRun(request, "node", id);

  // (a) The service reports success but shows the wrong output value.
  const wrongValue = structuredClone(real);
  wrongValue.evidence.comparisons[0].actual = "plaintext leaked here";
  wrongValue.evidence.comparisons[0].match = true;
  await page.route("**/api/run/**", (route) => route.fulfill({ json: wrongValue }));
  await expect(journey(page, request, "node", id, rows), "wrong displayed value").rejects.toThrow();
  await page.unroute("**/api/run/**");

  // (b) The displayed values are right but the status is not what the host reported.
  const wrongStatus = structuredClone(real);
  wrongStatus.status = "fail";
  await page.route("**/api/run/**", (route) => route.fulfill({ json: wrongStatus }));
  await runInUi(page, id);
  await expect(agreement(page, real), "wrong response must fail the journey").rejects.toThrow();
  await page.unroute("**/api/run/**");

  // (c) The values and status match each other but disagree with the host's result.
  const wrongHost = structuredClone(real);
  wrongHost.evidence.comparisons[0].label = "a different check";
  await page.route("**/api/run/**", (route) => route.fulfill({ json: wrongHost }));
  await runInUi(page, id);
  await expect(agreement(page, real), "wrong response must fail the journey").rejects.toThrow();
});
