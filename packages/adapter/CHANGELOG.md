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

### Fixed

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
