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

### Added

- `pii` on `createAiContextBoundary`, carried by
  `AiContextBoundaryOptionsWithDefaults`
  (redact-secret/redact-secret-adapters#51). It activates core PII
  selectors for the whole process through `@redact-secret/adapter`'s
  `activateCore`. The factory's contract of never rejecting is unchanged:
  a selection that cannot be shown to be active is an initialization
  failure like any other, so every operation fails closed as `blocked` /
  `core_error` with no `code`, rather than quietly building context with
  PII off. `pii` is read by property, so an activation inherited through a
  prototype survives, the same rule `withDefaultLimits` follows.

### Fixed

- An application that had already run `initialize({ pii })` got a boundary
  that blocked everything: the factory's own argument-free `initialize()`
  is a different selection to the core's one-shot cell and rejected with
  `PII_ACTIVATION_CONFLICT`, which this package maps to a fail-closed
  `blocked` / `core_error` — a silently blocked boundary rather than a
  visible error. That conflict now counts as success, since it means the
  core is already loaded under the application's own selection. Every
  other initialization failure still fails closed exactly as before.

### Changed

- The declared `@redact-secret/adapter` range rises to `^0.1.3`, the
  version that carries `activateCore`. The declared
  `@redact-secret/core` range is unchanged at `^0.1.0-beta.6`.

### Documented

- Activating PII is not the same as masking every PII value: under the
  core's default policy `High`-confidence PII redacts while `Medium` and
  `Low` resolve to `warn`, and a `warn` finding leaves the text alone, so
  an `ok` outcome can carry findings whose text was not changed and
  lower-confidence PII reaches the model as plaintext. Supply your own
  `policy` mapping those findings to `redact` if you need them masked.

## [0.1.0-alpha.2] - 2026-09-27

### Added

- `AI_CONTEXT_DEFAULT_LIMITS` and `withDefaultLimits(options?)`, and
  `createAiContextBoundary(options?)` now fills in any of the three limit sets
  a caller leaves out (redact-secret/redact-secret-adapters#46). A new
  integration no longer has to invent four security numbers before its first
  `sanitizeText`. The values are the ones this repository has been exercising
  all along — the README example, the clean-install smoke test, and the core's
  conformance replay.
- The `AiContextLimits` and `AiContextBoundaryOptionsWithDefaults` types.

### Fixed

- `withDefaultLimits` reads `policy`, `placeholderFormatter` and `onFinding`
  by name rather than by spreading `options`, so an options object layered over
  a shared base (`Object.create(defaults)`) keeps them.
  `createAiContextBoundaryWith` destructures its options, which follows the
  prototype chain, so before this an inherited `policy` would have been
  silently dropped and the boundary would have run on the core's default
  policy — a quiet weakening, with no error. An inherited limit set is used
  rather than overwritten by the preset, and a key this helper does not know
  about is forwarded rather than dropped.

### Changed

- The README leads with the short call and moves the limits below it, with a
  table of what each bound covers, and states next to the example that
  non-JSON values, binary content and encoded text are blocked rather than
  decoded, and that a cancelled operation is `aborted`.

Not changed, deliberately: limits are still mandatory and still finite.
`AI_CONTEXT_DEFAULT_LIMITS` is a frozen set of eight positive integers, **not
an unbounded mode** and not a way to switch a bound off. A limit set that is
passed is used exactly as passed, never merged field by field with the preset,
because a half-specified set should be rejected by the core rather than
silently completed. `createAiContextBoundaryWith`, the injected API, still
requires all three sets and throws a `TypeError` without them — pass
`withDefaultLimits()` to hand it the preset. Every existing caller that passes
all three behaves exactly as it did. `test/defaults.test.ts` asserts against
the real core that each preset bound is enforced and fails closed as
`limit_exceeded`, that a streamed text agrees with `sanitizeText` at every
chunk partition under it, and that an override replaces rather than widens.

## [0.1.0-alpha.1] - 2026-09-25

### Added

- The `resource` boundary label (redact-secret/redact-secret#843), for the
  contents of an MCP `resources/read` result. Telemetry-only, like every
  label; a type-level addition to `BoundaryLabel`.

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
- **Dependency range: `@redact-secret/adapter` `^0.1.1` → `^0.1.2`**
  (redact-secret-adapters#36). The key-aware `sanitizeValue` needs the
  `walkStrict` that hands each leaf its key, first shipped in
  `@redact-secret/adapter` `0.1.2`. Against the published `0.1.1`, which
  `^0.1.1` still allowed, the walker passes no key, so a key-identified leaf
  such as `{"password": "<value>"}` was blocked as `policy` instead of redacted
  in place. It failed closed, but it broke the contract above, and no in-repo
  test could see it because every one uses the workspace walker.
  `scripts/check-published-combination.mjs` now installs this package with the
  lowest registry version its range allows and runs the key-aware probe.

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
