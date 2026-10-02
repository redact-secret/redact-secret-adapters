// Scenario UI (#196). Every value from the API is rendered with textContent (never innerHTML), so
// markup in a title, label or output string is shown as characters and cannot execute. The page has
// no input beyond a local filter and runs only scenario IDs the server lists.
const params = new URLSearchParams(location.search);
const bounded = (name, fallback) => {
  const n = Number(params.get(name));
  return Number.isFinite(n) && n >= 500 && n <= 60000 ? n : fallback;
};
const RUN_TIMEOUT_MS = bounded("runTimeoutMs", 30000);
const LOAD_TIMEOUT_MS = bounded("loadTimeoutMs", 15000);
const STATUSES = ["pass", "fail", "error", "unsupported"];

// Fixed display labels and recovery guidance (docs/troubleshooting.md). Nothing here comes from the API.
const KINDS = {
  masking: ["masked", "A secret was replaced by a placeholder in the output."],
  warn: [
    "warn (unchanged)",
    "A finding was reported but the default policy left the text unchanged. Choose an explicit policy to redact it (docs/troubleshooting.md, Logs and spans).",
  ],
  block: [
    "block",
    "The policy refused the value: no value is produced, only a fixed marker or outcome (docs/troubleshooting.md, AI context and MCP outcomes).",
  ],
  limit: [
    "limit",
    "A configured limit was exceeded and nothing was truncated or passed through. Send less, or replace the whole limit set (docs/troubleshooting.md, Limits).",
  ],
  "init-failure": [
    "initialization failure",
    "The core could not load or initialize, so every operation fails closed (docs/troubleshooting.md, Initialization and activation).",
  ],
  cancellation: [
    "cancellation",
    "The operation was cancelled and released no value (docs/troubleshooting.md, AI context and MCP outcomes).",
  ],
  stream: ["staged stream", "A stream releases nothing until finalize (docs/troubleshooting.md, Streams)."],
  policy: [
    "policy",
    "An explicit policy or PII selection changed the outcome (docs/troubleshooting.md, Initialization and activation).",
  ],
  other: ["check", ""],
};

const $ = (id) => document.getElementById(id);
function el(tag, text, attrs = {}) {
  const node = document.createElement(tag);
  if (text !== undefined && text !== null) node.textContent = String(text);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
}
const slug = (s) =>
  String(s)
    .replace(/[^a-z0-9]+/gi, "-")
    .toLowerCase();

async function getJson(url, options = {}, timeoutMs = LOAD_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal, cache: "no-store" });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { ok: res.ok, status: res.status, body, timedOut: false };
  } catch {
    return { ok: false, status: 0, body: null, timedOut: ctrl.signal.aborted };
  } finally {
    clearTimeout(timer);
  }
}

// ---- environment -----------------------------------------------------------------------------
function renderEnvironment(env) {
  const root = $("env");
  root.replaceChildren();
  const mode = env.faultMode === "none" ? "none (real core in every consumer)" : env.faultMode;
  root.append(
    el(
      "p",
      `Service fault mode: ${mode}. Scenarios that inject a fake scanner or core are labelled "failure-injection" below.`,
      { "data-testid": "fault-mode" },
    ),
  );
  const grid = el("div", null, { class: "hosts" });
  for (const h of env.hosts) {
    const card = el("section", null, { class: "host", "data-host": h.host, "aria-label": `${h.host} environment` });
    card.append(el("h3", h.host));
    const lines = [
      [
        "Evidence",
        h.mode === "published"
          ? "published versions (says nothing about this checkout)"
          : h.mode === "candidate"
            ? "candidate (this checkout, packed)"
            : "unknown",
      ],
      ["Runtime", h.runtime || "not reported"],
      ["Core", h.core ?? "not reported"],
    ];
    if (h.packaging) lines.push(["Browser support", h.packaging]);
    if (h.native?.length) lines.push(["Core runtimes", h.native.map((n) => `${n.name} ${n.version}`).join(", ")]);
    lines.push([
      "Adapters",
      h.adapters.length ? h.adapters.map((a) => `${a.name} ${a.version}`).join(", ") : "not reported",
    ]);
    const dl = el("dl");
    for (const [k, v] of lines) dl.append(el("dt", k), el("dd", v, { class: "value" }));
    card.append(dl);
    grid.append(card);
  }
  root.append(grid);
}

