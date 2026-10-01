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
