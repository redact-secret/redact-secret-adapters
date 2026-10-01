# @redact-secret/adapter-mcp

[![npm version](https://img.shields.io/npm/v/@redact-secret/adapter-mcp)](https://www.npmjs.com/package/@redact-secret/adapter-mcp)
[![npm downloads](https://img.shields.io/npm/dm/@redact-secret/adapter-mcp)](https://www.npmjs.com/package/@redact-secret/adapter-mcp)
[![MCP SDK peer range](https://img.shields.io/npm/dependency-version/@redact-secret/adapter-mcp/peer/@modelcontextprotocol/sdk)](https://www.npmjs.com/package/@redact-secret/adapter-mcp?activeTab=dependencies)
[![Node.js](https://img.shields.io/node/v/@redact-secret/adapter-mcp)](https://www.npmjs.com/package/@redact-secret/adapter-mcp)
[![types included](https://img.shields.io/npm/types/@redact-secret/adapter-mcp)](https://www.npmjs.com/package/@redact-secret/adapter-mcp)
[![CI](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/redact-secret/redact-secret-adapters/badge)](https://scorecard.dev/viewer/?uri=github.com/redact-secret/redact-secret-adapters)
[![License: MIT](https://img.shields.io/npm/l/@redact-secret/adapter-mcp)](https://github.com/redact-secret/redact-secret-adapters/blob/main/LICENSE)

Remove secrets from Model Context Protocol (MCP) tool results and resource
reads **before** they are logged, stored, or placed into model context.

Wrap the tool call. You get back a sanitized result, a fixed error result, or
nothing. Built on the
[Redact Secret](https://github.com/redact-secret/redact-secret) core, which
does the detection.

## Install

```bash
npm install @redact-secret/adapter-mcp @redact-secret/core
```

Needs Node.js 20, 22 or 24. ESM only. The core is a required peer. The MCP SDK
you already use is an optional peer: this package imports no MCP SDK, at
runtime or for types.

## Quick start

In your MCP host, wrap the call:

```js
const mcp = await createMcpBoundary();
const outcome = await mcp.sanitizeToolCall(({ signal }) => client.callTool(params, undefined, { signal }));
const safe = toCallToolResult(outcome); // use only this
```

A complete, runnable example:

<!-- smoke-test:example -->
```js
import { createMcpBoundary, toCallToolResult } from "@redact-secret/adapter-mcp";

// Conservative documented default limits. Override any of them below.
const mcp = await createMcpBoundary({
  onFinding: (finding, { boundary }) => console.error("finding", boundary, finding.type, finding.action),
  onAudit: (record) => console.error("audit", JSON.stringify(record)),
});

// In a host this is `({ signal }) => client.callTool(params, undefined, { signal })`
// (SDK 1.x) or `client.callTool(params, { signal })` (SDK 2.x). Synthetic values only.
const callTool = async () => ({
  content: [{ type: "text", text: "deploy ok\nAPI_KEY=ghp_SYNTHETICREVOKED00000000000000000000" }],
  structuredContent: { env: ["API_KEY=ghp_SYNTHETICREVOKED00000000000000000000"] },
});

const outcome = await mcp.sanitizeToolCall(callTool);
const safe = toCallToolResult(outcome); // null when the call was cancelled
if (safe !== null) console.log(JSON.stringify(safe)); // log it, store it, put it into context
// {"content":[{"type":"text","text":"deploy ok\nAPI_KEY=<SECRET_1>"}],"structuredContent":{"env":["API_KEY=<SECRET_1>"]}}
```

CI runs this block verbatim from a clean install outside the repository
(`npm run smoke-test`).

## What `toCallToolResult` gives you

| Outcome | You get |
| --- | --- |
| `ok` | the sanitized result, and nothing else |
| `blocked` | a fixed `isError` result saying the call was blocked |
| `tool_error` (the tool or `callTool` threw; the error is never read) | a fixed `isError` result saying the call failed |
| `aborted` (cancelled) | `null`. There is nothing safe to deliver |

## Things that surprise people

- **Binary content blocks the whole result by default.** An `image`, `audio`
  or base64 `blob` cannot be scanned. Pass `binaryContent: "pass"` to let a
  string payload through **unscanned** at its original position, with every
  other field of the block still scanned.
- **An unknown content type blocks.** A content type or shape no qualified
  protocol revision defines fails closed rather than passing unscanned.
- **Limits are always on.** An oversized result is `blocked` /
  `limit_exceeded`, never truncated. See [Limits](#limits).
- **A structured result can be blocked rather than redacted** when only a
  sibling or parent key identifies the secret. See
  [What is scanned](#what-is-scanned).
- **`ok` with no findings is not proof** the result held no secret.
- **Do not log a raw `McpError` from `callTool`.** Its message can quote parts
  of the result.

## Where to put it

**The authoritative boundary is the MCP host**: the process that receives a
`CallToolResult` from an MCP client and builds model context from it. Apply
it after the SDK has parsed the result and before any of these:

1. writing the result, or anything derived from it, to a log or a trace;
2. persisting it (conversation history, caches, databases);
3. placing it into model context.

Deliver only `toCallToolResult(outcome)`. The raw result should exist only
inside `sanitizeToolCall`.

A server can also wrap its own tool handlers. That is **preventive**: the host
cannot verify it, so the host applies the boundary again to every result it
receives, including results marked `isError: true`.

```js
// Server side, either SDK line. Both handler shapes work: (args, ctx) and (ctx).
server.registerTool("deploy", { inputSchema }, mcp.wrapToolHandler(deployHandler, { sanitizeArguments: true }));
```

## Operations

| Operation | Use it for |
| --- | --- |
| `sanitizeToolCall(invoke, { signal, arguments? })` | **Host.** Run a tool call and sanitize its result. Pass `arguments` to sanitize those first |
| `sanitizeToolResult(result, { signal })` | **Host.** Sanitize a `CallToolResult` you already have |
| `sanitizeToolArguments(args, { signal })` | **Host.** Sanitize `params.arguments` on their own |
| `sanitizeStreamedToolResult(chunks, { signal })` | **Host.** An iterable or async iterable of string chunks of one text |
| `sanitizeResourceRead(invoke, { signal })` | **Host.** Run a `resources/read` and sanitize what comes back |
| `sanitizeResourceResult(result, { signal })` | **Host.** Sanitize a `ReadResourceResult` you already have |
| `wrapToolHandler(handler, { sanitizeArguments })` | **Server.** Wrap a tool handler, either SDK line |
| `wrapStreamedToolHandler(handler, { sanitizeArguments })` | **Server.** Wrap a handler that returns chunks |
| `wrapResourceReadHandler(handler)` | **Server.** Wrap a read callback: `(uri, extra)`, `(uri, variables, extra)`, or a low-level `(request, extra)` |

When you pass `arguments` to `sanitizeToolCall`, they are sanitized first. On
any non-`ok` outcome `invoke` is never called, and `invoke` receives only the
sanitized copy. The tool name and the request's `_meta` are not scanned: the
name is matched against your tool list, and `_meta` is protocol metadata your
host generated.

The server wrappers read the cancellation signal from `extra.signal` (SDK 1.x)
or `ctx.mcpReq.signal` (SDK 2.x).

Helpers: `toCallToolResult(outcome)`, `mcpBlockedResult()`,
`mcpToolErrorResult()`, `toReadResourceResponse(outcome)`,
`mcpResourceBlockedError()`, `mcpResourceReadError()`, the `McpResourceError`
class, `mcpAuditRecord(outcome, stage)`, and the constants `MCP_BLOCKED_TEXT`,
`MCP_TOOL_ERROR_TEXT`, `MCP_RESOURCE_ERROR_CODE`,
`MCP_RESOURCE_BLOCKED_MESSAGE`, `MCP_RESOURCE_READ_ERROR_MESSAGE`,
`MCP_CONTENT_TYPES`, `MCP_BOUNDARY_LABELS`, `MCP_OUTCOMES`,
`MCP_RESOURCE_OUTCOMES`, `MCP_AUDIT_FIELDS`.

## Options

```js
await createMcpBoundary({
  binaryContent, onAudit, onFinding, pii, policy, placeholderFormatter,
  wholeInputLimits, incrementalLimits, traversalLimits,
});
```

`createMcpBoundary(options)` loads and initializes the core through
[`createAiContextBoundary`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter-ai-context#readme)
and takes its options, plus `binaryContent` and `onAudit`.
`createMcpBoundaryWith(aiContextBoundary, { binaryContent, onAudit })` takes
an AI-context boundary you already built.

### Limits

```js
// Every set is optional and defaults to AI_CONTEXT_DEFAULT_LIMITS; a set you
// pass is used exactly as given, not merged field by field with the preset.
const mcp = await createMcpBoundary({
  wholeInputLimits: { maxInputBytes: 65536, maxFindings: 256 },
  incrementalLimits: {
    maxInputCodeUnits: 1048576,
    maxBufferedCodeUnits: 65536,
    maxTokenCodeUnits: 8192,
    maxMultilineCodeUnits: 32768,
  },
  traversalLimits: { maxDepth: 16, maxNodes: 4096 },
});
```

Those values *are* `AI_CONTEXT_DEFAULT_LIMITS`, re-exported from
[`@redact-secret/adapter-ai-context`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter-ai-context#limits),
which documents each one. **There is no unbounded mode**: every one of them
fails an oversized result closed as `blocked` / `limit_exceeded`.

### PII detection is opt-in

```js
const mcp = await createMcpBoundary({ pii: ["pii:global"] });
```

`pii` is forwarded to `createAiContextBoundary`. PII detection in the core is
opt-in, process-wide and one-shot. With `pii` omitted, an activation the
application already made is accepted. With `pii` given, a selection that is
not the one actually active fails every operation closed as `blocked` /
`core_error` (this factory never rejects) instead of quietly sanitizing with
PII off.

**Activation is not masking.** Under the core's default policy only
`High`-confidence PII is redacted; `Medium` and `Low` resolve to `warn`, which
leaves the text alone. Pass your own `policy` if you need those masked.

Full rules:
[PII guide](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/pii.md).

### Audit metadata

Two callbacks, and nothing else is emitted:

- **`onFinding(finding, { boundary })`**: exactly the eight allowlisted
  finding fields, with `boundary` set to `tool-result`, `tool-arguments`, or
  `resource`.
- **`onAudit(record)`**: one record per crossing,
  `{ stage, outcome, reason?, code? }`. `stage` is `arguments`, `result`, or
  `resource`; `reason` appears only for `blocked`, and `code` only when the
  core raised a registered error. The record holds no count, size, offset, or
  text derived from input.

Both are observational. An exception they throw is swallowed and never read,
and it never changes an outcome.

## What is scanned

A `CallToolResult` is scanned as **one** bounded value. Traversal limits count
from the result root, and every field is scanned, including fields the
contract does not name, so a future field fails closed.

| Part | Treatment |
| --- | --- |
| `text` block | `text` scanned as text, exactly as the model will see it. It is never parsed as JSON: parsing would drop the key context that catches `"password":"..."`. |
| `resource` block with `resource.text` | `text` scanned as text; `uri`, `mimeType`, and the rest scanned as values |
| `resource_link` block | every field scanned; a token in a URL query is caught |
| `image` / `audio` `data`, `resource.blob` | base64, never decoded. **Default: the whole result is `blocked` / `unsupported_value`.** With `binaryContent: "pass"`, a string payload passes unchanged and unscanned at its original key position; every other field of the block is still scanned. A non-string payload always blocks. |
| any other block type, a non-object block, a non-array `content`, a non-object result | `blocked` / `unsupported_value` |
| `structuredContent`, `_meta` (result and block), `annotations`, unknown fields | scanned as values, keys included; each string leaf with its immediate key |

**Key-context backstop.** The AI-context `sanitizeValue` is key-aware
(redact-secret/redact-secret#842): each string leaf is scanned with the key
it sits directly under, so `{"password": "<value>"}` in `structuredContent`
is redacted at its leaf, like the same pair in a text block, and the result
stays `ok`. What the leaf pass cannot see is context from a sibling or parent
key. So after the leaf pass, each value-shaped part of the sanitized result
(the result without `content`, and each block without its scanned `text`)
is still serialized with `JSON.stringify` and scanned again as text. A
`redact` or `block` finding there blocks the whole result as `policy`;
placeholders from the leaf pass are not detected again, so a redacted leaf
never trips it. Sanitized arguments get the same check. The remaining trade
is availability: a structured result whose secret only a sibling or parent
key identifies is blocked, not redacted.

**Migration.** A result or argument set that was `blocked` / `policy` only
because the key-context check found a value its own key identifies is now
`ok`, with that leaf replaced by a placeholder and its finding reported
through `onFinding`. Nothing that used to be redacted or blocked passes now.
If you relied on the block, for example to alert on it, watch `onFinding`
instead.

**Streamed output.** Every chunk goes through one staged stream, so a secret
split across chunks is caught. After every chunk the adapter reads the
stream's `accepting` flag. As soon as it is `false` (a `block` finding, a
limit, a core failure, or cancellation), it pulls nothing more and closes
the producer: `return()` on its iterator, and `destroy()` when the source
has one, as a Node.js `Readable` does. It never waits on either. A real
`AbortSignal` ends a producer that is still pending. Nothing is released
before a successful finalize.

How each operation maps onto the AI-context boundary:

| Operation | AI-context path |
| --- | --- |
| `sanitizeToolResult` | one `sanitizeValue` of the whole result, label `tool-result`, then the key-context backstop |
| `sanitizeToolArguments` | one `sanitizeValue`, label `tool-arguments`, then the key-context backstop |
| `sanitizeToolCall` | optional argument sanitation, then run it: a throw or rejection is `tool_error`; otherwise `sanitizeToolResult` |
| `sanitizeStreamedToolResult` | one staged `openStream`, label `tool-result`, released as `{ content: [{ type: "text", text }] }` |
| `sanitizeResourceResult` | one `sanitizeValue` of the whole result, label `resource`, then the key-context backstop |
| `sanitizeResourceRead` | run it: a throw or rejection is `read_error`; otherwise `sanitizeResourceResult` |

## Outcomes and fixed results

| Outcome | Delivered by `toCallToolResult` |
| --- | --- |
| `ok` | the sanitized value, and nothing else |
| `blocked` (`policy`, `limit_exceeded`, `unsupported_value`, `lifecycle`, `core_error`) | the fixed blocked result |
| `tool_error` (the tool, a client `callTool` rejection or `McpError`, or a producer threw; the error is never read) | the fixed tool-error result |
| `aborted` | `null`: nothing. A server SDK sends no response to a cancelled request. |

```json
{ "content": [{ "type": "text", "text": "This MCP tool call was blocked by secret-redaction policy. No content, arguments, or error detail is included." }], "isError": true }
{ "content": [{ "type": "text", "text": "This MCP tool call failed. No content, arguments, or error detail is included." }], "isError": true }
```

Each fixed result is a new object on every call, with no `structuredContent`
and no `_meta`. A failure is never a JSON-RPC error: its `message` and `data`
are free text that SDKs and hosts log verbatim. The server wrappers catch
every handler failure themselves, so the SDK's own conversion of a thrown
error into `isError` text containing `error.message` never runs.

## `resources/read`

The core's
[`resources/read` contract](https://github.com/redact-secret/redact-secret/blob/main/docs/reference/mcp-resources-read.md)
(redact-secret/redact-secret#843) applies the same mapping to what a client
reads from a server:

```js
import { toReadResourceResponse } from "@redact-secret/adapter-mcp";

const outcome = await mcp.sanitizeResourceRead(({ signal }) => client.readResource({ uri }, { signal }));
const response = toReadResourceResponse(outcome); // { result } | { error } | null when cancelled
```

- The whole `ReadResourceResult` is **one** value under the `resource`
  label: every `contents[]` entry's `uri`, `mimeType`, `text`, and `_meta`,
  the result's `_meta`, and unknown fields. Limits count from the result
  root. `text` is scanned as text whatever its `mimeType`, so a JSON or
  config file keeps its key context, and a `_meta` leaf its own key
  identifies is redacted in place. The same key-context backstop runs after.
- An entry must be exactly one of a string `text` or a `blob`. A `blob`
  blocks the result as `unsupported_value` unless you set
  `binaryContent: "pass"`, the same opt-in as tool-result binary content.
- A `ReadResourceResult` has no `isError`, so every failure is a fixed
  JSON-RPC error, code `-32603`, no `data`:

  ```json
  { "code": -32603, "message": "This MCP resource read was blocked by secret-redaction policy. No content, URI, or error detail is included." }
  { "code": -32603, "message": "This MCP resource read failed. No content, URI, or error detail is included." }
  ```

  `blocked` maps to the first, `read_error` (a rejected `readResource`, an
  `McpError`, or a throwing read callback; the error is never read) to the
  second, and `aborted` to nothing. `wrapResourceReadHandler` throws a
  `McpResourceError` whose `code` and `message` are exactly these, and both
  server SDK lines send that as the JSON-RPC error unchanged. The 1.x client
  exposes it with an `MCP error -32603: ` prefix.
- **SDK response cache.** The `@modelcontextprotocol/client` 2.x `Client`
  stores a `resources/read` result in its `responseCacheStore` when the
  server sends `ttlMs`, before your host sees it. The default store is in
  memory. If you supply a persistent or shared store, read resources with
  `cacheMode: "bypass"` (`client.readResource({ uri }, { signal, cacheMode: "bypass" })`),
  or the raw contents are persisted before the boundary.
- The client SDKs parse a result with their own schema before the boundary
  runs. They drop unknown fields inside a `contents` entry, and the `blob`
  of an entry that also has `text`, and they reject a malformed result
  (`read_error` here). That only removes content; the boundary still scans
  everything the host receives.

## Supported range

| Surface | Supported, and tested at both endpoints in CI |
| --- | --- |
| TypeScript SDK, 1.x | `@modelcontextprotocol/sdk` `>=1.26.0 <=1.30.1` (optional peer) |
| TypeScript SDK, 2.x | `@modelcontextprotocol/client` and `@modelcontextprotocol/server` `>=2.0.0 <=2.1.0` (optional peers) |
| Protocol revisions | `2025-11-25` (negotiated by 1.26.0, 1.30.1, 2.0.0, 2.1.0) |
| Transports | stdio and Streamable HTTP |
| MCP messages | `tools/call` and `resources/read`, over every line, protocol, and transport above |
| Core | `@redact-secret/core ^0.1.0-beta.6` (required peer) |
| Runtime | Node.js 20, 22, 24 |

The SDK peer ranges are capped at the highest tested version, so npm refuses
an untested SDK instead of installing it.

The 1.x floor is 1.26.0, the first release clear of three high-severity SDK
advisories: DNS rebinding protection off by default
([GHSA-w48q-cv73-mx4w](https://github.com/advisories/GHSA-w48q-cv73-mx4w)), a
ReDoS in `UriTemplate`
([GHSA-8r9q-7v3j-jr4g](https://github.com/advisories/GHSA-8r9q-7v3j-jr4g)), and
a cross-client data leak when a server or transport is reused
([GHSA-345p-7cg4-v4c7](https://github.com/advisories/GHSA-345p-7cg4-v4c7)).
None of them is in code this adapter runs, since it only wraps handlers the
host registers. They are in the SDK the host deploys around it, though, and
this package does not qualify a version that carries them. Protocol
`2025-06-18` is therefore no longer negotiated at any tested endpoint.

Both server SDK lines validate a tool's result before sending it. An
unwrapped server that returns an unknown block type, a non-object block, a
non-array `content`, or a non-object result answers with a JSON-RPC error
instead, and that error's message is the validator's report, which can quote
parts of the result. On the host, `sanitizeToolCall` maps the rejected call to
`tool_error` without reading the error, so the outcome still fails closed. A
server that wraps its handlers returns the fixed blocked result before that
validation runs. Either way, do not log a raw `McpError` from `callTool`.

## Security non-goals

This package does **not** provide, and must not be described as providing:

- **MCP authentication or authorization.** Who may connect, and with which
  credentials, is the transport's and your host's job.
- **Prompt-injection prevention.** A tool result can still carry
  instructions aimed at the model. Redaction removes secrets, not intent.
- **Tool permission decisions.** Whether a tool may run, and with which
  arguments, is your host's policy. Argument sanitation redacts secrets in
  arguments. It does not authorize the call.
- **Resource permissions.** Which resources a client may read, and whether
  a server should expose them, is the server's and your host's policy.
  `resources/read` sanitation redacts secrets in what was read. It does not
  authorize the read.
- **Model-output moderation.** What the model writes back is a different
  boundary.
- **Secret restoration.** A placeholder is never turned back into the secret.
- **Support for untested SDKs or transports.** Only the table above is
  claimed. The Python `mcp` SDK, other language SDKs, the deprecated
  HTTP+SSE transport, `experimental.tasks`, and partial-result delivery are
  not supported.

It also does not cover:

- **A secret split across content blocks, `contents` entries, fields, tool
  calls, or reads.** Each is scanned on its own. Only a split across the
  chunks of one streamed output is joined.
- **MCP messages other than `tools/call` and `resources/read`**:
  `resources/list`, `resources/templates/list` (names, titles, and
  descriptions are server-authored listing metadata), `resources/subscribe`
  and `notifications/resources/updated` (they carry only a URI; the new
  contents arrive through a `resources/read`, which is covered),
  `notifications/resources/list_changed`, `prompts/get`, sampling,
  elicitation, completion, and logging or progress notifications.
- **Binary content on opt-in.** With `binaryContent: "pass"`, base64
  payloads (`image`/`audio` `data`, a `blob`) pass unscanned. Decoding them
  is not attempted.
- **Raw results an SDK keeps before the boundary**, such as a persistent
  `responseCacheStore` on the 2.x client (see [`resources/read`](#resourcesread)).
- **Anything the AI-context boundary excludes**: encoded values, incomplete
  detection (an `ok` with no findings is not proof that no secret was
  present), plaintext in process memory, and your own callbacks, which are
  trusted code.

## How it is verified

It implements the core's
[MCP boundary contract](https://github.com/redact-secret/redact-secret/blob/main/docs/reference/mcp-boundary.md)
(redact-secret/redact-secret#612) as a thin specialization of
`@redact-secret/adapter-ai-context`: every scan, nested-value walk, policy
decision, limit, and core-error mapping comes from that package, and this one
adds only the MCP shape. It qualifies by replaying the core's own MCP fixture
with the core's own runner, both vendored byte-for-byte at a pinned core
commit
([`fixtures/core/pins.json`](https://github.com/redact-secret/redact-secret-adapters/blob/main/fixtures/core/pins.json)),
through this package's public API, and it is exercised with real MCP SDK
instances at both endpoints of every supported line, over stdio and Streamable
HTTP.

## Contributing

Issues and pull requests are welcome:
[CONTRIBUTING.md](https://github.com/redact-secret/redact-secret-adapters/blob/main/CONTRIBUTING.md).
Changes are listed in this package's `CHANGELOG.md`.

## License

MIT
