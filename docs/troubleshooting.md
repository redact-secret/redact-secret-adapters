# Troubleshooting fail-closed outcomes

When an adapter cannot protect a value, it does not guess and it does not fall
back to the original. It writes a fixed marker, or returns an outcome with no
value. This page maps each one to what it means, what to check, and the smallest
safe correction. The corrections below that matter are reproduced against released
packages by [`examples/troubleshooting`](../examples/troubleshooting), which CI runs.

Find your symptom:

- [Logs and spans: markers](#logs-and-spans-markers)
- [AI context and MCP: outcomes](#ai-context-and-mcp-outcomes)
- [Limits: which one did I hit?](#limits-which-one-did-i-hit)
- [Streams](#streams)
- [Initialization and activation](#initialization-and-activation)
- [Messages you can show](#messages-you-can-show)
- [What not to do](#what-not-to-do)
- [Reading a finding's range](#reading-a-findings-range)

## What is released

Every behavior in this guide is in the versions on the registry on 2026-10-07
(`adapter` 0.1.10, `adapter-pino` 0.1.7, `adapter-otel-trace` 0.1.5,
`adapter-ai-context` 0.1.6, `adapter-mcp` 0.1.7, `redact-secret-adapters` 0.1.6).
A newer limit or provenance feature may be missing from an older version, so check
the `CHANGELOG.md` of the package you run before relying on one.

## Logs and spans: markers

Markers are public API and change only in a major version. They appear in log
lines, span fields and the output of a masking callback.

| You see | Meaning | Check | Minimal correction | Guide |
| --- | --- | --- | --- | --- |
| `<SECRET_1>` | Working as intended: the core found a secret and replaced that part | Nothing to fix. A different number only reflects order in that value | none | [root README](../README.md#fail-closed-behavior) |
| `[REDACTED:BLOCKED]` | A finding resolved to `block`: the **whole** value is replaced, not just the match. Also used when a secret is identified only through a neighboring key, which cannot be rewritten without changing the shape | Is the value supposed to hold that content at all? Which field is it? | Stop putting the value in the log, or move it to a field that is never logged. Do not weaken the policy to make the marker go away | [fail-closed markers](../packages/adapter#fail-closed-markers) |
| `[REDACTED:ERROR]` | The scan failed, or the value could not be read: a core error, a malformed core result, a getter or `toJSON()` that threw, a Python object the walker does not walk. Never the input, never the error's message | Is the core installed and loadable? Is the value a plain string, number, list, dict or exception? Does a getter throw? The counters' `failed` is non-zero | Log plain data (convert the object to a dict or string yourself). If the core is not loading, fix the install and see [initialization](#initialization-and-activation) | [fail-closed markers](../packages/adapter#fail-closed-markers) · [Python](../python#fail-closed-markers) |
| `[REDACTED:LIMIT_EXCEEDED]` | A value was past a size limit and was **not scanned and not passed through**. See [which limit](#limits-which-one-did-i-hit) | Is the value a whole payload, a large array, or a deep structure? Counters: `limited` is non-zero | Log a bounded summary (an identifier, a length, a count) instead of the value. Raise a limit only to a bound you can justify | [limits](../packages/adapter#fail-closed-markers) |
| `[REDACTED:CYCLE]` | A self-referencing object | Does an object hold a reference back to itself, such as a parent link? | Log the fields you need instead of the object | [fail-closed markers](../packages/adapter#fail-closed-markers) |
| `{"msg":"[REDACTED:ERROR]"}` as a whole pino line | The finished line was not one valid JSON value (an unterminated object or string, text outside a string, trailing text, plain text), or a key literal was not valid JSON. The line is refused, never forwarded, and counted as `failed`. Exported as `PINO_ERROR_LINE` | Did a custom `streamWrite` (it runs first and sees pino's line unmasked) change the line into something that is not JSON? | Remove what produces a non-JSON line, or put it after the redacting hooks | [adapter-pino](../packages/adapter-pino#readme) |
| `{"msg":"[REDACTED:LIMIT_EXCEEDED]"}` as a whole pino line | The line is past a pre-processing ceiling or the record's aggregate budget was already spent. Exported as `PINO_LIMIT_LINE`. The counter `limited` rises, not `failed` | Is a single line megabytes long, or made of very many string values? | Log less per record | [adapter-pino](../packages/adapter-pino#readme) |
| A span is missing from the exporter | The redacting processor could not write a masked value back (for example, an earlier processor froze the attributes), so the span is dropped. A one-time warning `REDACT_SECRET_SPAN_DROPPED` names the field, never its value | Does a processor ahead of this one freeze attributes? | Register the redacting processor so that nothing freezes the span first | [adapter-otel-trace](../packages/adapter-otel-trace#a-span-that-cannot-be-redacted-is-dropped) |
| The text is unchanged but the counters show a finding | The finding's action is `warn`, which leaves text alone | Compare `findings` with `redacted` | Supply your own core `policy` if that finding must be masked; see [credentials, PII and policy](./pii.md#see-the-difference) | [counters](../packages/adapter#outcome-counters) |

JSON conversion is deliberate on the JavaScript side: the walker serializes an
object the way `JSON.stringify` would before scanning it, so what is scanned is what
would be written. The Python walker does not serialize; any object that is not a
string, number, boolean, `None`, `dict`, `list`, `tuple` or exception becomes
`[REDACTED:ERROR]`. In both, object keys and attribute names are never rewritten, so
do not put a secret in one.

To check that a handler, logger or processor is actually covered, use a
[placement recipe](../examples#run-one) rather than reading the output of a single
call.

## AI context and MCP outcomes

Every operation ends in one of three shapes, and only `ok.value` may be used:

```text
{ outcome: "ok",      value, findings }
{ outcome: "blocked", reason, code? }
{ outcome: "aborted" }
```

`reason` and `code` are fixed labels and are safe to log. A `blocked` or `aborted`
outcome has no value, no excerpt and no count derived from the input. **Never treat a
`blocked` outcome as `ok`.** `adapter-mcp` adds `tool_error` and delivers a fixed
result for every non-`ok` outcome, see
[MCP outcomes](../packages/adapter-mcp#outcomes-and-fixed-results).

| Outcome | Meaning | Check | Minimal correction | Reproduced in |
| --- | --- | --- | --- | --- |
| `blocked` / `policy` | A finding resolved to `block`, or an object **key** has a `redact`/`block` finding (a key cannot be rewritten without changing the shape) | Which part of the input carried it? Is the key itself a secret? | Do not send that content to the model. Rename or remove the key. Do not change the policy to let it through | n/a: depends on content |
| `blocked` / `unsupported_value` | The value is not JSON-shaped: `undefined`, `NaN`, a `Date`, a `Map`, a class instance, an `Error`, an array hole, a throwing getter, binary or encoded content, or a cycle | Find the value; `typeof` and `instanceof` tell you | Convert it yourself so what is scanned is exactly what you send: `date.toISOString()`, `Object.fromEntries(map)`, omit `undefined` fields, `{ name: error.name }` for an error you may share. The boundary will not convert for you | [example](../examples/troubleshooting#unsupported-value) |
| `blocked` / `limit_exceeded` with a `code` | The core's whole-input or incremental bound: `INPUT_LIMIT_EXCEEDED`, `FINDING_LIMIT_EXCEEDED`, `BUFFER_LIMIT_EXCEEDED`, `TOKEN_LIMIT_EXCEEDED`, `MULTILINE_LIMIT_EXCEEDED` | Compare the input's UTF-8 size with `wholeInputLimits`/`incrementalLimits` | Send less. If the default is truly too small, replace the **complete** set, starting from `AI_CONTEXT_DEFAULT_LIMITS` | [example](../examples/troubleshooting#a-limit-is-exceeded) |
| `blocked` / `limit_exceeded`, no `code` | The adapter's own bound: `traversalLimits` (`maxDepth`, `maxNodes`), or the aggregate `operationLimits` | Is the value deeper than 16 levels or larger than 4,096 nodes (the defaults)? | Flatten or trim the value. Raise `traversalLimits` as a complete set only to a bound you can justify | [Limits](../packages/adapter-ai-context#limits) |
| `blocked` / `lifecycle` | A stream was misused: a second `finalize`, or another invalid-state call | Is one stream shared by two consumers, or reused after `finalize`? | Open a new stream for each text | [example](../examples/troubleshooting#streams-are-single-use) |
| `blocked` / `core_error` + `INVALID_OPTIONS` or `INVALID_LIMITS` | A limit set is partial or inconsistent. A set you pass is used exactly as given and is not merged with the defaults | Does the set have every key? | Start from the exported defaults and change one field | [example](../examples/troubleshooting#a-partial-limit-set) |
| `blocked` / `core_error` + `UNPAIRED_SURROGATE` | The text holds a lone UTF-16 surrogate, which the core refuses to read | Where did the text come from (a truncated string, a broken decode)? | Call `text.toWellFormed()` first. The replacement character is what is scanned and sent | [example](../examples/troubleshooting#a-lone-surrogate) |
| `blocked` / `core_error` + `NOT_INITIALIZED` or `INITIALIZATION_FAILED` | The core was not loaded or initialized | Is `@redact-secret/core` installed, and on a supported platform? | Fix the install, then create the boundary again. See [initialization](#initialization-and-activation) | [initialization](#initialization-and-activation) |
| `blocked` / `core_error` + `POLICY_FAILURE` or `PLACEHOLDER_FAILURE` | Your `policy` or `placeholderFormatter` threw | Does the callback throw for some finding type? | Make the callback total. Callbacks are trusted code | [Lifecycle rules](../packages/adapter-ai-context#lifecycle-rules) |
| `blocked` / `core_error`, no `code` | A failure the core did not label, or a thrown value that is not the core's own. The message is never read or forwarded | Check your own logs around the call | Treat it as a failure, not as `ok`. Do not retry in a tight loop | [example](../examples/troubleshooting#the-core-throws) |
| `aborted` | The `AbortSignal` fired, or a stream was `abort()`ed before a successful `finalize` | Did the caller cancel, or did a timeout fire? | Treat it as cancellation: send nothing, and do not report it as a security failure | [example](../examples/troubleshooting#cancellation) |
| `tool_error` (MCP) | The tool, a client rejection or an `McpError` threw. The error is never read | Look at the tool or client, not at the redaction layer | Fix the tool call. Never log the raw `McpError`: its message can quote the result | [adapter-mcp](../packages/adapter-mcp#outcomes-and-fixed-results) |

An outcome, reason or code this page does not list gets generic, safe guidance: it
is `blocked`, there is no value, the reason is a fixed label you may log, and the
request should be refused. The message helper in
[Messages you can show](#messages-you-can-show) does exactly that.

## Limits: which one did I hit?

Four different things are called limits. They bound different work, in different
units, at different times, and are set in different options. A bigger number in the
wrong one changes nothing.

| Kind | Bounds | Unit | Over the limit | Option |
| --- | --- | --- | --- | --- |
| **Core whole-input** | one `scanAndRedact` call: input size and findings | UTF-8 bytes; finding count | AI context: `blocked` / `limit_exceeded` + `code`. Logging and tracing: that leaf is `[REDACTED:ERROR]` (a core failure) | `wholeInputLimits` (AI context, MCP), `scanLimits` (logging and tracing) |
| **Core incremental** | one streamed session: total input, buffered text, a token, a multiline span | the core documents all four as UTF-8 byte ceilings despite their `...CodeUnits` names | `blocked` / `limit_exceeded` + `code`; the stream stops accepting | `incrementalLimits` |
| **Adapter traversal** | the walk over a value tree: depth, array length, keys, string length, leaves, nodes | counts of values; `maxStringLength` in UTF-16 code units | the value, or the rest of it, is `[REDACTED:LIMIT_EXCEEDED]` (logging, tracing), or `blocked` / `limit_exceeded` with no code (AI context) | `limits` (logging, tracing, `mask`), `traversalLimits` (AI context) |
| **Aggregate operation budget** | everything one log record, span or context does together: scanned bytes, scans, nodes, keys, leaves, findings, summed | UTF-8 bytes for `maxBytes`; **calls** for bytes and scans; **occurrences** for nodes, keys, leaves and findings | the remainder is `[REDACTED:LIMIT_EXCEEDED]` (logging, tracing) or the whole operation is `blocked` / `limit_exceeded`; once spent it stays spent | `operationLimits` |
| **pino line ceilings** | lexing and decoding the finished line before the walker runs | UTF-16 code units | the whole line becomes `{"msg":"[REDACTED:LIMIT_EXCEEDED]"}` | `lineLimits` |

Things that decide which one you hit:

- **Scope.** The core limits are per call; traversal limits are per walk; the
  aggregate budget is per record, span or context and counts every pass over it (the
  two pino hooks each scan a record, so a record near an old per-walk bound is likelier
  to meet the budget). A value that passes each per-walk check can still exhaust the
  aggregate.
- **Replace the whole set, where the option takes a set.** AI-context and MCP limit
  sets are used exactly as given. A partial `wholeInputLimits` is `core_error` /
  `INVALID_OPTIONS` on first use, not "the defaults plus my change". Spread the
  exported defaults. The walker's `limits` (logging, tracing, masking callbacks) falls
  back per key instead, and an unusable value falls back to that key's default.
- **The aggregate budget is a work counter, not a timeout.** It is checked between
  scans; it does not interrupt a callback that never returns. Use an `AbortSignal` or
  your own timeout for that.
- **Elements and keys beyond a limit are dropped, never passed through.**

Do not respond to a limit by removing it. There is no "unbounded" setting to reach for,
and a large bound only moves the failure to memory and time. Send or log a smaller,
more useful value.

## Streams

Staged streams (`openStream`) exist so a `block` found late can still stop the whole
text:

- **Nothing is released before `finalize`.** Text the core emits during `append` is
  held back, because it could not be recalled after a later `block`.
- **Read `stream.accepting` after every `append`.** Once it is `false`, the stream
  has failed (a `block`, a limit, a lifecycle or core failure), has been aborted, or has
  been finalized. Stop pulling from the producer and close it: later chunks are
  discarded unscanned. It never says why. The reason arrives at `finalize`.
- **A stream is single use.** The first `finalize` returns the outcome; the next is
  `blocked` / `lifecycle`. An `append` after `finalize` is discarded.
- **`abort()` before a successful `finalize`** ends as `aborted` with nothing released.

Reproduced end to end in [`examples/troubleshooting`](../examples/troubleshooting#a-stream-that-fails): the
stream there reads two of three chunks, sees `accepting` turn `false`, and gets
`blocked` / `limit_exceeded` from `finalize`.

## Initialization and activation

| Symptom | Meaning | Correction |
| --- | --- | --- |
| Every AI-context operation is `blocked` / `core_error` + `INITIALIZATION_FAILED` or `NOT_INITIALIZED` | The boundary resolved, but the core could not load or initialize. It fails closed on each call instead of throwing at startup | Fix the core install (`@redact-secret/core`, a supported Node and platform), then call the factory again |
| A logging or tracing factory rejects at construction with `PII_ACTIVATION_NOT_ACTIVE` or `PII_ACTIVATION_UNSUPPORTED` | The `pii` selection you asked for is not the one active, or the installed core is too old to report an activation. Needs core `0.1.0-beta.10` or later | Activate the same selection first, or upgrade the core. See [PII](./pii.md#the-rules) |
| `PII_ACTIVATION_CONFLICT` (`PiiActivationConflictError` in Python) | A different selection was already activated. The first one wins, process-wide | Use one selection per process. See [PII](./pii.md#the-rules) |
| `CoreOptionsError` with `CORE_OPTION_UNSUPPORTED` or `CORE_OPTION_REJECTED` | The core does not support a scan option (`actionPolicy` needs core `0.1.0-beta.14` or later), or refused a `ruleset`, limits or `actionPolicy` you passed (`coreCode` `INVALID_RULESET`, `INVALID_LIMITS`, `INVALID_ACTION_POLICY`). The option names are given, never a value | Upgrade the core, or fix the option. A ruleset's or policy document's text never appears in the error |
| `TypeError`: `policy and actionPolicy are mutually exclusive` | A callback `policy` and a declarative `actionPolicy` were both given. One policy decides | Pass one. The check runs before the core is loaded or any text is scanned |
| Python records are fine but PII is never redacted | PII was activated after a handler already emitted. There is no error and no counter that tells it apart from "nothing found" | Call `redact_secret.initialize(pii=[...])` before attaching handlers. See [PII](./pii.md#python) |
| Python `CoreActivationError` with `PII_ACTIVATION_NOT_ACTIVE`, `PII_ACTIVATION_UNAVAILABLE` or `PII_ACTIVATION_UNSUPPORTED` | A factory given `pii=` could not show that it took effect | Same as the JavaScript rows |

No error carries a selector, an input, a ruleset, a policy document or the core's own message.

## Messages you can show

Keep two audiences apart. The application-facing message is for your logs and metrics
and may name the outcome. The user-facing message is generic, because the reason is
a signal about your policy and limits. Both come from fixed strings; nothing from the
input, the error, a key or a path is ever interpolated.

<!-- snippet: examples/troubleshooting/messages.mjs#messages -->
```js
// Fixed labels only. Nothing from the input, the error, a path or a key ever reaches these strings,
// and an outcome this table does not know falls back to the generic entry.
const FIXED = {
  ok: ["Sanitized value available.", ""],
  "blocked/policy": ["Blocked by redaction policy.", "We could not process this request."],
  "blocked/limit_exceeded": ["Input is over a configured limit.", "This request is too large to process safely."],
  "blocked/unsupported_value": ["Input held a value that is not JSON-shaped.", "We could not process this request."],
  "blocked/lifecycle": ["A stream was reused or misused.", "Something went wrong. Please try again."],
  "blocked/core_error": [
    "The redaction core failed, is not initialized, or rejected an option.",
    "Something went wrong. Please try again.",
  ],
  aborted: ["The operation was cancelled.", "The request was cancelled."],
};
const GENERIC = ["Unrecognised outcome; treated as blocked.", "We could not process this request."];

/** `internal` is for your logs and metrics (a trusted reader). `user` is safe to show to anyone. */
export function describeOutcome(outcome) {
  const key = outcome.outcome === "blocked" ? `blocked/${outcome.reason}` : outcome.outcome;
  const [internal, user] = Object.hasOwn(FIXED, key) ? FIXED[key] : GENERIC;
  // `code` is a fixed label from the core's registry, but only an allowlisted shape is forwarded.
  const code = typeof outcome.code === "string" && /^[A-Z_]{1,40}$/.test(outcome.code) ? ` (${outcome.code})` : "";
  return { internal: `${internal}${code}`, user };
}
```

Run with the rest of the example, this is the helper the unknown-reason case exercises:
an outcome that is not in the table is treated as blocked, and a `code` that is not an
uppercase label is dropped.

## What not to do

- Do not disable detection or "fall back to the original" when a marker appears.
- Do not treat a `blocked` or `aborted` outcome as `ok`, or reuse the input you passed.
- Do not set a limit to infinity or to a very large number to make a marker go away.
- Do not lower a policy action (`block` to `warn`) to get a value through.
- Do not log, return or report an exception's message, an `McpError`, a key, a field path or the input
  when something fails. The labels `outcome`, `reason` and `code` are what is safe.
- Do not catch the failure and retry with the raw input.
- Do not read a clean result as proof: detection is the core's and is not complete.

## Reading a finding's range

A finding's `start` and `end` are UTF-16 code-unit offsets, and they index into
whatever was scanned. In AI context that is not always the whole text:

- For `sanitizeText` they index the text.
- For a value tree they index **one string leaf**, even when a key-context scan found the
  match: the offsets were mapped back to the leaf.
- For a stream they are absolute offsets into the stream's logical text across chunks.

`findingOccurrences(outcome)` returns one entry per finding, in the
same order as `ok.findings`, with `partIndex`, `rangeScope` (`"text"`, `"leaf"`, `"stream"`,
or `"key"` for telemetry only), `rangeUnit` (`"utf16-code-units"`) and a zero-based
`leafOrdinal` or `keyOrdinal`. It contains no key, path, value or score. A `finding.id` is
unique per scan only, so do not use it, or the ordinals, as an identifier of a secret.
Details: [AI-context occurrences](../packages/adapter-ai-context#where-a-finding-came-from-occurrences).
