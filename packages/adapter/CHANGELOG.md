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
