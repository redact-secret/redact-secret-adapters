# Adapter consumer testbed

Developer and adoption tooling (epic #190). It installs the adapter packages
into clean Docker consumers, runs fixed synthetic scenarios against them, and
records exactly what was installed. It is not a product, does not accept input,
and makes no claim of general leak prevention or detection completeness (the
core owns detection; benchmarks owns accuracy and performance verdicts).

## Run it

Prerequisites: Docker with the Linux engine and Compose v2 (`docker info`,
`docker compose version`), Node 22/24 and git on the host, `npm ci` done at
the repository root, and registry access for the build (npm and PyPI; scenario
execution itself needs no network, the consumer network has no route out).

```sh
npm run testbed                       # candidate: this checkout, packed
npm run testbed -- --mode published   # the released versions pinned by examples/
```

Candidate mode runs `npm run build`, packs every adapter tarball, builds the
Python wheel in a pinned container, installs them in fresh consumer images,
starts the services, runs every registered scenario plus the Playwright specs,
and removes everything it created. Exit codes: `0` all passed, `1` an
assertion failed, `2` environment, install or startup failure, `130`
interrupted. Options: `--published name=version`, `--port N`, `--no-cache`,
`--keep`, `--wait-timeout S`, `--run-timeout S`, `--headed-debug` (see the
header of `run.mjs`). Every stage is bounded: the readiness wait, the test
stage (`--run-timeout`, default 900 s), each scenario, and each browser test.

Per-run output goes to `testbed/out/<runId>/` (git-ignored, last 5 kept):

| File | Content |
| --- | --- |
| `provenance.json` | mode, checkout SHA (and whether it was dirty), package names/versions/sha256 of every tarball and the wheel, the resolved identities each consumer reports (lockfile `resolved`/`integrity`, core and core-native versions), the runtime artifact the core reports, pinned base-image digests |
| `diagnostics.json` | the sanitized failure report (see "Failure diagnostics") |
| `report.json`, `reports/` | exit code, every scenario envelope, the Playwright JSON and HTML reports, traces and screenshots of failed tests, a few important-state screenshots |
| `service-logs.txt` | only on failure: the allowlisted service log lines |
| `artifacts/` | the exact tarballs, wheel and `manifest.json` that were installed |

Candidate evidence says something about this checkout; published evidence
says nothing about it. Each report states which one it is.

## Layout and boundaries

```text
testbed/
  run.mjs              the one-command runner
  compose.yaml         ui, node-consumer, python-consumer, runner (profile)
  contract/            result envelope (JSON Schema + Node/Python helpers), ID registry, sentinels
  manifests/           what to install: npm.d/*.json, python.d/*.json fragments
  services/
    ui/                minimal scenario UI shell (loopback port only)
    node-consumer/     install-and-verify.mjs, server.mjs, scenarios/*.mjs
    python-consumer/   install_and_verify.py, server.py, scenarios/*.py
    runner/            run-scenarios.mjs (API pass) and Playwright tests/*.spec.mjs
  scripts/             check-pack-isolation.mjs, check-registry.mjs
  test/                node --test unit tests of the contract
```

- Only the UI publishes a port, on `127.0.0.1` (`TESTBED_UI_PORT`, default
  first free from 18080). The consumers' control API (`:8081`) is reachable
  only inside the internal compose network; the UI never proxies it.
- No Docker socket, no privileged mode, all capabilities dropped, read-only
  root filesystems, memory/CPU/pid limits, bounded logs. The Playwright
  browser runs with `--no-sandbox` because the container deliberately lacks
  the privileges Chromium's sandbox needs; it only loads the testbed UI.
- Control routes, fixtures and servers live only under `testbed/`. They are
  never in a package's `files`, `exports` or tarball.
  `npm run testbed:check` enforces that for every workspace and the Python
  source, and each consumer re-checks its installed packages
  (`smoke.*-install-isolation`).
- Docker Linux is the qualification scope. It says nothing about macOS or
  Windows; the platform matrix stays in `smoke-test:platform` (#179).

## Clean installs (#193)

The consumer images are built from the staged artifacts only. The installers
(`install-and-verify.mjs`, `install_and_verify.py`) run inside the build and
fail it unless: each tarball/wheel exists and matches its recorded sha256;
every adapter resolved from that file (candidate) or from the registry at the
requested version (published); core and hosts are the exact pinned versions
(a prerelease core is never left to registry default resolution; npm runs
with `--legacy-peer-deps` so no peer is auto-installed); and `npm ls` /
`pip check` report nothing missing. Pins for the core and hosts are read from
the `examples/` manifests (#181), so the two cannot drift. Each run stages into
a fresh directory, and Docker layer caching is keyed on artifact content.

## The scenario UI and its journeys (#196)

The UI (`services/ui/`) is a developer shell, not a product. It lists the fixed
scenarios, runs one at a time, and shows the host's result: the environment
(Node, Python and the browser consumer with their adapter and core versions and
whether the evidence is candidate or published), whether a scenario uses the real
core or injects a fake one, the assertion summary, and an expected-versus-actual
table whose rows are labelled by what they show: masked, warn (unchanged), block,
limit, initialization failure, cancellation, staged stream, policy. A stream shows
"completed" only at finalize and never suggests progressive output. Each row
carries fixed recovery wording that points at `docs/troubleshooting.md`.

Rules the page follows, each covered by a journey in
`services/runner/tests/ui-journeys.spec.mjs` (test titles start with the fixed
`ui.*` IDs in `contract/ids/ui.json`):

- **Text only.** Every string from the API is set with `textContent`. The page
  serves a fixed hostile-string fixture (`ui.hostile-strings-fixture`); markup
  stays characters and `window.__xss` is never set. The CSP also forbids inline
  script and style.
- **No stale success.** Starting a run clears the previous result. A failed
  request, a 5xx, an invalid response or a timeout (`runTimeoutMs`, default
  30 s, bounded to 0.5 to 60 s in the query string) shows "unavailable" or
  "timed out" with a retry control, never the last green result.
- **Accessible and stable.** Labelled controls, a captioned table, live
  regions, keyboard operation, `data-testid` selectors.
- **Values, not labels.** A journey runs a scenario in the UI, compares the
  displayed expected and actual values with literals written in the spec, then
  runs the same scenario directly against the consumer's own API and requires
  the UI to show exactly what the host returned. Sentinel checks cover the
  console, every API response and the visible text; they do not cover the
  synthetic inputs, which live in the consumers, or the intentional warn and
  negative-control surfaces (those display a label such as "unchanged (warn)",
  never the value).
- **A wrong response fails the journey.** `ui.incorrect-response-fails-journey`
  tampers with the response three ways and requires the journey to throw.
  `--fault ui-wrong-response` does the same from the service side: the run must
  exit non-zero.

Screenshots are limited to a few important states (`reports/screenshots/`); the
assertions are the evidence. There is no free-text input, upload or user data:
the only input is a local filter box.

## Headed debugging

The browser stage runs headless inside the compose network. To watch it:

```sh
npm run testbed -- --headed-debug      # builds, starts, publishes loopback ports, leaves it running
```

It prints the exact commands. In short, install Playwright on the host once
(`cd testbed/services/runner && npm ci && npx playwright install chromium`) and
run `npx playwright test --headed ui-journeys` (add `--debug` to step through)
with the printed `TESTBED_*` variables. `--headed-debug` publishes the
consumers' scenario API (never the control API) on `127.0.0.1` next to the UI.
Clean up with the printed `docker compose ... down` command. This is a
Linux-container-backed, Chromium-only workflow; it is not a CI mode.

## Interpreting unavailable browser support

The browser lane reports one of `supported/pass`, `blocked-by-packaging` or
`failed` (`reports/browser-lane.json`, the UI's browser card, `diagnostics.json`).
`blocked-by-packaging` means the installed packages could not be bundled for a
browser with the core's WebAssembly assets; the tests fail with that explicit
reason and no server request stands in for the browser. It is a statement about
those package versions in this lane, not about other bundlers, browsers or
platforms. `failed` means a bundled export loaded but an assertion did not hold.
"Browser support: unavailable" on the UI card means the browser consumer service
did not answer, which is an environment problem, not packaging evidence.

## Adding scenarios (#194, #195, #196)

A scenario is a fixed ID plus a module. Nothing outside your own files changes.

1. **ID**: `contract/namespaces.json` already reserves `pino` and `pylog`
   (#194), `aictx` and `browser` (#195), `ui` (#196). List your IDs and host in
   your namespace file `contract/ids/<namespace>.json` (one file per
   namespace, so parallel work does not conflict).
2. **Module**: add `services/node-consumer/scenarios/<name>.mjs` exporting
   `scenarios = [{ id, title, classification, run(ctx, rec) }]`, or
   `services/python-consumer/scenarios/<name>.py` with `SCENARIOS = [...]`.
   Modules are auto-discovered; startup fails if an ID is malformed, outside
   the host's namespaces, unlisted in `contract/ids/`, or duplicated, or if a
   listed ID has no module.
3. **Assert on final outputs**: `rec.check(name, ok, detail)` (detail is kept
   only for failures and must be a fixed label), `rec.evidence` for small
   fixed-shape facts (8 KiB cap), `ctx.captures` (bounded) for the final
   destination, `rec.unsupported(reason)` to record an unsupported path.
   Sentinels listed in `contract/sentinels.d/*.json` are scrubbed from every
   result string; add a file there for a new sentinel family.
   `rec.compare(label, expected, actual, kind)` records an assertion that the two
   are equal and shows the pair, labelled by `kind`, in the UI. Pass only
   display-safe primitives: a sanitized output, a placeholder or a fixed label
   (`"blocked/limit_exceeded"`, `"unchanged (warn)"`), never a raw input or a
   warn-control plaintext. To give a scenario a UI journey, add a `ui.*` ID to
   `contract/ids/ui.json` and a test with that ID as its title prefix in
   `services/runner/tests/ui-journeys.spec.mjs`. Classify
   intentional warn/negative controls as `negative-control` and fake scanners
   as `failure-injection`.
4. **More packages**: add `manifests/npm.d/<name>.json` or
   `manifests/python.d/<name>.json` (adapters, hosts); the extra packages are
   packed/pinned and verified like the base set.
5. **Another service** (for example the browser/WASM consumer): add
   `services/<name>/compose.yaml`; the runner discovers it and includes it
   (paths in a fragment are relative to `testbed/`). Put Playwright journeys
   in `services/runner/tests/*.spec.mjs`.
6. A new Node dependency for scenario code must be added through a manifest
   fragment, never installed ad hoc; scenario code runs from the consumer
   directory, outside `node_modules`.

PII activation is process-wide and one-shot, so a scenario needing it must run
in its own process (a separate service or child process), not in the shared
consumer process.

## AI-context server and browser/WASM lanes (#195)

`aictx.*` (Node consumer, `scenarios/aictx.mjs`) runs the installed
`adapter-ai-context` over the real core: text, key-aware structured values,
multi-part contexts, ok / blocked / aborted, policy warn and block (default and
explicit), whole-input / traversal / stream limits, initialization failures,
unsupported values, and incremental `append` / `finalize` / `abort` with
`accepting=false` producer shutdown and no release before `finalize`. A stub
downstream recipient receives only `ok.value`. PII configurations run in
their own child process (`lib/aictx-child.mjs`).

The **browser lane** is separate: the `browser-consumer` service installs the
same artifacts, bundles them with esbuild (`platform: "browser"`, ESM),
serves the bundle and the core's real `.wasm` files over a same-origin-only
CSP, and Playwright loads it in Chromium (one browser context per PII
configuration). `browser.*` IDs are Playwright tests in
`services/runner/tests/aictx-browser.spec.mjs`; the runner writes
`reports/browser-lane.json` and `report.json` carries it as `browserLane`.

- **Status is explicit**: `supported/pass`, `blocked-by-packaging` (the
  bundle or the `.wasm` assets cannot be produced from the installed
  release; the tests fail with that reason and no server request is
  substituted), or `failed`. A missing lane report is reported as absent and
  the run fails. Nothing is silently skipped.
- **Parity**: the browser and the Node server hash the same shared synthetic
  cases (`contract/aictx-cases.mjs`: Unicode, key-aware values, every stream
  split, limits, block) with PII off and on; values themselves are never
  recorded, and the test fails on any difference.
- **Version awareness**: assertions cover only what the installed artifacts
  support. `aictx.candidate-features` (occurrence provenance, operation
  budget, readiness check) fails in candidate mode if missing and is reported
  `unsupported` (counted separately, never a pass) against the pinned release.
- **Not shown**: Chromium only, esbuild only, Linux containers. This verifies
  consumer integration; the core's conformance suite stays authoritative.

## Updating pins

Base images are pinned by tag and digest in the Dockerfiles
(`node:22.16.0-bookworm-slim`, `python:3.12.11-slim-bookworm`,
`mcr.microsoft.com/playwright:v1.55.0-noble`). To update one: pick the new
tag, take its digest with `docker buildx imagetools inspect <image>:<tag>`,
change tag and digest together, and for Playwright change
`services/runner/package.json` to the same version and refresh its lockfile
(`npm install --package-lock-only`). Core, pino and published adapter pins
move with the `examples/` manifests.

## Failure diagnostics (#197)

Every run writes `diagnostics.json`, built by `lib/diagnostics.mjs` from an
allowlist in the format of `scripts/support-summary.mjs` (#186): the outcome
(`pass`, `assertion-failed`, `environment-failed`), the failed stage
(`stage-artifacts`, `build`, `start`, `run`), the fault if one was injected, the
checkout SHA and dirty flag, package names, versions and sha256 of the installed
artifacts, scenario IDs with their status and the names of failed assertions,
journey titles with their status, the browser lane status, and each consumer's
installed packages as a #186 support summary. It never copies an environment
variable, an exception or assertion message, a path, a host name or a log line:
service logs are reduced to the lines the services print on purpose
(`... consumer ready: ...`, `testbed fault injection: ...`), the rest is only
counted. An install failure is reduced to the installer's one fixed
`INSTALL VERIFICATION FAILED:` line, restricted to plain characters.

The Playwright report, traces and screenshots are uploaded by CI only for a failed
run, and contain what the pages showed: scrubbed, bounded results of fixed
synthetic scenarios. Do not add a step that uploads container logs or the staged
tarballs.

## Failure paths (self-test)

`--fault <name>` deliberately breaks one guarantee. The run must exit non-zero,
write `diagnostics.json` naming the stage, and still clean up:

| Fault | What it breaks | Expected |
| --- | --- | --- |
| `missing-artifact` | a staged tarball disappears after hashing | exit 2, stage `build`, install failure line |
| `missing-peer`, `wrong-mode`, `broken-exports` | the clean install | exit 2, stage `build`, install failure line |
| `startup-failure` | a consumer exits at startup | exit 2, stage `start` |
| `wrong-expectation` | every `rec.compare` expected value is replaced | exit 1, stage `run`, failed assertions named |
| `ui-wrong-response` | the UI service returns a wrong value and status | exit 1, stage `run`, `ui.*` journeys failed |

The extended CI suite runs all of them and fails if any exits zero. Do not use a
fault for anything else.

## CI (#197)

`.github/workflows/testbed.yml`; actions are pinned by SHA like the other
workflows; Linux (`ubuntu-latest`) only, and no OS or Node matrix is added.

| Suite | When | What | Bound |
| --- | --- | --- | --- |
| PR suite (`Testbed PR suite`) | pull requests that touch `testbed/`, `packages/`, `python/`, `examples/`, the lockfile or the workflow | `testbed:check`, `testbed:test`, then `npm run testbed` (candidate) in one job | 25 min job, 600 s test stage |
| Extended, published | manual dispatch, weekly | `--mode published` | 30 min |
| Extended, candidate | manual dispatch, weekly | `--no-cache` run, then every `--fault` self-test | 60 min |

The PR suite is deliberately **not** in the `CI passed` gate. A path-filtered
workflow that does not run cannot be a required check, and the gate stays exactly
what it was. Once the suite has a record of stable runs, promote it by moving the
job into `ci.yml` and adding it to the `needs` list of `ci-passed`.

Retries never hide a deterministic failure: Playwright retries are 0 and no job is
re-run automatically. Artifacts: a run summary (`diagnostics.json`,
`provenance.json`, `report.json`) every time, and on failure the Playwright
report, traces, screenshots and the allowlisted service log lines, for 7 days
(PR) or 14 days (extended). Docker layers are keyed on the staged artifacts'
content and CI keeps no layer cache between runs, so a stale install cannot pass;
the extended suite also builds with `--no-cache`.

To reproduce a CI failure on a clean checkout: `npm ci`, then `npm run testbed`
(add `-- --mode published` for the extended published job), and compare
`diagnostics.json`, whose `checkout.sha` and package sha256 values identify what
was installed. Candidate and published evidence are never interchangeable.

## What this does and does not show

The evidence is for Linux containers and Chromium only: packed or published
packages installed in clean consumers and exercised through fixed synthetic
scenarios, with the final output of each host asserted independently of the UI. It
says nothing about macOS or Windows (see `smoke-test:platform`, #179), other
browsers, other bundlers, detection accuracy, false positives or performance (the
core and the benchmarks repository own those), and it is not a claim of general
leak prevention. OpenTelemetry and MCP are not covered yet.
