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

- `actionPolicy` option: the core's declarative action policy (object, UTF-8 JSON text or bytes), validated and snapshotted once when the boundary is created and passed to the core intact on every whole-input scan **and** every incremental session (redact-secret-adapters#217). Mutually exclusive with `policy` (a `TypeError` at construction). `ruleset` and `scanLimits` are still rejected by name. The live factory rejects a core older than 0.1.0-beta.14 (`CoreOptionsError`, `CORE_OPTION_UNSUPPORTED`) or a refused document (`coreCode: "INVALID_ACTION_POLICY"`) instead of running on the default policy; `createAiContextBoundaryWith` takes the core as given and cannot check its version. `block` stays `blocked` / `policy`, `warn` and `allow` keep the text. The package range is unchanged. Tests: `test/action-policy.test.ts`, `test/action-policy-live.test.ts`.

## [0.1.4] - 2026-10-03
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.13, whose `IncrementalLimits` type now names the input and buffer ceilings as either the byte or the deprecated code-unit field; the test fake reads both. No API or range change.

## [0.1.3] - 2026-10-02

### Added

- **`checkAiContextReady({ pii? })`: an explicit, input-free readiness check** (redact-secret/redact-secret-adapters#182). Resolves, never rejects, with `{ ready, status, core, pii, probe, activation? }` where `status` is one of the fixed `READINESS_STATUSES` (`ready`, `invalid_options`, `core_unavailable`, `initialization_failed`, `pii_activation_unsupported`, `pii_activation_not_active`, `malformed_response`, `probe_failed`, `probe_not_redacted`). It loads the core, runs the factory's activation step, and scans one fixed synthetic probe under fixed limits and the core's default policy. It accepts no probe, limit, policy or callback, calls no application callback, and carries no input, exception text or path. Readiness at that moment only. Additive: `createAiContextBoundary` and every operation are unchanged and still fail closed. No new `@redact-secret/adapter` or core requirement.
- **`operationLimits`: an aggregate budget per operation** (redact-secret/redact-secret-adapters#173). One `sanitizeText`, `sanitizeValue` or `buildContext` (every part together) shares one budget over values visited, object keys, string leaves, `scanAndRedact` calls and their UTF-8 bytes (key-context views and key scans included; a memoized repeat is not a call) and findings (summed over occurrences). A bound reached is `blocked` / `limit_exceeded` with no value and no findings, never a partly approved context. Defaults are those of `@redact-secret/adapter`, except that `maxBytes` is never below four times `wholeInputLimits.maxInputBytes`. An open stream is bounded by `incrementalLimits` and by `maxFindings` alone.
- `MAX_MEMO_ENTRIES` (1024): the per-operation memo now keeps at most that many results; past it a text is scanned again and not remembered. Output and findings accumulation are bounded by the same budget.

- **Occurrence provenance for findings** (redact-secret/redact-secret-adapters#177). `findingOccurrences(outcome)` returns, for an `ok` outcome, one `FindingOccurrence` per finding at the same index as `ok.findings`: `partIndex` (the part index for `buildContext`, else `0`), `rangeScope` (`"text"`, `"leaf"`, `"stream"`, or `"key"` for telemetry only), `rangeUnit` (`"utf16-code-units"`) and, for a leaf or key, a zero-based `leafOrdinal` / `keyOrdinal` in document order. It says what `start`/`end` index into: the whole text, one leaf (a key-context finding already mapped back to it), or the stream's logical text with absolute offsets across chunks; it does not reinterpret them as whole-document offsets. Ordinals advance per visit, so repeated and memoized strings and shared references each have their own. `onFinding` takes the occurrence as a third argument, and for every finding in `ok.findings` it is called with that finding and its occurrence in the same order; key scans add `rangeScope: "key"` events that `ok.findings` never carries. Also exported: `FINDING_OCCURRENCE_FIELDS`, `attachFindingOccurrences`, and the `FindingOccurrence` / `RangeScope` / `RangeUnit` types.
- Compatibility: additive and non-sensitive (ordinals and fixed labels only: no key, field path, value, secret-derived identifier or score). The outcome's JSON, the eight `SAFE_FINDING_FIELDS`, `start`/`end` and the telemetry `context` (`{ boundary }`) are unchanged, so the vendored core conformance replay is untouched; the occurrences are kept beside the outcome, not on it, so a serialized outcome does not carry them. `finding.id` stays unique per scan only; within one operation (`partIndex`, `rangeScope`, ordinal, `finding.id`) is unique.

### Changed

- Internal: the key-aware leaf scan is now the shared `scanLeafInKeyContext` primitive in `@redact-secret/adapter` (redact-secret/redact-secret-adapters#172), also used by the logging and tracing adapters. Behavior, the failure mapping and the leaf-offset contract are unchanged; the conformance replay and the new cross-adapter test confirm it.

- **Behavior change with defaults:** an operation that stays inside `traversalLimits` and `wholeInputLimits` but visits more than 100,000 values or keys, scans more than 25,000 leaves or 50,000 times, or accumulates more than 100,000 findings, is now `blocked` / `limit_exceeded`. It is a work counter checked between scans, not a wall-clock interrupt.

- `ruleset` and `scanLimits` are now rejected by name with a `TypeError` instead of being silently ignored (redact-secret/redact-secret-adapters#175): the core has no ruleset for an incremental session, and this boundary's whole-input limits are `wholeInputLimits`. They arrive only if passed, so no existing caller changes. `policy` and `placeholderFormatter` still reach both the whole-input and the incremental path.

- **Dependency range raised: `@redact-secret/adapter` `^0.1.3` -> `^0.1.7`** (redact-secret/redact-secret-adapters#172, #173, #175). This release needs the key-context primitive, the operation budget and the scan options that `@redact-secret/adapter` 0.1.7 introduces, which no earlier published version has; against `0.1.3` the package fails to import. Backed by the `published-combination` CI job (`scripts/check-published-combination.mjs`), which installs this package with the lowest published sibling its range admits (and this checkout's tarball for a sibling not yet published). No `@redact-secret/core` range change.

## [0.1.2] - 2026-10-01
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.12, which carries the core's performance improvements; they reach this package through the unchanged core range. No API or range change.

## [0.1.1] - 2026-09-29
### Fixed
- The package README no longer calls the package a prerelease or tells the
  reader to install `@alpha`; `0.1.0` is stable and published as `latest`.

## [0.1.0] - 2026-09-29
### Changed
- First stable release: published under the npm dist-tag `latest`. The code is
  that of `0.1.0-alpha.2` plus the scan reuse below.
- `sanitizeValue` and `buildContext` scan each distinct text once per call
  (texts up to 1,024 code units), reusing the result for repeats such as a
  content envelope's `type` / `text` keys. Output, findings, `onFinding`
  (still once per occurrence), `maxNodes` counting and outcomes are
  unchanged. The `ai-context-js` workload drops from 28 to about 20 core
  calls per event (#107).

## [0.1.0-alpha.2] - 2026-09-28
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

- `AI_CONTEXT_DEFAULT_LIMITS` and `withDefaultLimits(options?)`, and
  `createAiContextBoundary(options?)` now fills in any of the three limit sets
  a caller leaves out (redact-secret/redact-secret-adapters#46). A new
  integration no longer has to invent four security numbers before its first
  `sanitizeText`. The values are the ones this repository has been exercising
  all along — the README example, the clean-install smoke test, and the core's
  conformance replay.
- The `AiContextLimits` and `AiContextBoundaryOptionsWithDefaults` types.

### Fixed

- An application that had already run `initialize({ pii })` got a boundary
  that blocked everything: the factory's own argument-free `initialize()`
  is a different selection to the core's one-shot cell and rejected with
  `PII_ACTIVATION_CONFLICT`, which this package maps to a fail-closed
  `blocked` / `core_error` — a silently blocked boundary rather than a
  visible error. That conflict now counts as success, since it means the
  core is already loaded under the application's own selection. Every
  other initialization failure still fails closed exactly as before.

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

- The declared `@redact-secret/adapter` range rises to `^0.1.3`, the
  version that carries `activateCore`. The declared
  `@redact-secret/core` range is unchanged at `^0.1.0-beta.6`.

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

### Documented

- Activating PII is not the same as masking every PII value: under the
  core's default policy `High`-confidence PII redacts while `Medium` and
  `Low` resolve to `warn`, and a `warn` finding leaves the text alone, so
  an `ok` outcome can carry findings whose text was not changed and
  lower-confidence PII reaches the model as plaintext. Supply your own
  `policy` mapping those findings to `redact` if you need them masked.

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

