# @redact-secret/adapter-ai-context

A framework-neutral boundary for AI workflows, over the
[Redact Secret](https://github.com/redact-secret/redact-secret) core: sanitize
user input, tool results, a constructed model context, and streamed text
**before** any of it reaches a model, a tool, a log line, or storage.

It implements the core's
[AI-context boundary contract](https://github.com/redact-secret/redact-secret/blob/main/docs/reference/ai-context-boundary.md)
(redact-secret/redact-secret#610) and qualifies by replaying the core's own
conformance fixture, vendored byte-for-byte at a pinned core commit
([`fixtures/core/pins.json`](../../fixtures/core/pins.json)), through this
package's public API. It names no model vendor, agent framework, or transport.

> **Unreleased.** This package is not on npm yet (`"private": true` in its
> manifest, and it is not wired into the release train). To consume it
> before then, build a publish-shaped tarball from an immutable commit of this
> repository with `npm pack`; see [Consuming it unreleased](#consuming-it-unreleased).

## Example

<!-- smoke-test:example -->
```js
import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";

const boundary = await createAiContextBoundary({
  wholeInputLimits: { maxInputBytes: 65536, maxFindings: 256 },
  incrementalLimits: {
    maxInputCodeUnits: 1048576,
    maxBufferedCodeUnits: 65536,
    maxTokenCodeUnits: 8192,
    maxMultilineCodeUnits: 32768,
  },
  traversalLimits: { maxDepth: 16, maxNodes: 4096 },
  onFinding: (finding, { boundary }) => console.error("finding", boundary, finding.type, finding.action),
});

// Synthetic values only.
const userText = "deploy with API_KEY=ghp_SYNTHETICREVOKED00000000000000000000";
const toolResult = { content: [{ type: "text", text: "build ok" }], exitCode: 0 };

const context = boundary.buildContext([
  { role: "user", boundary: "user-input", text: userText },
  { role: "tool", boundary: "tool-result", value: toolResult },
]);
if (context.outcome !== "ok") {
  // `reason` and `code` are fixed labels: safe to log. There is no value.
  throw new Error(`context refused: ${context.outcome} ${context.reason ?? ""}`);
}
console.log(JSON.stringify(context.value));
// [{"role":"user","content":"deploy with API_KEY=<SECRET_1>"},{"role":"tool","content":{"content":[{"type":"text","text":"build ok"}],"exitCode":0}}]
```

The clean-install smoke test (`npm run smoke-test`) runs this block verbatim
from a throwaway project outside the repository.

## Operations

| Operation | Input | Core path |
| --- | --- | --- |
| `sanitizeText(text, { boundary, signal })` | one string | one whole-input `scanAndRedact` |
| `sanitizeValue(value, { boundary, signal })` | a bounded JSON-shaped value | one whole-input scan per string leaf **and per object key** |
| `sanitizeToolResult(result, { signal })` | a tool's result, before it joins context | `sanitizeText` for a string, `sanitizeValue` otherwise, labelled `tool-result` |
| `buildContext(parts, { signal })` | ordered `{ role, text }` / `{ role, value }` parts, each with an optional `boundary` | the above per part; returns `[{ role, content }]` |
| `openStream({ boundary, signal })` | chunks of one logical text: `append`, then `finalize`, or `abort` | one incremental session, staged |

`boundary` is `"user-input"`, `"tool-result"`, or `"context"` (the
default). It goes to telemetry only and never changes an outcome. `signal`
is an `AbortSignal` (or anything with an `aborted` flag).

`createAiContextBoundary(options)` loads the core, awaits `initialize()`, and
returns the boundary. `createAiContextBoundaryWith(core, options)` takes the
core injected (`{ scanAndRedact, createIncrementalSanitizer }`, i.e.
`@redact-secret/core` itself after `initialize()`, or a fake in tests).

## Outcomes

Every operation ends in exactly one of three frozen shapes:

```text
{ outcome: "ok",      value, findings }
{ outcome: "blocked", reason, code? }
{ outcome: "aborted" }
```

`ok.value` is the only thing that may go to a model, a tool, a log, or
storage. A `blocked` or `aborted` outcome never carries a value, findings,
partial text, an excerpt, or a count derived from input.

| Cause | Outcome |
| --- | --- |
| Any finding whose resolved action is `block` | `blocked` / `policy` |
| An object key with a `redact` or `block` finding (a key cannot be rewritten without changing the value's shape) | `blocked` / `policy` |
| `INPUT_LIMIT_EXCEEDED`, `FINDING_LIMIT_EXCEEDED`, `BUFFER_LIMIT_EXCEEDED`, `TOKEN_LIMIT_EXCEEDED`, `MULTILINE_LIMIT_EXCEEDED` | `blocked` / `limit_exceeded` + `code` |
| `traversalLimits.maxDepth` or `maxNodes` exceeded | `blocked` / `limit_exceeded`, no code |
| Anything other than a string, finite number, boolean, `null`, array, or plain object — `undefined`, `NaN`, a `Date`, a `Map`, a class instance, an `Error`, an array hole, a throwing getter — or a cycle | `blocked` / `unsupported_value` |
| `INVALID_STATE`, or a second `finalize` | `blocked` / `lifecycle` |
| Any other core error (`NOT_INITIALIZED`, `INITIALIZATION_FAILED`, `POLICY_FAILURE`, `PLACEHOLDER_FAILURE`, `UNPAIRED_SURROGATE`, …), or a malformed core result | `blocked` / `core_error` + `code` when the core gave one |
| Signal aborted, or `abort()` before a successful `finalize` | `aborted` |

`code` is forwarded only when it is in the core's fixed error-code
registry. An error message is never read or forwarded, not even the core's
fixed one, and a thrown value that is not the core's own maps to
`core_error` with no code.

## Safe metadata and telemetry

A finding in `ok.findings`, or passed to telemetry, is a frozen copy holding
exactly `id`, `type`, `detector`, `confidence`, `action`, `obfuscation`,
`start`, and `end`, copied by allowlist, so a field the core adds later
cannot reach a host. Offsets are UTF-16 code units, relative to the string
that was scanned (for `sanitizeValue`, each leaf is its own string). They
reveal where a secret sat and how long it was, never what it was.

`onFinding(finding, { boundary })` is called once per finding, in scan
order, including for a scan that ends up blocked. It is observational: an
exception it throws is swallowed, never read, and never changes an outcome.
Nothing else is emitted.

## Lifecycle rules

- **Limits are mandatory.** `wholeInputLimits`, `incrementalLimits` and
  `traversalLimits` must all be given. The core enforces the first two before
  the detection work they exist to prevent; this package enforces traversal
  limits. Exceeding any limit fails the whole operation. Nothing is truncated
  or marked and passed on. A malformed limit set is a `TypeError` at
  construction; an invalid core limit is `core_error` / `INVALID_LIMITS` on
  first use.
- **Initialization.** An operation before the core is initialized is
  `core_error` / `NOT_INITIALIZED`, from the core's own error. If
  `createAiContextBoundary` cannot load or initialize the core, it still
  resolves, and every operation fails closed with the mapped outcome
  (`core_error` / `INITIALIZATION_FAILED`). Call it again to retry. Nothing
  ever falls back to returning input.
- **Cancellation.** An already-aborted signal ends the operation as
  `aborted` before any scan or session is created. The signal is checked
  again after scanning, between context parts, and on every `append` and
  `finalize`. A real `AbortSignal` also aborts an open stream's core session
  the moment it fires.
- **Staging.** A stream releases nothing before a successful `finalize`,
  even when the core emits sanitized text from `append`. A `block` finding, a
  limit failure, or a callback failure mid-stream aborts the core session at
  once, and later appends are discarded unscanned.
- **Single use.** The first `finalize` returns the outcome; every later
  `finalize` is `blocked` / `lifecycle`. An `append` after `finalize` is
  discarded unscanned, and `abort()` after a successful `finalize` does
  nothing.
- **All or nothing.** If any part of `buildContext` is not `ok`, the whole
  context is that outcome; no partial context exists.
- **Callbacks.** A throwing `policy` or `placeholderFormatter` becomes the
  core's `POLICY_FAILURE` / `PLACEHOLDER_FAILURE`, so the operation fails
  closed as `core_error`.

For text within both the whole-input and incremental limits, a staged
stream's outcome equals `sanitizeText`'s for the same text at every chunk
partition. The conformance replay checks this directly.

## Security boundaries

- **Server-side is authoritative.** A client-side boundary is preventive UX.
  Apply this boundary again on the server, even when the client already did.
- **Detection is not complete.** An `ok` outcome with no findings is not
  proof that no secret was present.
- **Callbacks are trusted code.** `policy`, `placeholderFormatter` and
  `onFinding` receive safe metadata only, but a closure can still capture raw
  input. This package limits what it hands over, not what your code does.
- **Plaintext exists in process memory.** Discarding staged text and aborting
  the core session does not zeroize memory or erase your own copy of the
  input.
- **`role` is not scanned.** It is a host-chosen label and must be a string;
  never put untrusted text in it.
- This package detects nothing and decides no policy. It hands text to the
  core and maps what comes back.

## Unsupported framework behavior

- **No vendor or framework wiring.** No OpenAI, Anthropic, LangChain, or
  LangGraph client wrapping or monkey-patching, and no MCP transport handling
  (an MCP specialization is redact-secret-adapters#13). Call the boundary
  yourself where your framework builds context or receives a tool result.
- **No model output.** This covers what goes *into* context. Scanning a
  model's response is a different boundary.
- **No progressive stream release.** Stream output is released only at
  `finalize`: text released earlier could not be recalled after a later
  `block`.
- **No decoding.** Non-text content (images, audio, binary) and encoded
  values (base64, percent-encoding) are neither decoded nor scanned.
- **No cross-value joins.** A secret split across separate values, object
  keys, or context parts is not reassembled; each is scanned on its own. Only
  a split across chunks of one stream is handled.
- **No non-JSON values.** `Date`, `Map`, class instances, `Error`s and
  `toJSON()` objects are refused, not serialized: convert them yourself, so
  what is scanned is exactly what you send.
- No secret restoration, prompt-injection detection, or tool authorization.

## Consuming it unreleased

Until this package is published, build it from an immutable 40-hex commit of
this repository, and install `@redact-secret/adapter` from the same commit:
this package uses `walkStrict`, which is not in the published
`@redact-secret/adapter@0.1.0`.

```bash
git clone https://github.com/redact-secret/redact-secret-adapters && cd redact-secret-adapters
git checkout <40-hex commit>
npm ci && npm run build
npm pack --workspace @redact-secret/adapter --workspace @redact-secret/adapter-ai-context --pack-destination <dir>
# in the consumer, install the adapter tarball first, then this one
```

## Measuring it

Package size and initialization time: `npm run footprint`
(`scripts/measure-footprint.mjs`). Per-event traversal and scan overhead:
`node scripts/measure-overhead.mjs --host ai-context-js`, which keeps the
boundary's own traversal cost (over a scanner that finds nothing) apart from
the core's scan of exactly the strings and keys it hands the core. Neither
carries a threshold; budgets live in
[redact-secret-benchmarks](https://github.com/redact-secret/redact-secret-benchmarks).

## License

MIT