async function loadEnvironment() {
  $("env-status").textContent = "Loading environment…";
  $("env").replaceChildren();
  const r = await getJson("/api/environment");
  if (!r.ok || !Array.isArray(r.body?.hosts)) {
    $("env-status").textContent = r.timedOut
      ? "Environment unavailable: the request timed out."
      : "Environment unavailable.";
    return;
  }
  $("env-status").textContent = "Environment loaded.";
  renderEnvironment(r.body);
}

// ---- scenarios -------------------------------------------------------------------------------
let running = false;
let seq = 0;
const rows = new Map();

function setStatus(row, text) {
  const cell = row.querySelector('[data-testid="status"]');
  cell.textContent = text;
  cell.className = `status s-${slug(text)}`;
}

function setAllButtons(disabled) {
  for (const row of rows.values()) row.querySelector("button").disabled = disabled;
}

function kindLabel(s) {
  if (s.classification === "failure-injection") return "failure-injection (fake core or scanner)";
  if (s.classification === "negative-control") return "negative control";
  if (s.classification === "install-check") return "install check";
  return "real core";
}

function buildRow(s) {
  const tr = el("tr", null, { "data-scenario": s.id });
  const name = el("td");
  name.append(el("code", s.id), document.createElement("br"), s.title);
  const status = el("td", "not run", { "data-testid": "status", class: "status s-not-run" });
  const button = el("button", "Run", { type: "button", "data-testid": "run", "aria-label": `Run ${s.id}` });
  button.addEventListener("click", () => runScenario(s, tr));
  const action = el("td");
  action.append(button);
  tr.append(name, el("td", s.host), el("td", kindLabel(s)), status, action);
  return tr;
}

async function loadScenarios() {
  rows.clear();
  $("rows").replaceChildren();
  $("result").replaceChildren(el("p", "No scenario run yet."));
  $("retry").hidden = true;
  $("list-status").textContent = "Loading scenarios…";
  const r = await getJson("/api/scenarios");
  if (!r.ok || !Array.isArray(r.body?.scenarios)) {
    $("list-status").textContent = r.timedOut
      ? "Scenario service unavailable: the request timed out. Nothing was run."
      : "Scenario service unavailable. Nothing was run.";
    $("retry").hidden = false;
    return;
  }
  for (const s of r.body.scenarios) {
    if (typeof s?.id !== "string" || typeof s.title !== "string") continue;
    const tr = buildRow(s);
    rows.set(s.id, tr);
    $("rows").append(tr);
  }
  $("list-status").textContent = `${rows.size} scenarios loaded.`;
  applyFilter();
}

function applyFilter() {
  const q = $("filter").value.trim().toLowerCase();
  for (const [id, tr] of rows) tr.hidden = q !== "" && !(id.includes(q) || tr.textContent.toLowerCase().includes(q));
}

function showProblem(row, s, label, message) {
  setStatus(row, label);
  const box = el("div", null, { "data-testid": "problem" });
  box.append(el("h3", s.id), el("p", message, { role: "alert" }));
  const again = el("button", "Retry this scenario", { type: "button", "data-testid": "retry-run" });
  again.addEventListener("click", () => runScenario(s, row));
  box.append(again);
  $("result").replaceChildren(box);
}

function validResult(b, id) {
  return (
    b &&
    b.scenarioId === id &&
    STATUSES.includes(b.status) &&
    Array.isArray(b.assertions) &&
    b.evidence &&
    typeof b.evidence === "object"
  );
}

async function runScenario(s, row) {
  if (running) return;
  running = true;
  const mine = ++seq;
  setAllButtons(true);
  // Clear first: a previous success is never left on screen while this run is pending or after it fails.
  setStatus(row, "running");
  $("result").replaceChildren(el("p", `Running ${s.id}…`));
  const r = await getJson(`/api/run/${s.id}`, { method: "POST" }, RUN_TIMEOUT_MS);
  if (mine !== seq) return;
  running = false;
  setAllButtons(false);
  if (r.timedOut)
    return showProblem(
      row,
      s,
      "timed out",
      `The run did not finish within ${RUN_TIMEOUT_MS} ms and was abandoned. No result is shown.`,
    );
  if (r.status === 409)
    return showProblem(row, s, "unavailable", "The consumer is busy with another scenario. Retry in a moment.");
  if (!r.ok) return showProblem(row, s, "unavailable", "The consumer service is unavailable. No result is shown.");
  if (!validResult(r.body, s.id))
    return showProblem(row, s, "error", "The response was not a valid scenario result and was discarded.");
  setStatus(row, r.body.status);
  renderResult(r.body);
}

