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

### Fixed

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
