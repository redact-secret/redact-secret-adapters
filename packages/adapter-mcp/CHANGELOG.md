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
