---
decision_id: decision-name-the-otel-trace-adapter-for-what-it-covers
status: accepted
scope: adapters
title: Name the OpenTelemetry trace adapter for what it covers
decided_at: 2026-09-30
issue: redact-secret/redact-secret-adapters#49
---
# Name the OpenTelemetry trace adapter for what it covers

This repository had no decision records before this one. It follows the
convention of the core repository's `docs/decisions/`: one file per decision,
named `<slug>.md` (the date lives in `decided_at` in the front matter, not in the file name), with the front matter above.

## Decision

Publish the OpenTelemetry JS span processor as a new package,
**`@redact-secret/adapter-otel-trace`**, starting at `0.1.0`, and turn
**`@redact-secret/adapter-otel`** into a compatibility package that re-exports
it unchanged and is deprecated (option a in #49).

- `packages/adapter-otel-trace` holds the code `adapter-otel` `0.1.2` shipped,
  with no behavior change: the same exports, options, outcome shape, fail-closed
  markers, `REDACT_SECRET_SPAN_DROPPED` warning (whose message keeps its
  `@redact-secret/adapter-otel:` prefix, so a filter written against it still
  matches), and the same peer ranges, `@opentelemetry/sdk-trace-base ^2.0.0` and
  `@redact-secret/core ^0.1.0-beta.6`. It depends on `@redact-secret/adapter`
  `^0.1.3`, as before.
- `packages/adapter-otel` keeps its name, its peer ranges and its version line.
  Its source is now a re-export of `@redact-secret/adapter-otel-trace`
  (dependency `^0.1.0`): the same functions and the same
  `RedactingSpanProcessorWith` class object. Every export carries `@deprecated`
  in its declarations. Nothing is printed at import or call time; the package
  stays side-effect free (`sideEffects: false`, and the
  [security boundary](../../ARCHITECTURE.md#security-boundary) forbids an
  adapter doing telemetry of its own).
- `@redact-secret/adapter-otel-logs` stays a reserved design topic. Nothing
  here implements OpenTelemetry Logs, and the docs say so wherever the trace
  adapter is offered.

## Options compared

| | (a) new `adapter-otel-trace` + `adapter-otel` shim | (b) keep `adapter-otel`, add an explicit trace entry point (`@redact-secret/adapter-otel/trace`) |
| --- | --- | --- |
| Name says trace-only (acceptance 2) | Yes: the package a consumer installs and imports is named for traces. | No. The installed package, the npm page, the badge and every `package.json` still read `adapter-otel`; `/trace` is visible only in an import line, and the root entry point would have to stay for compatibility, so the ambiguous import keeps working and keeps being copied. |
| Existing consumers (acceptance 1) | Unaffected. `adapter-otel@0.1.2` stays on npm as it is; its next release re-exports the same objects, within `^0.1.x`, under the same peer ranges. Tested by export identity and by identical OTLP bytes (below). | Unaffected. |
| Room for `adapter-otel-logs` | A sibling package with its own version, host peer (`@opentelemetry/sdk-logs`) and qualification. | A `/logs` subpath of the same package would share one version and one peer set with traces: a Logs SDK move would re-release the trace processor, and the peer list would force the Logs SDK on trace-only users (or make it optional and untyped). |
| Lockstep coupling (acceptance 4) | None added. `adapter-otel` depends on `adapter-otel-trace` by caret range (`^0.1.0`), the pattern `adapter-mcp` → `adapter-ai-context` already uses; the trace package ships without the shim and the shim ships only when someone bumps it. | None added. |
| Release cost | One more npm package, publish job, tag, changelog, compatibility record and feed entry. **Its first publish cannot come from `release.yml`** (see below). | None. |
| Consumer cost | A dependency swap and an import-specifier change, whenever they choose. | An import-specifier change. |

Option (a) is chosen because (b) cannot satisfy "the package's name accurately
says trace-only" — the name stays `adapter-otel` — and because it would put a
future Logs integration in the same version line and peer set as traces, the
coupling ARCHITECTURE.md § Versioning exists to avoid. The consumer risk of (a)
is held at zero for existing users by the shim: nothing they install today
changes until `adapter-otel` is bumped, and when it is, the bump is a
re-export of byte-identical behavior.

## Evidence

- `packages/adapter-otel/test/compat-shim.test.ts` imports both names by
  package name, as a consumer does, and checks the export list, identity of
  every export, `instanceof` across names, and that one span through a real
  `BasicTracerProvider` → `BatchSpanProcessor` produces the same OTLP/JSON
  request bytes (`@opentelemetry/otlp-transformer`'s `JsonTraceSerializer`,
  per-run ids and timestamps removed) through either name, with the injected
  scanner and with the live factory on the real core.
- `packages/adapter-otel-trace/test/exporter-bytes.test.ts` asserts on those
  OTLP bytes directly, through `SimpleSpanProcessor` and `BatchSpanProcessor`,
  injected and live. The existing real-host tests moved with the code.
- CI's `range-endpoints` job runs all of that at the lowest and highest
  `@opentelemetry/sdk-trace-base` (2.0.0, 2.11.0) and `@redact-secret/core`
  (0.1.0-beta.6, 0.1.0-beta.11).
- `npm run smoke-test` installs the packed tarballs outside the repository,
  runs the `adapter-otel-trace` README example verbatim and reads its OTLP
  bytes, typechecks a consumer against both names, and compares the exported
  spans of the `adapter-otel-trace` tarball, the `adapter-otel` tarball and
  **the `@redact-secret/adapter-otel` release currently on npm** (installed in
  its own project with its own published dependencies). All three must match.
- `npm run published-combination` installs the `adapter-otel` tarball with the
  lowest published `adapter-otel-trace` its range admits (this checkout's
  tarball until `0.1.0` is on npm) and checks the re-export.

## npm first publication and the release train

- **Trusted publishing cannot do the first publish.** npm only accepts a trusted
  publisher on a package that already exists, so `release.yml` would fail with
  `E404` on `@redact-secret/adapter-otel-trace@0.1.0` (RELEASING.md, "A
  brand-new npm package"). `0.1.0` has to be published by hand once, from the
  `rc/<train>` head, and has no provenance attestation; the trusted publisher
  is then added on npmjs.com, and every later version publishes with
  provenance from `release.yml`.
- **It lands unreleased, so no train is held hostage.** Following the
  repository's convention for a new package (as `adapter-ai-context` and
  `adapter-mcp` did), `adapter-otel-trace` is `"private": true` at `0.1.0` and
  absent from `PACKAGES` in `scripts/release-plan.mjs`. Declaring it
  releasable now would put it in the plan of every train until its first
  publish, and `cut-rc` refuses a planned package without a `## [0.1.0]`
  CHANGELOG heading — so a pino or MCP train would be blocked on an OTel
  release. That is the coupling #41 rules out. Everything else is wired and
  inert: `release.yml`'s provenance publish job (after `adapter`, before
  `adapter-otel`), the rehearsal dry run, tags, the report row, release notes,
  the compatibility record, the pack, smoke and published-combination checks,
  and the footprint harness. Releasing it is one PR (drop `private`, uncomment
  its `PACKAGES` entry, date its CHANGELOG, regenerate the feed) plus the
  bootstrap.
- **The shim cannot ship first.** `adapter-otel` stays at `0.1.2` on
  `develop`, so nothing `@redact-secret/adapter-otel` consumers install changes
  until someone bumps it. The release plan now refuses a train that would
  publish a package depending on an unreleased workspace package
  (`unreleasedDependencies` in `scripts/release-plan.mjs`), so bumping
  `adapter-otel` before `adapter-otel-trace` is released stops the cut instead
  of shipping a package whose dependency is not on npm. After the trace
  package is out, bumping `adapter-otel` (to `0.1.3`) ships the re-export; its
  publish job waits for `adapter-otel-trace`'s. `npm deprecate` on the old name
  comes after that, scoped to the re-export versions.
- The registry-side deprecation is a message, not a block: `npm install` still
  succeeds and prints it.
- Until the trace package is released, the site feed lists `adapter-otel`
  without a sibling dependency: the feed only names released siblings, and the
  manifest on `develop` depends on the unreleased trace package.

## Consequences

- Existing `@redact-secret/adapter-otel` users need do nothing now, and after
  the shim ships they get the same processor with a deprecation notice. The
  migration is `npm install @redact-secret/adapter-otel-trace` and an
  import-specifier change, documented in both packages' READMEs.
- Mixing both names in one process is safe: with the shim they are the same
  objects; with `adapter-otel@0.1.2` they are two copies of the same code.
- A consumer who reads the Python package: `redact_secret_adapters.otel` keeps
  its module name. It is also a span processor only, and the repository README
  now says OpenTelemetry Logs are not covered in either language.
- Removing `@redact-secret/adapter-otel` altogether is not part of this
  decision. It stays published and resolvable; retiring it would be a separate
  decision with its own notice period.

## Status update (2026-10-07)

The decision stands. The statements above about "lands unreleased", the shim
"staying at `0.1.2`" and the site feed listing no sibling are as of 2026-09-30
and are superseded: `adapter-otel-trace` is on npm (`0.1.4`), `adapter-otel`
re-exports it (`0.1.7`) with the registry deprecation in place, and
`@redact-secret/adapter-otel-logs` is no longer only a reserved design topic;
see [the OpenTelemetry Logs decision](./otel-logs-adapter-design-and-sdk-probe.md).