function renderResult(r) {
  const root = el("div", null, { "data-testid": "result-body", "data-result-for": r.scenarioId });
  root.append(el("h3", `${r.scenarioId}: ${r.title}`, { "data-testid": "result-title" }));
  const info = el("dl");
  const add = (k, v, testid) =>
    info.append(el("dt", k), el("dd", v, testid ? { "data-testid": testid, class: "value" } : { class: "value" }));
  add("Host", r.host, "result-host");
  add("Status", r.status, "result-status");
  add(
    "Mode",
    r.classification === "failure-injection"
      ? "failure-injection: a fake scanner or core, not the real core"
      : r.classification === "negative-control"
        ? "negative control (an expected warn or refusal)"
        : "real core",
    "result-mode",
  );
  add("Duration", `${Number(r.durationMs) || 0} ms`);
  root.append(info);

  const passed = r.assertions.filter((a) => a.ok === true).length;
  root.append(
    el("p", `Assertions: ${passed} passed, ${r.assertions.length - passed} failed`, {
      "data-testid": "assertion-summary",
    }),
  );

  const comparisons = Array.isArray(r.evidence.comparisons) ? r.evidence.comparisons : [];
  if (comparisons.length > 0) {
    const table = el("table", null, { "data-testid": "comparisons" });
    table.append(el("caption", "Expected and actual results"));
    const head = el("tr");
    for (const h of ["Kind", "Check", "Expected", "Actual", "Match"]) head.append(el("th", h, { scope: "col" }));
    const thead = el("thead");
    thead.append(head);
    const tbody = el("tbody");
    for (const c of comparisons) {
      const kind = Object.hasOwn(KINDS, c.kind) ? c.kind : "other";
      const tr = el("tr", null, { "data-testid": "comparison", "data-kind": kind });
      const k = el("td");
      k.append(el("span", KINDS[kind][0], { class: `badge k-${kind}` }));
      tr.append(
        k,
        el("td", c.label),
        el("td", c.expected === null ? "null" : c.expected, { "data-testid": "expected", class: "value" }),
        el("td", c.actual === null ? "null" : c.actual, { "data-testid": "actual", class: "value" }),
        el("td", c.match === true ? "match" : "MISMATCH", {
          "data-testid": "match",
          class: c.match === true ? "" : "mismatch",
        }),
      );
      tbody.append(tr);
    }
    table.append(thead, tbody);
    root.append(table);

    const streams = comparisons.filter((c) => c.kind === "stream");
    if (streams.length > 0) {
      const done = r.status === "pass" && streams.every((c) => c.match === true);
      root.append(
        el(
          "p",
          `Staged stream: ${done ? "completed (finalized once)" : "not completed"}. Output is released only at finalize; nothing is shown progressively.`,
          { "data-testid": "stream-state", "data-complete": String(done) },
        ),
      );
    }
    const kinds = [...new Set(comparisons.map((c) => (Object.hasOwn(KINDS, c.kind) ? c.kind : "other")))].filter(
      (k) => KINDS[k][1],
    );
    if (kinds.length > 0) {
      const list = el("ul", null, { "data-testid": "guidance", "aria-label": "What these outcomes mean" });
      for (const k of kinds) list.append(el("li", `${KINDS[k][0]}: ${KINDS[k][1]}`));
      root.append(list);
    }
  }

  if (r.assertions.length > 0) {
    const list = el("ul", null, { "data-testid": "assertions", "aria-label": "Assertions" });
    for (const a of r.assertions)
      list.append(
        el("li", `${a.ok === true ? "ok" : "FAILED"}: ${a.name}${a.detail ? ` (${a.detail})` : ""}`, {
          "data-ok": String(a.ok === true),
        }),
      );
    root.append(list);
  }
  if (r.error)
    root.append(el("p", `Error ${r.error.code}: ${r.error.message}`, { "data-testid": "result-error", role: "alert" }));
  if (r.status === "unsupported")
    root.append(
      el("p", "Unsupported here: recorded as unsupported, never counted as a pass.", {
        "data-testid": "unsupported-note",
      }),
    );
  $("result").replaceChildren(root);
}

$("filter").addEventListener("input", applyFilter);
$("retry").addEventListener("click", () => {
  loadEnvironment();
  loadScenarios();
});
loadEnvironment();
loadScenarios();
