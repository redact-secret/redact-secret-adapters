# Changelog

All notable changes to `@redact-secret/adapter` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every package in this repository carries its own SemVer and is released
independently — see [ARCHITECTURE.md § Versioning](../../ARCHITECTURE.md#versioning).
A change to the range this package declares against `@redact-secret/core` is
always its own entry, naming the test that backs the new range, never folded
into a generic "bump dependency" line.

To release: in a PR into `develop`, move this section's `Unreleased`
entries under a new `## [x.y.z] - YYYY-MM-DD` heading matching the version
bumped in `package.json`. The next release train publishes and tags every
package whose declared version isn't on its registry yet — see
[RELEASING.md](../../RELEASING.md). This file ships inside the published
tarball (`files` in `package.json`), so a consumer can read it from
`node_modules` without leaving their editor.

## [Unreleased]

### Added

- **Key-context scan primitive** (redact-secret/redact-secret-adapters#172): `scanLeafInKeyContext`, `keyContextView`, `keyContextPrefix`, `KEY_CONTEXT_SUFFIX` and the `KeyContext*` types, extracted from the AI-context boundary with its behavior and leaf-offset contract unchanged. It scans a leaf alone and, when that redacts or blocks nothing and the leaf sits directly under an object key, once more in its view `{"<key>":"<leaf>"}` (key and leaf verbatim), mapping findings back to leaf offsets. The core alone decides detection and policy; no key name list lives here.
- `MaskLeafOptions.key`, and `maskKeyedLeavesWith(scanAndRedact, texts, keys, options)` for a flat list of leaves lifted out of a document.

- **Aggregate operation budget** (redact-secret/redact-secret-adapters#173): `createOperationBudget`, `DEFAULT_OPERATION_LIMITS`, `resolveOperationLimits`, `utf8ByteLength` and the `OperationBudget` / `OperationLimits` / `OperationUsage` types, and `operationLimits` / `operation` on `MaskOptions` and `budget` on `MaskLeafOptions`. One host operation (a log record, a span, a context) shares one budget across every pass and field. It counts UTF-8 bytes and `scanAndRedact` invocations as actual calls, and nodes, object keys, string leaves and findings as occurrences (a memoized repeat costs no scan but still a visit); key-context scans and keys are counted explicitly. Defaults: 16 MiB, 50,000 scans, 100,000 nodes, 100,000 keys, 25,000 leaves, 100,000 findings. No existing counter changes meaning and the per-walk `DEFAULT_LIMITS` still apply first.
- `walkStrict` takes an optional fourth argument, the operation budget, charging every node and key as `limit_exceeded`.

- **Verified core scan options** (redact-secret/redact-secret-adapters#175): `scanLimits` (the core's whole-input `limits`, `{ maxInputBytes, maxFindings }`), `ruleset` (text or bytes) and `placeholderFormatter`, beside `policy`, on `MaskOptions` and `MaskLeafOptions`, so `maskSecretsWith`, `maskLogValueWith`, `maskLeafOutcomeWith` and `createMaskSecrets` pass them to every scan. `resolveScanConfig` / `withResolvedScanConfig` validate and snapshot them once (`scanLimits` is copied, a binary `ruleset` is copied byte for byte; callbacks are held by reference; a malformed option is a fixed-message `TypeError`). The caller's `policy` replaces the core's built-in policy for every finding, a ruleset detector's included, and is never combined with another.
- `verifyScanOptions`, `CoreOptionsError` (`CORE_OPTION_UNSUPPORTED` / `CORE_OPTION_REJECTED`, option names, an allowlisted `coreCode`, never a value or the core's message), `coreVersionAtLeast` and `SCAN_OPTION_CORE_FLOORS`: the live factories check the installed core's `VERSION` against the version each option was verified against and probe the options with one scan of the empty text, so an unsupported core or a ruleset the core refuses is rejected at construction, not ignored.
- No range change: all three options are verified from the declared floor `0.1.0-beta.6` through `0.1.0-beta.12` by `test/scan-options-live.test.ts`, which CI runs at both endpoints. A core that omits every new option reads nothing extra and is untouched.

### Changed

- **`walkValue` (`maskSecretsWith`, `maskLogValueWith`) and `maskLeafOutcomeWith` now give a string leaf its direct object key as detection context.** A credential whose detection depends on its field name (`{ api_key: "..." }`) is now masked, the same way the AI-context boundary has treated it. Object shape is unchanged and keys are still never scanned, rewritten or returned. Array elements, messages, `Error` `message`/`stack`/`cause`, and the root have no key and are scanned as before. Consequences worth knowing: a string leaf under a key costs one additional `scanAndRedact` call (two instead of one) unless its own scan already redacts or blocks it; the `scanned` outcome counter is unchanged (it counts leaves, not calls); a key-context finding that would have to rewrite the key, or that falls outside the leaf, replaces the leaf with `[REDACTED:BLOCKED]` (the key is kept); and a key longer than `maxStringLength` makes the leaf `[REDACTED:LIMIT_EXCEEDED]` before any scan.

- **Behavior change with defaults:** every `maskSecretsWith` / `maskLogValueWith` call now runs under the default aggregate budget. A value that stays inside the per-walk limits but inspects more than 16 MiB, 50,000 scans, 25,000 leaves, 100,000 nodes or keys, or 100,000 findings in one call now has the remainder replaced by `[REDACTED:LIMIT_EXCEEDED]` (and the remaining keys of an object dropped), where it was scanned in full before. Exhaustion is sticky: nothing after the first overrun is scanned or passed on. It is a work counter checked between scans, not a wall-clock interrupt.

- Internal: the walker resolves its scan options once per walk instead of building `{ policy }` per leaf.

- Version bumped to `0.1.7` on `develop` ahead of the next train, so `adapter-pino`, `adapter-otel-trace` and `adapter-ai-context` can raise their dependency range to the version that carries the new APIs (`published-combination` requires it). The entries above are `0.1.7`'s and move under its heading when the train is cut.

## [0.1.6] - 2026-10-01
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.12, which carries the core's performance improvements; they reach this package through the unchanged core range. No API or range change.

## [0.1.5] - 2026-09-30

### Added

- **`maxNodes` walk budget (default 20000)** in `Limits` and `DEFAULT_LIMITS`
  (redact-secret/redact-secret-adapters#87). `walkValue`, behind
  `maskSecretsWith` and `maskLogValueWith`, budgeted only string leaves, and it
  walks a shared reference once per path. An in-process graph of 8 levels, each
  holding 1000 references to the next, therefore cost about 1000^7 container
  visits before any string budget tripped (a probe: 10^8 paths took 8 s).
  Every visited value now counts, containers included, using the same rule as
  `walkStrict`'s `maxNodes`. Past the budget, every value becomes
  `[REDACTED:LIMIT_EXCEEDED]` (counted `limited`). The default is four times
  `maxTotalLeaves`, so a string-heavy value still meets the leaf budget first.
  Invalid overrides fall back to the default through `resolveLimit`. Tested by
  "maxNodes counts every visit…" and "a shared-reference DAG is bounded by
  maxNodes…" in `test/mask-secrets.test.ts`, and the shared
  `shared_reference_dag_is_bounded_by_max_nodes` and
  `tightened_max_nodes_bounds_a_shared_reference_dag` cases in
  `fixtures/bounded-traversal-cases.json`.

## [0.1.4] - 2026-09-29

### Changed

- The `PII_ACTIVATION_CONFLICT` documentation in `activation.ts` now shows the
  `pii-context/v2` vocabulary that core `0.1.0-beta.11` reports. Documentation
  only; no behaviour change.

## [0.1.3] - 2026-09-28
### Fixed

- `createMaskSecrets` now runs the shared `activateCore` step and accepts
  `pii`, like every other live factory
  (redact-secret/redact-secret-adapters#57). It was the one entry point
  #51 left on a bare `initialize()`, so this package's own documented
  Langfuse path still failed with `PII_ACTIVATION_CONFLICT` when the
  application activated PII first. Its options type is
  `CreateMaskSecretsOptions`; a caller that passes no `pii` sees no change.

### Added

- `packages/adapter/test/activation-live.test.ts`: activation through all
  five live factories against the **real installed core**, one ordering per
  spawned `node` process. Every other activation test injects or mocks the
  core — necessarily, since a real core's selection cell is one-shot per
  process — which is why nothing caught the `createMaskSecrets` gap above.
  Recorded in `compatibility.json` under `qualifiedBy` for each package it
  drives, so both declared core endpoints exercise it. The PII cases skip on
  a core older than `0.1.0-beta.10`, which has no PII API; the
  ordering-independent cases run at both ends.
- `activateCore(core, { pii })`: the one core-activation step every live
  factory in this repository runs
  (redact-secret/redact-secret-adapters#51), plus `activePiiActivation`,
  `readPiiActivation`, `activationReflects`, `isPiiActivationConflict`,
  `PII_ACTIVATION_CONFLICT`, `CoreActivationError` and the `CoreActivation`
  / `InitializableCore` types. PII detection in the core is opt-in,
  process-wide and one-shot, so it layers three rules: without `pii`,
  `initialize()` as before but a `PII_ACTIVATION_CONFLICT` counts as
  success, because it means the application already activated its own
  selection; with `pii`, `initialize({ pii })`, so the adapter-first order
  works; and with `pii`, a check of `piiActivation()` afterwards that
  refuses when the active identity does not reflect the request, which is
  what closes the silent-PII-off window. Both refusals are a
  `CoreActivationError` with a fixed code (`PII_ACTIVATION_UNSUPPORTED`,
  `PII_ACTIVATION_NOT_ACTIVE`) and a fixed message: no selector, no input,
  no field path, no core exception text.
- `activePiiActivation()`: the identity the last successful activation
  observed, or `undefined`. Deliberately **not** a counter field — an
  `OutcomeCounter` is six non-negative integers and nothing else — and
  deliberately a pull accessor, since the core's selection is one-shot and
  the identity is one process-wide fact rather than something to repeat per
  log record or per span.

- The shared outcome contract the host adapters report through
  (redact-secret/redact-secret-adapters#45): `createOutcomeCounter`,
  `toValueCounts`, `addCounts`, `countLeaf`, `notify`, and the
  `OutcomeCounter` / `ValueCounts` / `LeafOutcome` types. A counter is six
  non-negative integers — `scanned`, `findings`, `redacted`, `blocked`,
  `limited`, `failed` — and nothing else, so it is input-free by
  construction: there is no field for a value, a masked value, a field path,
  a key, an offset, a detector id or an error message. `findings` and
  `redacted` are separate because a `warn` finding changes no text, and
  neither is a count of distinct credentials.
- `maskLeafOutcomeWith`, `maskLeafWith` plus what happened to that leaf.
  `maskLeafWith` is now a one-line wrapper over it and returns exactly the
  same string for every input.
- `MaskOptions.counter`: an optional, caller-owned accumulator the walk adds
  to while it masks. The walk only ever increments it, so a host adapter that
  masks one unit in more than one pass (pino scans a record's arguments and
  its finished line) can keep one accurate total per unit instead of double
  counting. Omitted, nothing is counted and there is no new work.
- The walk now attributes its container-level markers too: a value past
  `maxDepth` or a leaf budget counts as `limited`, and a cycle or an
  unreadable getter/`toJSON()` as `failed`.

### Changed

- No change to the declared `@redact-secret/core` range, which stays
  `^0.1.0-beta.6`. `initialize`'s optional argument and the optional
  `piiActivation` are described by this package's own
  `InitializableCore`, never read from the core's types, and
  `piiActivation` is feature-detected at runtime, so a core at the floor
  keeps working whenever `pii` is omitted.

### Documented

- Activation is not masking: under the core's default policy PII types are
  confidence-gated, so a `High`-confidence finding redacts while `Medium`
  and `Low` resolve to `warn` — and `maskLeafOutcomeWith` substitutes only
  on `block`, so a `warn` leaves the text alone. Lower-confidence PII
  therefore still reaches a destination as plaintext unless the caller
  supplies a `policy` that maps those findings to `redact`. Nothing here
  synthesizes one. The counters already make it observable, since
  `findings` and `redacted` are counted apart.

## [0.1.2] - 2026-09-25
### Added

- `walkStrict` hands each string leaf's visitor a second argument, `key`:
  the object key the leaf sits directly under, or `undefined` for an array
  element and the root (redact-secret/redact-secret#842). Visitors that take
  one argument are unaffected. `@redact-secret/adapter-ai-context` uses it for
  its key-aware `sanitizeValue`.

## [0.1.1] - 2026-09-25
### Added

- `walkStrict(value, limits, visitors)`, the all-or-nothing variant of the
  shared walker, for hosts where a partially scanned value is not a safe value
  (the AI-context boundary, `@redact-secret/adapter-ai-context`). It accepts
  only JSON-shaped values (strings, finite numbers, booleans, `null`, arrays,
  plain objects), hands every string and every object key to the caller's
  visitor, and returns the first failure instead of a value:
  `limit_exceeded` past `maxDepth` (containers, root included) or `maxNodes`
  (every visited value), `unsupported_value` for anything else, a cycle, or a
  value that cannot be read. `isStrictWalkLimits` and the `StrictWalk*` types
  are exported with it. The marker-based walker is unchanged.

### Changed

- `@redact-secret/core` is now a required peer dependency (was optional). The
  published `.d.ts` files import the core's types, so without it a TypeScript
  consumer failed to typecheck. npm 7+ and pnpm install a required peer
  automatically.

### Fixed

- `maskLeafWith` fails closed to `[REDACTED:ERROR]` on a scanner result that
  is not `{ text: string, findings: [] }`, instead of throwing.
- `maskSecretsWith` and `maskLogValueWith` are now one walker, and it no
  longer passes non-plain objects through unmasked. A class instance,
  `IncomingMessage`, `URL` or any `toJSON()` object is masked as what JSON
  serialization would emit (its `toJSON()` result, else its own enumerable
  properties). `maskSecretsWith` now walks an `Error` the way
  `maskLogValueWith` did, so an axios-style `error.config.headers` is masked.
  An `Error`'s `name` is masked too. A throwing getter or `toJSON()` becomes
  `[REDACTED:ERROR]` instead of throwing out of the walk.
- A limit passed as `undefined`, `NaN`, or a negative number now falls back to
  its `DEFAULT_LIMITS` value. Before, `{ maxDepth: undefined }` overrode the
  default and disabled the bound, and a `NaN` `maxStringLength` disabled the
  size check.

## [0.1.0] - 2026-09-22
Initial release.

### Added

- `createMaskSecrets`, and the lower-level `maskLeafWith` / `maskLogValueWith`
  / `maskSecretsWith`, the shared fail-closed masking primitives (L1 mask-leaf
  and L2 value-tree walker) every host adapter in this repository is built on.
- The `[REDACTED:BLOCKED]`, `[REDACTED:ERROR]`, `[REDACTED:LIMIT_EXCEEDED]`,
  and `[REDACTED:CYCLE]` markers, and `DEFAULT_LIMITS`, as public API.
- Declared range: `@redact-secret/core ^0.1.0-beta.6`, as an **optional**
  peer dependency — `scanAndRedact` is injected, so this package works
  without the core installed.

