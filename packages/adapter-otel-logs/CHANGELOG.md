# Changelog

All notable changes to `@redact-secret/adapter-otel-logs` are documented in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every package in this repository carries its own SemVer and is released
independently — see [ARCHITECTURE.md § Versioning](../../ARCHITECTURE.md#versioning).
A change to the range this package declares against
`@opentelemetry/sdk-logs` or against `@redact-secret/core` is always its own
entry, naming the test that backs the new range, never folded into a generic
"bump dependency" line.

`0.1.0-beta.2` was published to npm by hand (dist-tag `beta`) and the package
is in the release plan (`scripts/release-plan.mjs`), so the next train tags it
without republishing it. It depends on `@redact-secret/adapter` `^0.1.7`, which
publishes in that train. See
[RELEASING.md](../../RELEASING.md#a-brand-new-npm-package).

## [Unreleased]

### Changed

- `createRedactingLogRecordProcessor`: an injected `scanConfig` beside any loose scan option (`policy`, `actionPolicy`, `scanLimits`, `ruleset`, `placeholderFormatter`) is rejected with a fixed `TypeError` before the core is loaded, instead of the config silently winning; the injected configuration is the one verified against the core (redact-secret-adapters#213). Needs `@redact-secret/adapter` with `scanConfigOf`. Test: `test/injected-scan-config-live.test.ts`.

### Added

- `actionPolicy` on `createRedactingLogRecordProcessor`, applied to every string of a log record, with the shared snapshot, callback-conflict and capability checks of `@redact-secret/adapter` (redact-secret-adapters#217). Needs `@redact-secret/core` 0.1.0-beta.14 or later (the first published release that accepts it); an older core is rejected by name with `CoreOptionsError` (`CORE_OPTION_UNSUPPORTED`) and every other option keeps working on the declared floor. The package range is unchanged; the new tests in `compatibility.json` run at both endpoints (the option applies at the upper one, is rejected at the lower one). Test: `test/action-policy-live.test.ts` (the exported record for each action).

### Fixed

- The processor now resolves one scan configuration at construction and passes it to every leaf, so `scanLimits`, `ruleset` and `placeholderFormatter` (typed by `MaskLeafOptions` but previously not forwarded to the core by this package) now reach the core, and the live factory rejects an unsupported or refused option with `CoreOptionsError` as the pino and trace adapters do. Only `policy` was forwarded before.

## [0.1.0-beta.3] - 2026-10-03
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.13. No API or range change.

## [0.1.0-beta.2] - 2026-10-02

### Added

- `RedactingLogRecordProcessorWith` and `createRedactingLogRecordProcessor`
  (redact-secret/redact-secret-adapters#178): a `LogRecordProcessor` wrapper
  that redacts a log record's body (strings, structured values and bytes),
  severity text, event name and every attribute value in `onEmit`, before the
  next processor sees the record, with the shared fail-closed markers, per-record
  walk budgets, a read-back of every write (a record that will not take a
  masked write is dropped, never forwarded), PII activation through the shared
  `activateCore`, and `onOutcome`, one input-free summary per log record.
  Resource attributes, instrumentation scope, attribute keys, spans and metrics
  are not covered, and the README says so.
- Declares `@opentelemetry/sdk-logs` `>=0.200.0 <=0.222.0` and
  `@redact-secret/core` `^0.1.0-beta.6` as peers, qualified at both endpoints
  of each (0.200.0 and 0.222.0; core 0.1.0-beta.6 and 0.1.0-beta.12) by
  `test/otel-host.test.ts`, `test/exporter-bytes.test.ts`,
  `test/pii-live.test.ts` and `test/pii-activation.test.ts`: real
  `LoggerProvider`, `SimpleLogRecordProcessor` and `BatchLogRecordProcessor`,
  and the OTLP/JSON bytes an exporter sends.
