# Changelog

All notable changes to `@redact-secret/adapter-otel` are documented in this
file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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

## [Unreleased]

### Changed

- **Breaking for consumers on Node 20: Node 20 is no longer supported.** `engines.node` is now `22.x || 24.x` (was `20.x || 22.x || 24.x`) and CI no longer runs Node 20. The code is unchanged, but a Node 20 install now warns (an error under `engine-strict`) and is not tested; stay on the previous release if you must run Node 20.

## [0.1.7] - 2026-10-07

### Changed

- Re-exports `@redact-secret/adapter-otel-trace` `^0.1.4` (was `^0.1.2`), which carries `actionPolicy` and the scan-config conflict contract (see that package's changelog). No code change in this package.
- Verified against `@redact-secret/core` 0.1.0-beta.14. The declared core range is unchanged.

## [0.1.6] - 2026-10-03
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.13. No API or range change.

## [0.1.5] - 2026-10-02

### Added

- Re-exports `@redact-secret/adapter-otel-trace`'s per-span aggregate budget (`operationLimits`; redact-secret/redact-secret-adapters#173).

- Re-exports `@redact-secret/adapter-otel-trace`'s verified core scan options (`scanLimits`, `ruleset`, `placeholderFormatter`; redact-secret/redact-secret-adapters#175).

### Changed

- Re-exports `@redact-secret/adapter-otel-trace`, which now gives attribute values their attribute name as detection context (redact-secret/redact-secret-adapters#172).

## [0.1.4] - 2026-10-01
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.12, which carries the core's performance improvements; they reach this package through the unchanged core range. No API or range change.

## [0.1.3] - 2026-09-30
### Deprecated

- This package is now a compatibility re-export of
  [`@redact-secret/adapter-otel-trace`](../adapter-otel-trace), the same
  processor under a name that says what it covers: OpenTelemetry **traces**
  (a `SpanProcessor`), not OpenTelemetry Logs
  (redact-secret/redact-secret-adapters#49). Every export keeps its name,
  signature and behavior — `createRedactingSpanProcessor`,
  `RedactingSpanProcessorWith` (the same class object, so `instanceof` still
  holds), `redactAttributesWith` and the option and outcome types — and each
  is marked `@deprecated` in the type declarations. Nothing is printed at
  import or call time. Migrate by changing the import specifier to
  `@redact-secret/adapter-otel-trace`; see the
  [migration guide](./README.md#migrating-to-redact-secretadapter-otel-trace).
  `test/compat-shim.test.ts` checks that every export is identical to the new
  package's and that a real `BasicTracerProvider` span exports the same OTLP
  JSON bytes through either name.

### Changed

- Depends on `@redact-secret/adapter-otel-trace` `^0.1.0` instead of
  `@redact-secret/adapter` directly (the trace package brings it). The
  `@opentelemetry/sdk-trace-base` `^2.0.0` and `@redact-secret/core`
  `^0.1.0-beta.6` peer ranges are unchanged, backed by the same tests, now in
  `packages/adapter-otel-trace/test`.

## [0.1.2] - 2026-09-28
### Added

- `pii` on `createRedactingSpanProcessor`, with the
  `CreateRedactingSpanProcessorOptions` type
  (redact-secret/redact-secret-adapters#51). It activates core PII
  selectors for the whole process through `@redact-secret/adapter`'s
  `activateCore`, and the factory rejects — with a fixed code
  (`PII_ACTIVATION_NOT_ACTIVE`, or `PII_ACTIVATION_UNSUPPORTED` against a
  core that reports no activation) and no selector, input or core message
  in the error — rather than return a processor that scans with PII
  silently off.

- `onOutcome`, on both `createRedactingSpanProcessor` and
  `RedactingSpanProcessorWith`: one input-free summary per **span**
  (redact-secret/redact-secret-adapters#45), carrying the six shared value
  counts and `dropped`. `dropped` is this processor's own decision — it did
  not hand the span to the next processor because a masked value would not
  write back. It does **not** mean the span was sampled out, and `false` does
  not mean the span was exported: whether the next processor kept it and
  whether an exporter succeeded are things this adapter never learns and does
  not report. The observer is called synchronously once the span has been
  forwarded or dropped; anything it throws is swallowed, never read, and
  never changes what is exported; it is re-entrancy- and thread-guarded; and
  no exporter or network client is created for it.
- `RedactingSpanProcessorOptions` and `OtelSpanOutcome` types. The
  processor's third argument was already `{ policy, maxStringLength }` and
  still accepts exactly that.

### Fixed

- An application that had already run `initialize({ pii })` could not build
  this processor: the factory's own argument-free `initialize()` is a
  different selection to the core's one-shot cell and rejected with
  `PII_ACTIVATION_CONFLICT`. That conflict now counts as success, since it
  means the core is already loaded under the application's own selection.
  Every other initialization failure still rejects exactly as before.

- A span's **attribute** values are now counted by the processor's own
  masker. They were redacted correctly, but went through the module-level
  `redactAttributesWith`, so a processor reporting outcomes would have
  counted only the span and event names. Found by the new per-span count
  tests.
- The per-span counter is now call-local, and the values are snapshotted
  before the span is handed to the next processor. A downstream processor that
  ends a span synchronously inside `next.onEnd` — a `SimpleSpanProcessor` over
  an instrumented exporter, or any processor that emits a span of its own —
  re-enters `onEnd` before the outer span has been reported, and used to
  overwrite its counts: both outcomes reported the nested span's numbers. The
  `#reporting` guard did not cover this, because the re-entry is through
  `next.onEnd` rather than through the observer. Redaction and export were
  never affected — only the reported numbers.

### Documented

- Activating PII is not the same as masking every PII value: under the
  core's default policy `High`-confidence PII redacts while `Medium` and
  `Low` resolve to `warn`, and a `warn` finding leaves the text alone, so
  lower-confidence PII still reaches the exporter as plaintext unless the
  caller supplies a `policy` that maps those findings to `redact`. The
  outcome counters make it visible: a span with a non-zero
  `values.findings` and `values.redacted` still at zero is this case.

### Changed

- `@redact-secret/adapter` range raised from `^0.1.1` to `^0.1.3`, the
  version that carries the outcome contract this release reports through.
  Backed by this package's tests against the workspace's
  `@redact-secret/adapter` 0.1.3, the npm install smoke test, and the
  published-sibling combination job.

## [0.1.1] - 2026-09-25
### Changed

- `@redact-secret/adapter` range raised from `^0.1.0` to `^0.1.1`, the
  version with the fail-closed walker fixes this release relies on (a
  malformed scanner result, non-plain objects, throwing getters). Backed
  by this package's tests, which run against the workspace's
  `@redact-secret/adapter` 0.1.1, and by the npm install smoke test.
- `createRedactingSpanProcessor` loads `@redact-secret/core` on call, like
  `@redact-secret/adapter`'s `createMaskSecrets`, so importing the injected
  API never loads the native core. No API change.
- `MaskLeafOptions` is re-exported for typing `options`.
- `@redact-secret/core ^0.1.0-beta.6` moves from `dependencies` to
  `peerDependencies`, same range. As a regular dependency, a core version in
  the application outside that range installed a second, separately
  initialized copy of the native core. Now there is exactly one. npm 7+ and
  pnpm install a required peer automatically. Backed by the same range-endpoint
  CI jobs, which already resolved the core range from either field.

### Deprecated

- `RedactAttributesOptions`, an alias of `MaskLeafOptions` that adds nothing.
  It still works and will be removed in a future major version.

### Fixed

- `onEnd` never throws into the SDK. A span whose fields do not take the
  masked write (for example, attributes frozen by an earlier processor) is
  dropped with a one-time `REDACT_SECRET_SPAN_DROPPED` process warning naming
  the field, never its value. Before, a frozen bag threw a `TypeError` out of
  `span.end()`. The status is now replaced rather than mutated.
- The SDK's optional `onEnding` hook is now forwarded to the wrapped
  processor. Before, a wrapped processor that relied on it never saw it.
- The span name, every event's name, the status message, and every link's
  attributes are now redacted; before, only span and event attributes were.
- A string-array attribute with a `null` or `undefined` element is now
  redacted element by element, keeping the holes in place. Before, any
  non-string element made the whole array pass through unmasked.

## [0.1.0] - 2026-09-22
Initial release.

### Added

- `createRedactingSpanProcessor`, wrapping any `SpanProcessor`-shaped object:
  redacts every string and string-array attribute on a span and its events in
  `onEnd`, before delegating. Attribute names are not allowlisted, so
  OpenInference and GenAI semantic-convention attributes are covered without
  hardcoding either convention.
- Declared ranges: `@redact-secret/core ^0.1.0-beta.6`, peer
  `@opentelemetry/sdk-trace-base ^2.0.0`, verified by a real span passed
  through `onEnd` at both ends of the range, asserting the mutation actually
  took effect on the real span object.

