# Changelog

All notable changes to `@redact-secret/adapter-ai-context` are documented in
this file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every package in this repository carries its own SemVer and is released
independently — see [ARCHITECTURE.md § Versioning](../../ARCHITECTURE.md#versioning).
A change to the range this package declares against `@redact-secret/core` is
always its own entry, naming the test that backs the new range, never folded
into a generic "bump dependency" line.

Its first release is the prerelease `0.1.0-alpha`, published under the npm
dist-tag `alpha` (install it as `@alpha` or by exact version); `latest` is
not moved by a prerelease ([RELEASING.md § Prereleases and npm dist-tags](../../RELEASING.md#prereleases-and-npm-dist-tags)).

## [Unreleased]

### Changed

- **Contract change: key-aware `sanitizeValue`** (redact-secret/redact-secret#842,
  redact-secret-adapters#32). A string leaf under an object key that its own
  scan does not redact is scanned once more, through the same
  `scanAndRedact`, in its key-context view `{"<key>":"<leaf>"}`; a finding
  there is redacted at the leaf, with leaf offsets. Only the immediate key
  counts (array elements, parent and sibling keys give none), a finding
  outside the leaf's span that would redact or block blocks as `policy`, and
  a view over `maxInputBytes` blocks as `limit_exceeded`. No key pattern or
  name list is added: the core decides. **Migration:** a leaf that passed in
  plaintext because only its key identified it (`{"password": "<value>"}`)
  is now replaced by a placeholder and reported in `ok.findings` and
  telemetry; nothing previously redacted or blocked passes. Qualified by the
  core fixture vendored at the #842 commit
  (`packages/adapter-ai-context/test/conformance.test.ts`) at both core range
  endpoints.
- Requires the key-aware `walkStrict` of `@redact-secret/adapter` (its
  Unreleased entry). The release that ships this change must raise this
  package's `@redact-secret/adapter` range to the version that carries it;
  against `0.1.1` the walker passes no key and the leaf pass silently loses
  key context.

## [0.1.0-alpha] - 2026-09-25

First release, as a prerelease.

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
- Depends on `@redact-secret/adapter ^0.1.1`, the first version that exports
  `walkStrict`. `0.1.0` lacks it, so the import failed against it.
