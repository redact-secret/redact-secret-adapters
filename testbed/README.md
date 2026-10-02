# Adapter consumer testbed

Developer and adoption tooling (epic #190). It installs the adapter packages
into clean Docker consumers, runs fixed synthetic scenarios against them, and
records exactly what was installed. It is not a product, does not accept input,
and makes no claim of general leak prevention or detection completeness (the
core owns detection; benchmarks owns accuracy and performance verdicts).

## Run it

Prerequisites: Docker with the Linux engine and Compose v2 (`docker info`,
`docker compose version`), Node 20/22/24 and git on the host, `npm ci` done at
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
`--keep`, `--wait-timeout S` (see the header of `run.mjs`).

Per-run output goes to `testbed/out/<runId>/` (git-ignored, last 5 kept):

| File | Content |
| --- | --- |
| `provenance.json` | mode, checkout SHA (and whether it was dirty), package names/versions/sha256 of every tarball and the wheel, the resolved identities each consumer reports (lockfile `resolved`/`integrity`, core and core-native versions), the runtime artifact the core reports, pinned base-image digests |
| `report.json`, `reports/` | exit code, every scenario envelope, the Playwright JSON report |
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
   result string; add a file there for a new sentinel family. Classify
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

## Updating pins

Base images are pinned by tag and digest in the Dockerfiles
(`node:22.16.0-bookworm-slim`, `python:3.12.11-slim-bookworm`,
`mcr.microsoft.com/playwright:v1.55.0-noble`). To update one: pick the new
tag, take its digest with `docker buildx imagetools inspect <image>:<tag>`,
change tag and digest together, and for Playwright change
`services/runner/package.json` to the same version and refresh its lockfile
(`npm install --package-lock-only`). Core, pino and published adapter pins
move with the `examples/` manifests.

## Self-test of the failure paths

`--fault missing-artifact | missing-peer | wrong-mode | broken-exports |
startup-failure` deliberately breaks one guarantee; the run must exit
non-zero and still clean up. Do not use it for anything else.
