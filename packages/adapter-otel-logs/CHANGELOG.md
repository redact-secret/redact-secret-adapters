# Changelog

All notable changes to `@redact-secret/adapter-otel-logs` are documented in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every package in this repository carries its own SemVer and is released
independently — see [ARCHITECTURE.md § Versioning](../../ARCHITECTURE.md#versioning).
A change to the range this package declares against
`@opentelemetry/sdk-logs` or against `@redact-secret/core` is always its own
entry, naming the test that backs the new range, never folded into a generic
"bump dependency" line.

This package is **not released**: its manifest says `"private": true` and it
is absent from the release plan (`scripts/release-plan.mjs`), so no train
publishes it. [RELEASING.md](../../RELEASING.md#a-brand-new-npm-package)
describes how it is wired in. When it is, move this section's `Unreleased`
entries under a new `## [x.y.z] - YYYY-MM-DD` heading matching the version in
`package.json`.

## [Unreleased]

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
