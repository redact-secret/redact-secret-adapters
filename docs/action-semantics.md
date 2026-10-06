# Policy action semantics at each boundary

A core finding carries one action: `allow`, `warn`, `redact` or `block`. What a
host does with that action is decided by the boundary, not by the core, and the
boundaries do not all do the same thing. This page is the truth table: for each
action, each failure and each limit, what each supported boundary puts in its
output. It records existing behavior. It adds no API and changes no outcome.

Every cell below is asserted by an executable test over the real adapters and
the real published core, with the exact host output spelled out
([how it is qualified](#how-this-is-qualified)). Values are synthetic.

## Read this first

- **`allow` and `warn` leave the value in the output.** The adapter does not
  mask, drop or block it. A `warn` is a finding the caller was told about, and an
  `allow` is a finding the policy chose to let through. The credential is still in
  the log line, the span, the model context or the tool result. Acting on it is
  the caller's responsibility: read the finding (`ok.findings`, the outcome
  counters, `onFinding`) and decide. Do not use `warn` or `allow` to "see what
  would happen" on a path whose output you still ship.
- **`policy` replaces the core's built-in policy.** It is the only policy
  surface in the published core (`@redact-secret/core` `0.1.0-beta.13`). It is a
  callback that sees safe finding metadata and returns an action for every
  finding, so a `policy` that returns `redact` for everything also redacts what
  the built-in policy would block. The default (no `policy`) is the core's
  built-in policy, which `redact`s most credentials, `block`s private keys and
  resolves low-confidence PII to `warn` (see [PII](./pii.md#activation-is-not-masking)).
- **Detection is the core's decision.** A clean output is not proof that the
  input held no secret ([README](../README.md#four-things-to-know-before-you-rely-on-it)).

## Two families of boundary

| | Logging and tracing | AI-context and MCP |
| --- | --- | --- |
| Packages | `adapter` (`createMaskSecrets`), `adapter-pino`, `adapter-otel-trace`, `adapter-otel-logs`; Python `logging` and OpenTelemetry (see [not covered](#what-this-page-does-not-cover)) | `adapter-ai-context`, `adapter-mcp` |
| The output is | The same record or span, with fixed markers in the places that could not be released | Either the whole sanitized value, or nothing |
| `block` | The **whole string** becomes `[REDACTED:BLOCKED]`; the rest of the record is kept | The **whole operation** is `blocked` / `policy`, with no value |
| Failure or limit | A fixed marker on the value, or the value dropped | `blocked` (with a fixed reason) or `aborted`, with no value |
| Why | A log line with one masked field is still useful and safe to write | A model context that is partly masked is not safe to use |

Neither family is a unified result type, on purpose
([decision](./decisions/2026-10-06-document-action-semantics-instead-of-a-unified-result.md)).

## Truth table: logging and tracing

One finding in one string (`x <token> y`), under a `policy` that returns each action.
`<token>` stands for a synthetic GitHub-token-shaped value. The same
output holds for the walker (`createMaskSecrets`), every pino value (message, field,
child binding and `mixin()` output), every span string (name, attribute, event
attribute) and every log record string (body, attribute).

| Action | The string becomes | Counter effect |
| --- | --- | --- |
| `allow` | `x <token> y`, unchanged | `findings` +1, nothing else |
| `warn` | `x <token> y`, unchanged | `findings` +1, nothing else |
| `redact` | `x <SECRET_1> y` | `findings` +1, `redacted` +1 |
| `block` | `[REDACTED:BLOCKED]` | `findings` +1, `blocked` +1 |

The counters are input-free numbers ([outcome counters](../packages/adapter/README.md#outcome-counters)).
A non-zero `findings` with `redacted` and `blocked` at zero is exactly the
`allow`/`warn` case.

### Failure and limits (logging and tracing)

The marker replaces the value that could not be released, and the record or span is
still written or forwarded. Nothing here falls back to the plaintext.

| Situation | Output | Counter |
| --- | --- | --- |
| `policy` throws, or returns something that is not an action | `[REDACTED:ERROR]` on each string that reached the policy (a string with no finding never does, and is unchanged) | `failed` |
| A getter or `toJSON()` throws | `[REDACTED:ERROR]` for that value | `failed` |
| A string longer than `maxStringLength` | `[REDACTED:LIMIT_EXCEEDED]`, not scanned | `limited` |
| Deeper than `maxDepth`, past `maxNodes` or `maxTotalLeaves` | `[REDACTED:LIMIT_EXCEEDED]` for the value past the bound | `limited` |
| Past `maxArrayLength` or `maxObjectKeys` | The extra elements or keys are **dropped**, never passed through | none |
| The per-operation budget is spent | Strings and array elements not yet inspected become `[REDACTED:LIMIT_EXCEEDED]`. The remaining **keys** of an object are dropped, with one `limited` count, not marked | `limited` |
| A self-referencing object | `[REDACTED:CYCLE]` for the repeated reference | `failed` |
| A pino line past a line ceiling | The fixed line `{"msg":"[REDACTED:LIMIT_EXCEEDED]"}` | `limited`, `lineReplaced` |
| A pino line the lexer cannot read | The fixed line `{"msg":"[REDACTED:ERROR]"}` | `failed` |

### Object keys (logging and tracing)

- A key is **never scanned and never rewritten**. A credential in a key reaches
  the output. Do not put a secret in a key.
- A key is *context* for the string directly under it. For `{ "api_key": "<value>" }`
  the value is detected because of the key, and then follows the table above:
  `redact` gives `<SECRET_1>`, `block` gives `[REDACTED:BLOCKED]`, `allow` and
  `warn` leave the value.
- If a finding spans the key itself (a credential used as the key), the value
  under it is replaced with `[REDACTED:BLOCKED]` and the key stays visible.

## Truth table: AI-context and MCP

Operations: `sanitizeText`, `sanitizeValue`, `sanitizeToolResult`, `buildContext`
and a stream from `openStream` (AI-context); `sanitizeToolResult`,
`sanitizeStreamedToolResult`, `wrapToolHandler` and `sanitizeResourceResult` (MCP).
Same input and policies as above. Every non-`ok` outcome is exactly a fixed shape.

| Action | Outcome | `value` | `findings` |
| --- | --- | --- | --- |
| `allow` | `ok` | The input, **unchanged**, credential included | One, with `action: "allow"` |
| `warn` | `ok` | The input, **unchanged**, credential included | One, with `action: "warn"` |
| `redact` | `ok` | The input with the span replaced: `x <SECRET_1> y` | One, with `action: "redact"` |
| `block` | `blocked`, `reason: "policy"` | **None** | **None** |

An `ok` with a non-empty `findings` and a value equal to the input is the
`allow`/`warn` case ([PII](./pii.md#activation-is-not-masking)).

### Failure, limits and cancellation (AI-context and MCP)

None of these has a `value` or `findings`, on any operation.

| Situation | Outcome |
| --- | --- |
| `policy` throws | `blocked`, `core_error`, `code: "POLICY_FAILURE"` |
| `policy` returns a non-action | `blocked`, `core_error`, `code: "INVALID_POLICY_ACTION"` |
| Core could not be loaded or initialized | `blocked`, `core_error`, `code: "INITIALIZATION_FAILED"` (`packages/adapter-ai-context/test/core-load-failure.test.ts`, `live-init-failure.test.ts`) |
| `wholeInputLimits` exceeded | `blocked`, `limit_exceeded`, `code: "INPUT_LIMIT_EXCEEDED"` or `"FINDING_LIMIT_EXCEEDED"` |
| `traversalLimits` or `operationLimits` exceeded | `blocked`, `limit_exceeded`, no code |
| `incrementalLimits` exceeded | the stream stops accepting; `finalize` is `blocked`, `limit_exceeded`, `code: "INPUT_LIMIT_EXCEEDED"` (or the core's other fixed code) |
| An unsupported value (a function, `undefined`, a `bigint`, a cycle) | `blocked`, `unsupported_value` |
| MCP: a shape outside the supported block types, or a base64 payload (default) | `blocked`, `unsupported_value` |
| A second `finalize`, or any call after the stream ended | `blocked`, `lifecycle` |
| The request's signal is aborted | `aborted` |
| MCP: the tool or the resource read throws | `tool_error` / `read_error`; the error is never read |

On the MCP wire, `toCallToolResult` turns every `blocked` into one fixed `isError`
result, a `tool_error` into another, and `aborted` into `null` (deliver nothing).
`toReadResourceResponse` gives `{ result }` or one of two fixed JSON-RPC errors.
None of them contains the content, the arguments, the URI or an error message.

### Streams

- Appended text is **staged**. Nothing is released until a successful `finalize`,
  and `finalize` releases once. A later `block` could not recall text already
  released, so none is.
- A `block` finding is reported at `finalize` as `blocked` / `policy`, with none of
  what was appended. It is decided when the core closes the detection window, so
  `accepting` can stay `true` for a while after a blocked secret was appended;
  read the outcome at `finalize`, not `accepting`, for the reason.
- `abort` discards what was staged; the next `finalize` is `aborted`, and any
  after that `blocked` / `lifecycle`.
- A secret split across chunks is found whole; `allow`, `warn` and `redact` give
  the same `ok` outputs as the whole-input table.

### Object keys (AI-context and MCP)

- Every key is scanned on its own. A finding that would be redacted or blocked in
  a key blocks the **whole value** as `blocked` / `policy`. A key is never rewritten.
- Under `warn` or `allow`, the key stays in the output as written. A key finding is
  reported to `onFinding` (with `rangeScope: "key"`) and is **not** in `ok.findings`.
  A caller that uses `warn` here must read `onFinding` to learn that a credential
  sits in a key.
- A key is context for its leaf: the leaf is redacted in place (`allow`/`warn`
  leave it, `block` blocks the value).

## Observation mode

"Observation mode" is not a separate setting. It is what a `policy` that returns
`warn` for everything, plus the observers every adapter already has, gives:

- The output is what the input was. In pino it is byte-for-byte the line pino
  would have written without the hooks.
- `onOutcome` (pino, spans, log records) and `findings` / `onFinding` (AI-context,
  MCP) report every finding, with the same fixed fields as always. No observer
  carries a value, and a throwing observer never changes an output.
- MCP's `onAudit` record is `{ stage, outcome }`. It says `ok` for a `warn` that
  left a credential in the result: it is deliberately input-free and cannot tell.
  A caller that must know reads `outcome.findings`.

Observation mode protects nothing. Run it to measure, not to ship.

## Caller responsibility, as configuration

```js
// Masks detected credentials; the core's built-in policy decides each action.
const boundary = await createAiContextBoundary();

// Reports every finding and changes nothing: the credential stays in `value`.
const observing = await createAiContextBoundary({
  policy: { evaluate: () => "warn" },
  onFinding: (finding, { boundary }, occurrence) => countFinding(finding.type, boundary),
});
const outcome = observing.sanitizeText(text);
if (outcome.outcome === "ok" && outcome.findings.length > 0) {
  // `value` still holds what was found. Redact it yourself, or do not send it.
}
```

`adapter`, `adapter-pino` and the OpenTelemetry factories take the same `policy`
option and report through `onOutcome`.

## The declarative overlay

> **Planned. Not available, and not claimed here.**

A declarative overlay over the core's action policy and a way to compare two
action policies are being designed in the core repository
([redact-secret/redact-secret#1216](https://github.com/redact-secret/redact-secret/issues/1216)).
Neither is in a released core, so nothing in this repository reads, passes or
depends on them, and the callback `policy` above remains the only policy surface
these packages support.

When a core release ships it, the adapters can pass the new option through to the
core unchanged, as they pass `policy` today. It would not change what a boundary
does with an action: the table on this page would stay the table, and each cell
would be driven by the overlay's action instead of the callback's. Support would
be a separate change that names the core release it needs and extends this
page's tests to run against it, as
[ARCHITECTURE.md § Versioning](../ARCHITECTURE.md#versioning) requires of any
range.

## How this is qualified

Real adapters, real core, exact outputs, one file per host package:

| Boundary | Test |
| --- | --- |
| Core reference, `createMaskSecrets` | `packages/adapter/test/action-semantics-live.test.ts` |
| pino (`createRedactingHooks`, real logger) | `packages/adapter-pino/test/action-semantics-live.test.ts` |
| OpenTelemetry spans (real tracer provider) | `packages/adapter-otel-trace/test/action-semantics-live.test.ts` |
| OpenTelemetry logs (real logger provider) | `packages/adapter-otel-logs/test/action-semantics-live.test.ts` |
| AI-context | `packages/adapter-ai-context/test/action-semantics-live.test.ts` |
| MCP | `packages/adapter-mcp/test/action-semantics-live.test.ts` |

The synthetic inputs and policies are shared in `fixtures/action-semantics.ts`.
Each non-`ok` case asserts the outcome has exactly its fixed keys and that no
serialization of it or of the wire result contains the credential.

## What this page does not cover

- **Python.** `logging` and OpenTelemetry follow the same markers (see the
  [README](../README.md#fail-closed-behavior)), but the truth table is not run
  against the Python package here.
- **Policies written for a custom `ruleset`, PII selections, or a
  `placeholderFormatter`.** The credential used here is a built-in detection;
  those change what is found or what a `redact` looks like, not what a boundary
  does with an action.
- **A destination or transport that adds text after the adapter,** and any
  placement outside the boundary. See each package guide.
