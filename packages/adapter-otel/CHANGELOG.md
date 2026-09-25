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
