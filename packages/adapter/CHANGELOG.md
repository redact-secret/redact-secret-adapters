# Changelog

All notable changes to `@redact-secret/adapter` are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every package in this repository carries its own SemVer and is released
independently — see [ARCHITECTURE.md § Versioning](../../ARCHITECTURE.md#versioning).
A change to the range this package declares against `@redact-secret/core` is
always its own entry, naming the test that backs the new range, never folded
into a generic "bump dependency" line.

To cut a release: move this section's `Unreleased` entries under a new
`## [x.y.z] - YYYY-MM-DD` heading matching the version bumped in
`package.json`, then run the [Release workflow](../../.github/workflows/release.yml),
which publishes and tags each package independently once its declared
version isn't already on the registry. This file ships inside the published
tarball (`files` in `package.json`), so a consumer can read it from
`node_modules` without leaving their editor.

## [Unreleased]

## [0.1.0]

Initial release. Not yet published — this heading gains a release date once
the Release workflow first publishes this package.

### Added

- `createMaskSecrets`, and the lower-level `maskLeafWith` / `maskLogValueWith`
  / `maskSecretsWith`, the shared fail-closed masking primitives (L1 mask-leaf
  and L2 value-tree walker) every host adapter in this repository is built on.
- The `[REDACTED:BLOCKED]`, `[REDACTED:ERROR]`, `[REDACTED:LIMIT_EXCEEDED]`,
  and `[REDACTED:CYCLE]` markers, and `DEFAULT_LIMITS`, as public API.
- Declared range: `@redact-secret/core ^0.1.0-beta.6`, as an **optional**
  peer dependency — `scanAndRedact` is injected, so this package works
  without the core installed.
