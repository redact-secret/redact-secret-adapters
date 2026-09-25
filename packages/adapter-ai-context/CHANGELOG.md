# Changelog

All notable changes to `@redact-secret/adapter-ai-context` are documented in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every package in this repository carries its own SemVer and is released
independently — see [ARCHITECTURE.md § Versioning](../../ARCHITECTURE.md#versioning).
A change to the range this package declares against `@redact-secret/core` is
always its own entry, naming the test that backs the new range, never folded
into a generic "bump dependency" line.

This package is not published yet: its manifest is `"private": true` and it
is not in the release plan. To release it for the first time, follow
[RELEASING.md § A brand-new npm package](../../RELEASING.md#a-brand-new-npm-package):
drop `"private"`, wire it into `scripts/release-plan.mjs`,
`scripts/release-notes.mjs` and `release.yml`, raise its
`@redact-secret/adapter` range to the first version that exports
`walkStrict`, and move the entries below under a version heading.

## [Unreleased]

### Added

- The framework-neutral AI-context boundary (redact-secret/redact-secret#610,
  redact-secret-adapters#12): `createAiContextBoundary(options)` (live: loads
  and initializes `@redact-secret/core` on call) and
  `createAiContextBoundaryWith(core, options)` (injected), each returning
  `sanitizeText`, `sanitizeValue`, `sanitizeToolResult`, `buildContext`, and
  `openStream`. Every operation ends in a frozen `ok` / `blocked` / `aborted`
  outcome with a fixed reason set (`BLOCK_REASONS`); findings cross the
  boundary as allowlisted copies (`SAFE_FINDING_FIELDS`); initialization,
  callback, lifecycle and limit failures map to fixed, input-free outcomes.
  Nested values go through `@redact-secret/adapter`'s `walkStrict`.
- `"tool-arguments"` in `BoundaryLabel`, for the arguments of a tool call
  (the MCP boundary's opt-in argument sanitation, redact-secret/redact-secret#612).
  Telemetry only; it never changes an outcome.
- `AiContextStream.accepting`: a read-only, input-free boolean that is `true`
  until the stream fails, is aborted, or is finalized, so a host can stop
  pulling from a producer whose output would be discarded unscanned
  (redact-secret/redact-secret#612).
- Qualified by replaying the core's `conformance/fixtures/ai-context-boundary.json`,
  vendored at core commit `0e3ba9592b6fa80fafdea47639921987c36ba323`
  (`fixtures/core/pins.json`), through the public API on the real core, before
  and after `initialize()`.
- Declared range: `@redact-secret/core ^0.1.0-beta.6`, as a required peer
  dependency, backed by the conformance replay and
  `test/e2e.test.ts` at both range endpoints in CI.
