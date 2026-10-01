# @redact-secret/adapter-ai-context

[![npm version](https://img.shields.io/npm/v/@redact-secret/adapter-ai-context)](https://www.npmjs.com/package/@redact-secret/adapter-ai-context)
[![npm downloads](https://img.shields.io/npm/dm/@redact-secret/adapter-ai-context)](https://www.npmjs.com/package/@redact-secret/adapter-ai-context)
[![core peer range](https://img.shields.io/npm/dependency-version/@redact-secret/adapter-ai-context/peer/@redact-secret/core)](https://www.npmjs.com/package/@redact-secret/adapter-ai-context?activeTab=dependencies)
[![Node.js](https://img.shields.io/node/v/@redact-secret/adapter-ai-context)](https://www.npmjs.com/package/@redact-secret/adapter-ai-context)
[![types included](https://img.shields.io/npm/types/@redact-secret/adapter-ai-context)](https://www.npmjs.com/package/@redact-secret/adapter-ai-context)
[![CI](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/redact-secret/redact-secret-adapters/badge)](https://scorecard.dev/viewer/?uri=github.com/redact-secret/redact-secret-adapters)
[![License: MIT](https://img.shields.io/npm/l/@redact-secret/adapter-ai-context)](https://github.com/redact-secret/redact-secret-adapters/blob/main/LICENSE)

Remove secrets from what you send to a model. Sanitize user input, tool
results, a whole prompt context, or streamed text **before** any of it reaches
a model, a tool, a log line, or storage.

It works with any model vendor or agent framework, because you call it
yourself at the point where your code builds the context. Built on the
[Redact Secret](https://github.com/redact-secret/redact-secret) core, which
does the detection.

## Install

```bash
npm install @redact-secret/adapter-ai-context @redact-secret/core
```

Needs Node.js 20, 22 or 24. ESM only. The core is a required peer.

## Quick start

<!-- smoke-test:example -->
```js
import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";

// Conservative documented default limits. Override any of them below.
const boundary = await createAiContextBoundary({
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

CI runs this block verbatim from a clean install outside the repository
(`npm run smoke-test`).

## The one rule: only use `ok.value`

Every operation ends in exactly one of three frozen shapes:

```text
{ outcome: "ok",      value, findings }
{ outcome: "blocked", reason, code? }
{ outcome: "aborted" }
```

`ok.value` is the only thing that may go to a model, a tool, a log, or
storage. A `blocked` or `aborted` outcome never carries a value, findings,
partial text, an excerpt, or a count derived from input. There is no partial
result and no fallback to the input.

## What you can call

| Operation | Use it for |
| --- | --- |
| `sanitizeText(text, { boundary, signal })` | one string |
| `sanitizeValue(value, { boundary, signal })` | a JSON-shaped value: every string **and every object key** is scanned |
| `sanitizeToolResult(result, { signal })` | a tool's result, before it joins context |
| `buildContext(parts, { signal })` | ordered `{ role, text }` / `{ role, value }` parts; returns `[{ role, content }]` |
| `openStream({ boundary, signal })` | chunks of one text: `append`, then `finalize`, or `abort` |

`boundary` is a label for telemetry: `"user-input"`, `"tool-result"`,
`"tool-arguments"`, `"resource"`, or `"context"` (the default). It never
changes an outcome. `signal` is an `AbortSignal` (or anything with an `aborted`
flag).

## Things that surprise people

- **Non-JSON values are refused, not converted.** A `Date`, a `Map`, a class
  instance, an `Error`, `undefined`, binary or base64 content, and encoded text
  are `blocked` / `unsupported_value`. Convert values to JSON shapes yourself,
  so what is scanned is exactly what you send.
- **Limits are always on.** An oversized input is `blocked` /
  `limit_exceeded`, never truncated. See [Limits](#limits).
- **A stream releases nothing until `finalize`.** Text released earlier could
  not be recalled after a later `block`.
- **A secret in an object key blocks the value.** A key cannot be rewritten
  without changing the value's shape.
- **`ok` with no findings is not proof** that no secret was present. Detection
  is not complete.
- **Model output is not covered.** This is for what goes *into* context.

## Options

```js
await createAiContextBoundary({
  onFinding, pii, policy, placeholderFormatter,
  wholeInputLimits, incrementalLimits, traversalLimits,
});
```

### Limits

```js
// Every set is optional and defaults to AI_CONTEXT_DEFAULT_LIMITS; a set you
// pass is used exactly as given, not merged field by field with the preset.
const boundary = await createAiContextBoundary({
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

Those values *are* `AI_CONTEXT_DEFAULT_LIMITS`, exported so you can read, log
or extend them. They are conservative on purpose: the first failure a new
integration meets should be a fixed `blocked` / `limit_exceeded` outcome on an
oversized input, not an unbounded scan.

| Limit | Default | Bounds |
| --- | --- | --- |
| `maxInputBytes` | 65536 | one whole-input scan |
| `maxFindings` | 256 | findings collected for one scan |
| `maxInputCodeUnits` | 1048576 | one streamed session, total |
| `maxBufferedCodeUnits` | 65536 | what a session holds while a candidate is open |
| `maxTokenCodeUnits` | 8192 | one candidate token |
| `maxMultilineCodeUnits` | 32768 | one multi-line candidate |
| `maxDepth` | 16 | nested containers, the root counting as 1 |
| `maxNodes` | 4096 | values visited in one `sanitizeValue` |

**There is no unbounded mode.** The preset names the limits so you do not have
to invent them, and nothing switches them off.

Two things to know:

- **Omitted is defaulted; present is used as given.** A key that is present but
  `undefined` (how `traversalLimits: config.limits` looks when `config` is
  missing) is still a `TypeError`, not silently the preset. A set that *is*
  given is used whole, never merged field by field with the preset.
- `sanitizeValue` also scans a leaf inside its key-context view
  `{"<key>":"<leaf>"}`, so a leaf's usable budget is `maxInputBytes` minus that
  key and its JSON punctuation. With the default 64 KiB that is noise; with a
  small override it is what binds first.

`createAiContextBoundaryWith`, the injected API, requires all three sets
explicitly; pass `withDefaultLimits()` to hand it the preset.
`test/defaults.test.ts` asserts against the real core that each preset bound
is enforced, that a streamed text agrees with `sanitizeText` at every chunk
partition under it, and that an override replaces rather than widens.

### PII detection is opt-in

The core detects credentials out of the box. PII detection is a separate
activation, process-wide and one-shot:

```js
const boundary = await createAiContextBoundary({ pii: ["pii:global"] });
```

With `pii` omitted, an activation the application already made is accepted.
With `pii` given, the factory checks the core afterwards and refuses when the
active selection is not the one you asked for. **This factory still never
rejects**: that refusal is an initialization failure like any other, so every
operation fails closed as `blocked` / `core_error` (with no `code`) instead of
quietly building context with PII off.

**Activation is not masking.** Under the core's default policy only
`High`-confidence PII is redacted; `Medium` and `Low` resolve to `warn`, which
leaves the text alone. An `ok` whose `findings` is non-empty but whose `value`
equals the input is exactly this case. Pass your own `policy` if you need
those masked.

Full rules:
[PII guide](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/pii.md).

### Findings and telemetry

`onFinding(finding, { boundary })` is called once per finding, in scan order,
including for a scan that ends up blocked. It is observational: an exception
it throws is swallowed, never read, and never changes an outcome. Nothing else
is emitted.

A finding in `ok.findings`, or passed to `onFinding`, is a frozen copy holding
exactly `id`, `type`, `detector`, `confidence`, `action`, `obfuscation`,
`start`, and `end`, copied by allowlist, so a field the core adds later cannot
reach a host. Offsets are UTF-16 code units, relative to the string that was
scanned (for `sanitizeValue`, each leaf is its own string). They reveal where
a secret sat and how long it was, never what it was.

## Reference

### Outcomes

| Cause | Outcome |
| --- | --- |
| Any finding whose resolved action is `block` | `blocked` / `policy` |
| An object key with a `redact` or `block` finding | `blocked` / `policy` |
| `INPUT_LIMIT_EXCEEDED`, `FINDING_LIMIT_EXCEEDED`, `BUFFER_LIMIT_EXCEEDED`, `TOKEN_LIMIT_EXCEEDED`, `MULTILINE_LIMIT_EXCEEDED` | `blocked` / `limit_exceeded` + `code` |
| `traversalLimits.maxDepth` or `maxNodes` exceeded | `blocked` / `limit_exceeded`, no code |
| Anything other than a string, finite number, boolean, `null`, array, or plain object (`undefined`, `NaN`, a `Date`, a `Map`, a class instance, an `Error`, an array hole, a throwing getter), or a cycle | `blocked` / `unsupported_value` |
| `INVALID_STATE`, or a second `finalize` | `blocked` / `lifecycle` |
| Any other core error (`NOT_INITIALIZED`, `INITIALIZATION_FAILED`, `POLICY_FAILURE`, `PLACEHOLDER_FAILURE`, `UNPAIRED_SURROGATE`, …), or a malformed core result | `blocked` / `core_error` + `code` when the core gave one |
| Signal aborted, or `abort()` before a successful `finalize` | `aborted` |

`code` is forwarded only when it is in the core's fixed error-code registry.
An error message is never read or forwarded, not even the core's fixed one,
and a thrown value that is not the core's own maps to `core_error` with no
code.

### How each operation scans

| Operation | Core path |
| --- | --- |
| `sanitizeText` | one whole-input `scanAndRedact` |
| `sanitizeValue` | one whole-input scan per string leaf **and per object key**, plus one key-context scan for a leaf under an object key that its own scan does not redact; a text already scanned in the same call (up to 1,024 code units) reuses that result, and `onFinding` still fires per occurrence |
| `sanitizeToolResult` | `sanitizeText` for a string, `sanitizeValue` otherwise, labelled `tool-result` |
| `buildContext` | the above per part |
| `openStream` | one incremental session, staged |

`createAiContextBoundary(options)` loads the core, awaits `initialize()`, and
returns the boundary. `createAiContextBoundaryWith(core, options)` takes the
core injected (`{ scanAndRedact, createIncrementalSanitizer }`, i.e.
`@redact-secret/core` itself after `initialize()`, or a fake in tests).

### Key-aware `sanitizeValue`

A string leaf is scanned with the object key it sits directly under
(redact-secret/redact-secret#842), so `{ "api_key": "<value>" }` is redacted at
that leaf even when the value does not identify itself, the same way the pair
is redacted in text. The leaf is scanned alone first. If that redacts nothing,
it is scanned again, through the same `scanAndRedact`, in its key-context view
`{"<key>":"<leaf>"}`, and a finding there is reported with offsets into the
leaf.

The core's contextual detection decides whether the pair is a secret: this
package holds no key pattern or list of credential names. Only the immediate
key counts. Array elements, parent keys, and sibling keys give no context, and
numbers, booleans, and `null` are unchanged. A view over `maxInputBytes`
blocks the value as `limit_exceeded`. The false positives are the core's own:
a non-secret under a credential name (`{ "password": "Welcome to the password
reset flow" }`) is redacted too, while names like `token_count` or
`secret_name` and placeholders stay clean.

**Migration.** A leaf that used to pass in plaintext, because only its key
identified it, is now replaced by a placeholder and reported in `ok.findings`
and telemetry. Nothing that used to be redacted or blocked passes now.

### Lifecycle rules

- **Limits are mandatory.** `wholeInputLimits`, `incrementalLimits` and
  `traversalLimits` are all in force at all times. The live factory fills in
  any set you leave out from `AI_CONTEXT_DEFAULT_LIMITS` (since
  `0.1.0-alpha.2`); `createAiContextBoundaryWith` requires all three. The core
  enforces the first two before the detection work they exist to prevent; this
  package enforces traversal limits. Exceeding any limit fails the whole
  operation. Nothing is truncated or marked and passed on. A malformed limit
  set is a `TypeError` at construction; an invalid core limit is `core_error` /
  `INVALID_LIMITS` on first use.
- **Initialization.** An operation before the core is initialized is
  `core_error` / `NOT_INITIALIZED`, from the core's own error. If
  `createAiContextBoundary` cannot load or initialize the core, it still
  resolves, and every operation fails closed with the mapped outcome
  (`core_error` / `INITIALIZATION_FAILED`). Call it again to retry. Nothing
  ever falls back to returning input.
- **Cancellation.** An already-aborted signal ends the operation as `aborted`
  before any scan or session is created. The signal is checked again after
  scanning, between context parts, and on every `append` and `finalize`. A
  real `AbortSignal` also aborts an open stream's core session the moment it
  fires.
- **Staging.** A stream releases nothing before a successful `finalize`, even
  when the core emits sanitized text from `append`. A `block` finding, a limit
  failure, or a callback failure mid-stream aborts the core session at once,
  and later appends are discarded unscanned.
- **Early failure.** `stream.accepting` is `true` until the stream fails (a
  `block` finding, a limit, a lifecycle or core failure), is aborted, or is
  finalized. Read it after every `append`: once it is `false`, stop pulling
  from the producer and close it, since later chunks would be discarded
  unscanned. It is input-free and never says why; the reason arrives at
  `finalize`.
- **Single use.** The first `finalize` returns the outcome; every later
  `finalize` is `blocked` / `lifecycle`. An `append` after `finalize` is
  discarded unscanned, and `abort()` after a successful `finalize` does
  nothing.
- **All or nothing.** If any part of `buildContext` is not `ok`, the whole
  context is that outcome; no partial context exists.
- **Callbacks.** A throwing `policy` or `placeholderFormatter` becomes the
  core's `POLICY_FAILURE` / `PLACEHOLDER_FAILURE`, so the operation fails
  closed as `core_error`.

For text within both the whole-input and incremental limits, a staged stream's
outcome equals `sanitizeText`'s for the same text at every chunk partition.
The conformance replay checks this directly.

## Security boundaries

- **Server-side is authoritative.** A client-side boundary is preventive UX.
  Apply this boundary again on the server, even when the client already did.
- **Detection is not complete.** An `ok` outcome with no findings is not proof
  that no secret was present.
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

## What it does not do

- **No vendor or framework wiring.** No OpenAI, Anthropic, LangChain, or
  LangGraph client wrapping or monkey-patching, and no MCP transport handling
  (for MCP tool calls, use
  [`@redact-secret/adapter-mcp`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter-mcp#readme)).
  Call the boundary yourself where your framework builds context or receives a
  tool result.
- **No model output.** This covers what goes *into* context. Scanning a
  model's response is a different boundary.
- **No progressive stream release.** Stream output is released only at
  `finalize`.
- **No decoding.** Non-text content (images, audio, binary) and encoded values
  (base64, percent-encoding) are neither decoded nor scanned.
- **No cross-value joins.** A secret split across separate values, object
  keys, or context parts is not reassembled; each is scanned on its own. Only
  a split across chunks of one stream is handled.
- **No non-JSON values.** `Date`, `Map`, class instances, `Error`s and
  `toJSON()` objects are refused, not serialized.
- No secret restoration, prompt-injection detection, or tool authorization.

## How it is verified

It implements the core's
[AI-context boundary contract](https://github.com/redact-secret/redact-secret/blob/main/docs/reference/ai-context-boundary.md)
(redact-secret/redact-secret#610) and qualifies by replaying the core's own
conformance fixture, vendored byte-for-byte at a pinned core commit
([`fixtures/core/pins.json`](https://github.com/redact-secret/redact-secret-adapters/blob/main/fixtures/core/pins.json)),
through this package's public API.

Package size and initialization time: `npm run footprint`. Per-event traversal
and scan overhead: `node scripts/measure-overhead.mjs --host ai-context-js`.
See
[docs/performance.md](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/performance.md).

## Contributing

Issues and pull requests are welcome:
[CONTRIBUTING.md](https://github.com/redact-secret/redact-secret-adapters/blob/main/CONTRIBUTING.md).
Changes are listed in this package's `CHANGELOG.md`.

## License

MIT
