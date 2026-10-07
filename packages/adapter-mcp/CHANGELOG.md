# Changelog

All notable changes to `@redact-secret/adapter-mcp` are documented in this
file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every package in this repository carries its own SemVer and is released
independently; see [ARCHITECTURE.md § Versioning](../../ARCHITECTURE.md#versioning).
A change to a range this package declares, against `@redact-secret/core` or an
MCP SDK, is always its own entry and names the test that backs the new range.

Its first release is the prerelease `0.1.0-alpha`, published under the npm
dist-tag `alpha` (install it as `@alpha` or by exact version); `latest` is
not moved by a prerelease ([RELEASING.md § Prereleases and npm dist-tags](../../RELEASING.md#prereleases-and-npm-dist-tags)).

## [Unreleased]

## [0.1.7] - 2026-10-07

### Changed

- **Breaking for consumers on Node 20: Node 20 is no longer supported.** `engines.node` is now `22.x || 24.x` (was `20.x || 22.x || 24.x`) and CI no longer runs Node 20. The code is unchanged, but a Node 20 install now warns (an error under `engine-strict`) and is not tested; stay on the previous release if you must run Node 20. Shipped in a patch release at the maintainer's decision, although it is a breaking engines change.

## [0.1.6] - 2026-10-07

### Changed

- Requires `@redact-secret/adapter-ai-context` `^0.1.5` (was `^0.1.3`) for `actionPolicy` and the `scanConfig` rejection. Backed by `test/action-policy-live.test.ts`, `test/injected-scan-config.test.ts` and CI's `published-combination` job.
- Verified against `@redact-secret/core` 0.1.0-beta.14. The declared core range is unchanged.
- Ranges widened, each backed by `test/e2e.test.ts`, `test/transport.test.ts` and `test/resources-transport.test.ts` run at the new ceilings (the full suite, typecheck and build pass with `npm run range-endpoint -- highest`): optional peers `@modelcontextprotocol/sdk` `>=1.26.0 <=1.30.1` to `>=1.26.0 <=1.32.1` and `@modelcontextprotocol/client` / `server` `>=2.0.0 <=2.1.0` to `>=2.0.0 <=2.3.1`. The lower bounds are unchanged.
- A whole-input `scanConfig` is named and rejected (`scanConfig is not supported by the AI-context boundary`) like `ruleset` and `scanLimits`, instead of being ignored (redact-secret-adapters#213); the boundary resolves its own configuration from `policy` / `actionPolicy`.

### Added

- `createMcpBoundary` takes `actionPolicy` through `createAiContextBoundary` (redact-secret-adapters#217): one snapshot, whole-input and streamed tool results, resources and arguments, the same capability check and rejection of an older core. Boundary outcomes are unchanged (`block` is the fixed blocked result). Test: `test/action-policy-live.test.ts`.

## [0.1.5] - 2026-10-03
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.13. No API or range change.

## [0.1.4] - 2026-10-02

### Added

- `operationLimits` is accepted and passed to the AI-context boundary (redact-secret/redact-secret-adapters#173): one tool result is one operation, and a result over its aggregate budget is the fixed `blocked` / `limit_exceeded` outcome.

- `ok` outcomes forward the AI-context occurrences of the findings they carry (redact-secret/redact-secret-adapters#177): `findingOccurrences` from `@redact-secret/adapter-ai-context` works on them. Feature-detected, so an older `adapter-ai-context` without occurrences is a no-op. The outcome's JSON is unchanged.

## [0.1.3] - 2026-10-01
### Changed

- Verified against `@redact-secret/core` 0.1.0-beta.12, which carries the core's performance improvements; they reach this package through the unchanged core range. No API or range change.

## [0.1.2] - 2026-09-30
### Changed
- The optional peer `@modelcontextprotocol/sdk` range is raised from
  `>=1.13.0 <=1.30.1` to `>=1.26.0 <=1.30.1`. Every 1.x release before 1.26.0
  carries at least one of three high-severity SDK advisories:
  GHSA-w48q-cv73-mx4w (DNS rebinding protection off by default, fixed in
  1.24.0), GHSA-8r9q-7v3j-jr4g (ReDoS in `UriTemplate`, fixed in 1.25.2) and
  GHSA-345p-7cg4-v4c7 (cross-client data leak on server or transport reuse,
  fixed in 1.26.0). None is reachable from this adapter's own code. With the
  SDK installed, npm now refuses an older one with ERESOLVE. The new range is
  backed by `test/transport.test.ts`, `test/resources-transport.test.ts` and
  `test/e2e.test.ts`, run at both endpoints (1.26.0 and 1.30.1) by CI
  `range-endpoints`. 1.26.0 negotiates protocol 2025-11-25, so 2025-06-18 is
  no longer negotiated at a tested endpoint (#83).

### Fixed
- With `binaryContent: "pass"`, a binary field (an image or audio block's
  `data`, a resource's `blob`) is read once. Before, the boundary checked that
  the value was a string and then read it again while rebuilding the result.
  A getter could return a non-string, unscanned value on the second read, and
  it went out as `ok`. A getter that threw on the second read escaped
  `sanitizeToolResult`, `sanitizeResourceResult` and the wrapped handlers as an
  exception. The boundary now passes on the string it checked. Backed by
  `test/boundary-edges.test.ts` (#91).
- A streamed-result step whose `done` or `value` getter throws is now
  `tool_error`, and the boundary aborts the session and closes the producer.
  Before, the getter's error escaped
  `sanitizeStreamedToolResult` and `wrapStreamedToolHandler` as a rejection
  carrying the producer's own error, and the session stayed open. Backed by
  `test/boundary-edges.test.ts` (#92).

## [0.1.1] - 2026-09-29
### Fixed
- The package README no longer calls the package a prerelease or tells the
  reader to install `@alpha`; `0.1.0` is stable and published as `latest`.

## [0.1.0] - 2026-09-29
### Changed
- First stable release: published under the npm dist-tag `latest`. The code is
  that of `0.1.0-alpha.2` plus the scan reuse below.
- A tool result's repeated envelope strings reach the core once per crossing:
  the value scan reuses identical texts, and the key-context check skips a
  serialized part that already scanned with no findings. Outputs, findings and
  `onFinding` (once per occurrence) are unchanged (#107).

## [0.1.0-alpha.2] - 2026-09-28
### Added

- `pii` on `createMcpBoundary`, forwarded to `createAiContextBoundary` the
  way the limits already are
  (redact-secret/redact-secret-adapters#51). It activates core PII
  selectors for the whole process. The factory's contract of never
  rejecting is unchanged: a selection that cannot be shown to be active
  fails every operation closed as `blocked` / `core_error`, which maps to
  the fixed blocked result, rather than quietly sanitizing with PII off.

- `createMcpBoundary(options?)` now fills in any of the three limit sets a
  caller leaves out, from `@redact-secret/adapter-ai-context`'s
  `AI_CONTEXT_DEFAULT_LIMITS` (redact-secret/redact-secret-adapters#46), so a
  host can start with `await createMcpBoundary()` and a checked outcome.
  `binaryContent` and `onAudit` compose with the defaults unchanged.
- The `CreateMcpBoundaryOptionsWithDefaults` type.

### Fixed

- An application that had already run `initialize({ pii })` got a boundary
  that blocked everything, because the AI-context factory's argument-free
  `initialize()` rejected with `PII_ACTIVATION_CONFLICT` against the
  core's one-shot selection cell and that mapped to a fail-closed
  `blocked` / `core_error`. That conflict now counts as success. Every
  other initialization failure still fails closed exactly as before.

### Documented

- Activating PII is not the same as masking every PII value: under the
  core's default policy `High`-confidence PII redacts while `Medium` and
  `Low` resolve to `warn`, and a `warn` finding leaves the text alone, so
  an `ok` outcome can carry findings whose text was not changed. Supply
  your own `policy` mapping those findings to `redact` if you need them
  masked.

### Changed

- The README leads with the short call, moves the limits below it, and states
  next to the example what refuses and why: a binary payload blocks by default
  because it cannot be scanned (`binaryContent: "pass"` passes a string
  payload unscanned at its original position), a content type no qualified
  protocol revision defines blocks, and a cancelled call is `aborted` with
  `toCallToolResult` returning `null`.
- `@redact-secret/adapter-ai-context` range raised from `^0.1.0-alpha.1` to
  `^0.1.0-alpha.2`, the version that carries the default limits this release
  relies on. Backed by this package's tests and the published-sibling
  combination job.

Not changed: there is no unbounded mode, the bounds still fail an oversized
result closed as `blocked` / `limit_exceeded`, and `createMcpBoundaryWith` over
a boundary the host built itself is untouched. `test/defaults.test.ts` asserts
the defaults, an override, the binary block, an unsupported content type, and
an aborted call on the real core.

## [0.1.0-alpha.1] - 2026-09-25
### Added

- **`resources/read`** (redact-secret/redact-secret#843,
  redact-secret-adapters#33): `sanitizeResourceResult`,
  `sanitizeResourceRead` (host placement, around a client `readResource`),
  and `wrapResourceReadHandler` (a server read callback of either SDK line,
  `McpServer.registerResource` fixed URIs and URI templates, or a low-level
  `resources/read` handler). A `ReadResourceResult` is one AI-context
  `sanitizeValue` under the new `resource` label, then the same key-context
  backstop; entry `text` is scanned as text whatever its `mimeType`; an entry
  must be exactly one of `text` or `blob`, and a `blob` follows
  `binaryContent`. Failures map to fixed JSON-RPC errors (code `-32603`, a
  fixed message, no `data`) through `toReadResourceResponse`, and the wrapper
  throws them as `McpResourceError`; a read failure is the new `read_error`
  outcome, its error never read. The audit `stage` gains `resource`.
  Qualified by the core `mcp-resources-read` fixture and runner vendored at
  the #843 commit (`test/conformance*.test.ts`), replayed over real SDK
  clients and servers at both endpoints of both lines on stdio and
  Streamable HTTP (`test/resources-transport.test.ts`), and exercised at the
  host placement in `test/e2e.test.ts`. No declared range changes.

### Changed

- **Dependency range: `@redact-secret/adapter-ai-context` `^0.1.0-alpha` →
  `^0.1.0-alpha.1`** (redact-secret-adapters#36). The narrowed key-context
  backstop below relies on the key-aware `sanitizeValue`, which the published
  `0.1.0-alpha` does not have. Paired with it, a `_meta.password` leaf in a
  `resources/read` result was blocked as `policy` instead of redacted.
  `scripts/check-published-combination.mjs` guards the pairing.

- **Contract change: the key-context check is narrowed to a backstop**
  (redact-secret/redact-secret#842, redact-secret-adapters#32). The
  AI-context `sanitizeValue` is now key-aware and redacts a leaf its own key
  identifies in place, so the serialized rescan no longer blocks such a
  result; it still blocks, as `policy`, on context only the serialization
  shows (a sibling or parent key). **Migration:** a result or argument set
  that was `blocked` / `policy` only through the key-context check is now
  `ok`, with that leaf replaced by a placeholder and its finding reported
  through `onFinding`; hosts that relied on the block should watch
  `onFinding`. Nothing previously redacted or blocked passes. Qualified by the
  core fixture vendored at the #842 commit
  (`packages/adapter-mcp/test/conformance.test.ts`,
  `packages/adapter-mcp/test/transport.test.ts`) at both SDK line endpoints.

## [0.1.0-alpha] - 2026-09-25
First release, as a prerelease.

### Added

- The supported MCP redaction boundary (redact-secret/redact-secret#612,
  redact-secret-adapters#13), as a thin specialization of
  `@redact-secret/adapter-ai-context`: `createMcpBoundary(options)` (live)
  and `createMcpBoundaryWith(aiContextBoundary, options)` (injected), each
  returning `sanitizeToolResult`, `sanitizeToolArguments` (opt-in, label
  `tool-arguments`), `sanitizeToolCall`, `sanitizeStreamedToolResult`,
  `wrapToolHandler`, and `wrapStreamedToolHandler`. The whole
  `CallToolResult` is one AI-context `sanitizeValue`, followed by the
  key-context check. Binary payloads block by default (`binaryContent:
  "pass"` to opt out), and unknown block types block. A streamed result
  stops pulling from its producer, and closes it, once the stream stops
  accepting. Tool and handler errors become `tool_error` and are never
  read. Every non-`ok` outcome maps to a fixed `isError: true`
  `CallToolResult` (`toCallToolResult`), never to a JSON-RPC error.
  Cancellation delivers nothing. `onAudit` receives one
  `{ stage, outcome, reason?, code? }` record per crossing.
- Qualified by replaying the core's `conformance/fixtures/mcp-boundary.json`
  with the core's own runner (`conformance/mcp-boundary.mjs`), both vendored
  at core commit `0e3ba9592b6fa80fafdea47639921987c36ba323`
  (`fixtures/core/pins.json`), through the public API on the real core,
  before and after `initialize()` (`test/conformance*.test.ts`). The same
  fixture is replayed with real SDK clients and servers over stdio and
  Streamable HTTP (`test/transport.test.ts`), and end to end through a host's
  log, store and model context, including a real subprocess producer
  (`test/e2e.test.ts`).
- Declared ranges: `@redact-secret/core ^0.1.0-beta.6` (required peer), and as
  optional peers `@modelcontextprotocol/sdk >=1.13.0 <=1.30.1` and
  `@modelcontextprotocol/client` / `@modelcontextprotocol/server
  >=2.0.0 <=2.1.0`. These are backed by `test/transport.test.ts` and
  `test/e2e.test.ts` at both endpoints of every range in CI
  (`range-endpoints`). 1.13.0 negotiates protocol 2025-06-18; 1.30.1, 2.0.0
  and 2.1.0 negotiate 2025-11-25.
- Depends on `@redact-secret/adapter-ai-context ^0.1.0-alpha` (which pulls in
  `@redact-secret/adapter ^0.1.1`).

