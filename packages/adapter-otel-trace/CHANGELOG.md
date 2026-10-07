# Changelog

All notable changes to `@redact-secret/adapter-otel-trace` are documented in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every package in this repository carries its own SemVer and is released
independently — see [ARCHITECTURE.md § Versioning](../../ARCHITECTURE.md#versioning).
A change to the range this package declares against
`@opentelemetry/sdk-trace-base` or against `@redact-secret/core` is always its
own entry, naming the test that backs the new range, never folded into a
generic "bump dependency" line.

To release: in a PR into `develop`, move this section's `Unreleased`
entries under a new `## [x.y.z] - YYYY-MM-DD` heading matching the version
bumped in `package.json`. The next release train publishes and tags every
package whose declared version isn't on its registry yet — see
[RELEASING.md](../../RELEASING.md). This file ships inside the published
tarball (`files` in `package.json`), so a consumer can read it from
`node_modules` without leaving their editor.

This package's code shipped as `@redact-secret/adapter-otel` `0.1.0` to
`0.1.2`; that history is in
[`packages/adapter-otel/CHANGELOG.md`](../adapter-otel/CHANGELOG.md). Its
version numbers start again here, at `0.1.0`, and do not follow the old name's.

## [Unreleased]

### Changed

- `createRedactingSpanProcessor`: an injected `scanConfig` beside any loose scan option (`policy`, `actionPolicy`, `scanLimits`, `ruleset`, `placeholderFormatter`) is rejected with a fixed `TypeError` before the core is loaded, instead of the config silently winning; the injected configuration is the one verified against the core (redact-secret-adapters#213). Needs `@redact-secret/adapter` with `scanConfigOf`. Test: `test/injected-scan-config-live.test.ts`.

### Added

- `actionPolicy` on `createRedactingSpanProcessor`, applied to every string of a span (name, attributes, events, links), with the shared snapshot, callback-conflict and capability checks of `@redact-secret/adapter` (redact-secret-adapters#217). Needs `@redact-secret/core` 0.1.0-beta.14 or later (the first published release that accepts it); an older core is rejected by name with `CoreOptionsError` (`CORE_OPTION_UNSUPPORTED`) and every other option keeps working on the declared floor. The package range is unchanged; the new tests in `compatibility.json` run at both endpoints (the option applies at the upper one, is rejected at the lower one). Test: `test/action-policy-live.test.ts` (the exported span for each action).

## [0.1.3] - 2026-10-03
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.13. No API or range change.

## [0.1.2] - 2026-10-02

### Added

- **One aggregate budget per span** (redact-secret/redact-secret-adapters#173), shared by the span name, every attribute, event and link and the status message. `operationLimits` overrides it (defaults as in `@redact-secret/adapter`); `redactAttributesWith` takes it for its one bag. A span ended re-entrantly inside the next processor has its own budget.

- **Verified core scan options** (redact-secret/redact-secret-adapters#175): `createRedactingSpanProcessor`, `RedactingSpanProcessorWith` and `redactAttributesWith` take `scanLimits`, `ruleset` and `placeholderFormatter` (and still `policy`), validated and snapshotted once. The live factory rejects an unsupported core, or a ruleset or limits the core refuses, with a fixed `CoreOptionsError`. Available from the declared core floor, verified at both endpoints by `test/scan-options-live.test.ts`. Omit them and nothing changes.

### Changed

- **Key-aware detection** (redact-secret/redact-secret-adapters#172). A string attribute value on a span, event or link is now scanned with its attribute name as detection context, through the shared primitive in `@redact-secret/adapter`, so a context-dependent credential (`api_key`, `password`) is masked. The attribute name is never rewritten or output; string-array elements, the span name, event names and the status message have no direct key and are scanned as before. Cost: a string attribute is scanned twice unless its own scan already redacted or blocked it.

- **Behavior change with defaults:** a span that inspects more than the default budget now has every string not yet inspected replaced by `[REDACTED:LIMIT_EXCEEDED]` (counted as `limited`), and is still forwarded. Before, a span's only bound was `maxStringLength` per string.

- **Dependency range raised: `@redact-secret/adapter` `^0.1.3` -> `^0.1.7`** (redact-secret/redact-secret-adapters#172, #173, #175). This release needs the key-context primitive, the operation budget and the scan options that `@redact-secret/adapter` 0.1.7 introduces, which no earlier published version has; against `0.1.3` the package fails to import. Backed by the `published-combination` CI job (`scripts/check-published-combination.mjs`), which installs this package with the lowest published sibling its range admits (and this checkout's tarball for a sibling not yet published). No `@redact-secret/core` range change.

## [0.1.1] - 2026-10-01
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.12, which carries the core's performance improvements; they reach this package through the unchanged core range. No API or range change.

## [0.1.0] - 2026-09-30
### Added

- The package, under a name that says what it covers: OpenTelemetry JS
  **traces** (redact-secret/redact-secret-adapters#49). It is the code
  `@redact-secret/adapter-otel` `0.1.2` shipped, unchanged: the same
  `createRedactingSpanProcessor`, `RedactingSpanProcessorWith`,
  `redactAttributesWith`, options (`policy`, `maxStringLength`, `onOutcome`,
  and `pii` on the live factory) and outcome shape, and the same
  `REDACT_SECRET_SPAN_DROPPED` warning, whose message still begins
  `@redact-secret/adapter-otel:` so a filter written against it keeps
  matching. It protects spans only — the span name, attributes, events, status
  message and link attributes. OpenTelemetry Logs (`LogRecord`s) pass through
  no code in this package.
- Declares `@opentelemetry/sdk-trace-base` `^2.0.0` and `@redact-secret/core`
  `^0.1.0-beta.6`, the ranges `adapter-otel` `0.1.2` declared, backed by the
  same real-host tests (`test/otel-host.test.ts`, `test/otel-lifecycle.test.ts`,
  `test/outcome.test.ts`, `test/vault-token.test.ts`), which CI runs at both
  ends of each range. `test/exporter-bytes.test.ts` adds the final OTLP JSON
  bytes an exporter would send, for the injected and the live factory, through
  both `SimpleSpanProcessor` and `BatchSpanProcessor`.
