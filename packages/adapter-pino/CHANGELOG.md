# Changelog

All notable changes to `@redact-secret/adapter-pino` are documented in this
file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every package in this repository carries its own SemVer and is released
independently — see [ARCHITECTURE.md § Versioning](../../ARCHITECTURE.md#versioning).
A change to the range this package declares against `pino` or against
`@redact-secret/core` is always its own entry, naming the test that backs the
new range, never folded into a generic "bump dependency" line.

To release: in a PR into `develop`, move this section's `Unreleased`
entries under a new `## [x.y.z] - YYYY-MM-DD` heading matching the version
bumped in `package.json`. The next release train publishes and tags every
package whose declared version isn't on its registry yet — see
[RELEASING.md](../../RELEASING.md). This file ships inside the published
tarball (`files` in `package.json`), so a consumer can read it from
`node_modules` without leaving their editor.

## [Unreleased]

### Changed

- **Key-aware detection** (redact-secret/redact-secret-adapters#172). `hooks.logMethod` and `hooks.streamWrite` now give a string value its direct object key as detection context, through the shared primitive in `@redact-secret/adapter`: a context-dependent credential (`{ "api_key": "..." }`) is masked in call arguments, child-logger bindings, `mixin()` output and serializer output. In the final line, the key is the string literal directly before the value's colon; array elements and values after a non-string have none. Keys are still never scanned, rewritten or output, so the line keeps its shape and both hooks stay (neither is replaced). Cost: a keyed string value is scanned twice unless its own scan already redacted or blocked it. A key literal that is not valid JSON now fails the line closed (`{"msg":"[REDACTED:ERROR]"}`), as an invalid value literal already did.

### Added

- **One aggregate budget per log record** (redact-secret/redact-secret-adapters#173), shared by `logMethod` and `streamWrite` (and so by child bindings and `mixin()` output on the final line). `operationLimits` overrides it; the defaults are those of `@redact-secret/adapter`. A record logged from inside a getter while another is masked has its own budget. `createRedactingHooks` rejects a caller-owned `operation` (it owns the unit).
- `PINO_LIMIT_LINE`, `{"msg":"[REDACTED:LIMIT_EXCEEDED]"}`: the fixed, valid line written (with the original newline) when the record's budget is already spent before `streamWrite` visits any value. `lineReplaced` is `true` for it, as for `PINO_ERROR_LINE`, and the `limited` counter, not `failed`, counts it.

### Changed

- `createRedactingHooks` now always correlates the two hooks per record (it previously did so only with an `onOutcome` observer), because the record owns the shared budget. A caller-supplied `counter` still receives each record's counts.
- **Behavior change with defaults:** a record that inspects more than the default budget (16 MiB, 50,000 scans, 25,000 leaves, ...) across both hooks now has the remainder replaced by `[REDACTED:LIMIT_EXCEEDED]`. Both hooks together scan the record twice, so a record near the old per-walk limits is likelier to meet it.

### Added

- **Pre-processing ceilings on `hooks.streamWrite`** (redact-secret/redact-secret-adapters#174), overridable with `lineLimits` (`createRedactingHooks`, `createRedactingStreamWrite`, `createRedactingStreamWriteWith`) and exported as `DEFAULT_LINE_LIMITS` / `PinoLineLimits` / `StreamWriteOptions`. Before lexing or decoding anything, the hook now refuses a line longer than `maxLineLength` (4,194,304 UTF-16 code units, checked first and unread), a line with more than `maxValueSpans` (20,000) string-literal values (checked as each span is found), and a line whose value literals plus the key literal each sits under exceed `maxDecodeLength` (2,097,152 raw code units, checked before any literal is decoded). A bound met exactly is accepted. The refusal is the fixed valid line `{"msg":"[REDACTED:LIMIT_EXCEEDED]"}` (`PINO_LIMIT_LINE`) with the original's newline: never the original line, and never because a parser failed. It reports `lineReplaced: true` and counts one `limited` value (a line that cannot be lexed is still `PINO_ERROR_LINE` and `failed`).

### Changed

- **Behavior change with defaults:** a line past a default ceiling, which was previously lexed and decoded in full and then bounded by the walk limits, is now the fixed limit line. The ceilings are separate from `limits` / `operationLimits` (traversal and aggregate scanning work) and from the core's whole-input limits (one scan); the README says how they differ.

### Added

- **Verified core scan options** (redact-secret/redact-secret-adapters#175): `createRedactingHooks`, `createRedactingLogMethod`, `createRedactingStreamWrite` and their `*With` forms take `scanLimits`, `ruleset` and `placeholderFormatter` (and still `policy`), validated and snapshotted once and applied by both hooks to every scan. The live factories reject an unsupported core, or a ruleset or limits the core refuses, with a fixed `CoreOptionsError` at construction. Whole-input only; available from the declared core floor, verified at both endpoints by `test/scan-options-live.test.ts`. Omit them and nothing changes.

## [0.1.3] - 2026-10-01
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.12, which carries the core's performance improvements; they reach this package through the unchanged core range. No API or range change.

## [0.1.2] - 2026-09-28
### Added

- `pii` on `createRedactingHooks`, `createRedactingLogMethod` and
  `createRedactingStreamWrite`, with the `CreateRedactingHooksOptions` and
  `CreateRedactingHookOptions` types
  (redact-secret/redact-secret-adapters#51). It activates core PII
  selectors for the whole process through `@redact-secret/adapter`'s
  `activateCore`, and the factory rejects — with a fixed code
  (`PII_ACTIVATION_NOT_ACTIVE`, or `PII_ACTIVATION_UNSUPPORTED` against a
  core that reports no activation) and no selector, input or core message
  in the error — rather than return hooks that scan with PII silently off.

- `createRedactingHooks` / `createRedactingHooksWith`, one setup step that
  returns both hooks (`{ logMethod, streamWrite }`) ready to pass as
  `pino({ hooks })` (redact-secret/redact-secret-adapters#44). Installing only
  one of the two was the documented misassembly this closes: `logMethod`
  alone never sees child-logger bindings or `mixin()` output, and
  `streamWrite` alone lets raw values reach the host's own serializers and
  `formatters` first.
- The pair composes with the application's own hooks:
  `createRedactingHooks({ hooks: myHooks })`. Redaction always runs last,
  closest to the bytes — a host `logMethod` runs first and the redacting hook
  runs immediately before pino's `method`, and a host `streamWrite` runs first
  on pino's line with the redacting hook masking what it returns — so values
  a host hook adds are scanned too. A host hook that drops a record still
  drops it. Keys other than `logMethod` and `streamWrite` are forwarded to
  pino unchanged; a non-function value for either is a `TypeError` at setup
  rather than a silent replacement.

- `createRedactingHooks({ onOutcome })`: one input-free summary per **log
  record** (redact-secret/redact-secret-adapters#45), carrying the numeric
  level, which of the two hooks ran, the six shared value counts, and
  `lineReplaced`. The pair's two passes over one record are summed rather
  than reported twice, so a secret in the message is not counted once as a
  call argument and again as a line value. Only the paired factory takes it,
  because only the pair can guarantee one summary per record. The observer is
  called synchronously after masking; anything it throws is swallowed, never
  read, and never changes what is written; it is re-entrancy-guarded, so an
  observer that logs through the logger it observes does not recurse; and no
  logger, exporter or network client is created for it. `lineReplaced` says
  the `streamWrite` hook could not lex the line and wrote the fixed
  `[REDACTED:ERROR]` line — it is not a claim that the destination accepted
  anything.
- `PINO_ERROR_LINE`, the exact line written in that case, so a host can
  recognise it without pattern-matching.

### Fixed

- An application that had already run `initialize({ pii })` could not build
  these hooks: the factory's own argument-free `initialize()` is a
  different selection to the core's one-shot cell and rejected with
  `PII_ACTIVATION_CONFLICT`. That conflict now counts as success, since it
  means the core is already loaded under the application's own selection.
  Every other initialization failure still rejects exactly as before.

- The counter the walkers are given is resolved per masking call, so a log
  emitted from a **getter or `toJSON()` on the merging object** — which runs
  *during* the walk, unlike a `mixin()` or serializer that logs after it — no
  longer takes the outer record's partial counts with it. Both records now
  report only the values they carried. Masking was never affected; only the
  attribution was.
- A value the walk dropped past `maxArrayLength` and `streamWrite` replaced
  with `[REDACTED:LIMIT_EXCEEDED]` is now counted as `limited`. The walk could
  not count it — it never saw it — so `limited` under-reported exactly the
  values that were refused.
- A caller's own `MaskOptions.counter` is no longer discarded when `onOutcome`
  is set: each record's counts are added into it once the record is reported.

### Documented

- Activating PII is not the same as masking every PII value: under the
  core's default policy `High`-confidence PII redacts while `Medium` and
  `Low` resolve to `warn`, and a `warn` finding leaves the text alone, so
  lower-confidence PII still reaches the transport as plaintext unless the
  caller supplies a `policy` that maps those findings to `redact`. The
  outcome counters make it visible: a record with a non-zero
  `values.findings` and `values.redacted` still at zero is this case.

- A host `streamWrite` hook receives pino's line **unmasked** (bindings and
  `mixin()` output included), because the ordering rule runs it first. What
  reaches the destination is masked either way, but a host hook that tees or
  copies the line elsewhere is handling plaintext.

### Changed

- `@redact-secret/adapter` range raised from `^0.1.1` to `^0.1.3`, the
  version that carries the outcome contract this release reports through.
  Backed by this package's tests against the workspace's
  `@redact-secret/adapter` 0.1.3, the npm install smoke test, and the
  published-sibling combination job.
- The package README's example is now a complete, executable boundary
  (both hooks, a child binding, `mixin()`, a serializer, pino's own path
  `redact`) and is run verbatim against the real core from a clean install
  outside the workspace by `npm run smoke-test`
  (redact-secret/redact-secret-adapters#42). `createRedactingLogMethod` and
  `createRedactingStreamWrite` are documented as not being the complete
  boundary on their own; both stay exported, unchanged, for advanced
  composition and migration.

## [0.1.1] - 2026-09-25
### Added

- `createRedactingStreamWrite` / `createRedactingStreamWriteWith`, a pino
  `hooks.streamWrite` that masks every string value in the finished JSON line.
  `hooks.logMethod` never sees child-logger bindings (`child()`,
  `setBindings()`) or `mixin()` output, so with `logMethod` alone a secret in
  either reached the destination in plaintext. Install both hooks.

### Changed

- `@redact-secret/adapter` range raised from `^0.1.0` to `^0.1.1`, the
  version with the fail-closed walker fixes this release relies on (a
  malformed scanner result, non-plain objects, throwing getters). Backed
  by this package's tests, which run against the workspace's
  `@redact-secret/adapter` 0.1.1, and by the npm install smoke test.
- `createRedactingLogMethod` and `createRedactingStreamWrite` load
  `@redact-secret/core` on call, like `@redact-secret/adapter`'s
  `createMaskSecrets`, so importing the injected API never loads the native
  core. No API change.
- `formatPinoMessage` is marked `@internal`: still exported for
  compatibility, but not a supported API.
- `@redact-secret/core ^0.1.0-beta.6` moves from `dependencies` to
  `peerDependencies`, same range. As a regular dependency, a core version in
  the application outside that range installed a second, separately
  initialized copy of the native core. Now there is exactly one. npm 7+ and
  pnpm install a required peer automatically. Backed by the same range-endpoint
  CI jobs, which already resolved the core range from either field.

### Fixed

- `logger.error(err, "custom")` now logs `"custom"` as `msg`. Before, a leading
  `Error` was rewritten to `[{ err }, err.message, ...rest]`, which replaced
  the caller's message with `err.message` and interpolated the caller's
  arguments into it. The hook now hands pino a masked copy of the error that
  keeps its prototype, so pino's own handling applies: the caller's message
  wins, and `logger.error(err)` still gets the masked `err.message`.
- A masked `Error` keeps its class: pino's `err` serializer now logs
  `type: "TypeError"` (or whatever the class is) instead of `"Object"`, for a
  leading `Error` and for one under a merging-object key, whatever the
  logger's `errorKey` is. Nothing in the hook assumes the key is `err` any
  more.
- `logger.info(undefined, fmt, ...values)` (or `null` first) now joins the
  message with its values before scanning, as pino formats it; before, the
  parts were scanned separately and a secret split across them was missed.
- A logger's `msgPrefix` is now scanned together with the message, so a
  prefix such as `"api_key="` gives the core the context to detect the value
  that follows it.
- The `logMethod` hook no longer throws into pino when an argument cannot be
  formatted (for example `%d` with a `Symbol`): pino logs `[REDACTED:ERROR]`
  instead of the raw arguments.

## [0.1.0] - 2026-09-22
Initial release.

### Added

- `createRedactingLogMethod`, a `hooks.logMethod` integration: value-based
  redaction over the exact string pino would format from a message and its
  interpolation arguments, alongside — not instead of — pino's own
  path-based `redact` option.
- Declared ranges: `@redact-secret/core ^0.1.0-beta.6`, peer `pino ^10.0.0`.
  `pino ^10.0.0` is verified by a real `pino` logger writing to a captured
  stream at both ends of the range; `pino 9.x` is deliberately not declared —
  it may work, but it is untested, so it is not claimed.

