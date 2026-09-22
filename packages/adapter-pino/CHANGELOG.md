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

### Added

- `createRedactingStreamWrite` / `createRedactingStreamWriteWith`, a pino
  `hooks.streamWrite` that masks every string value in the finished JSON line.
  `hooks.logMethod` never sees child-logger bindings (`child()`,
  `setBindings()`) or `mixin()` output, so with `logMethod` alone a secret in
  either reached the destination in plaintext. Install both hooks.

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
