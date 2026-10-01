# Architecture

This repository holds host integrations for
[Redact Secret](https://github.com/redact-secret/redact-secret). It contains no
detection logic, no policy, and no redaction algorithm. Everything here is
wiring between a host's extension point and the core.

## The layering

Every adapter, in both languages, is the same four layers. Read them top to
bottom; the top two are host-specific, the bottom two are shared.

```text
  L3  host seam          pino hooks.logMethod + hooks.streamWrite · SpanProcessor.onEnd · logging.Filter.filter
       |                 · the AI-context boundary's operations (no host: the caller is the seam)
       |                 · the MCP boundary's operations and structural tool-handler wrappers
       |                 structural (duck-typed) match against the host's extension point
       |                 no runtime import of the host package
  L2  value-tree walker  recursive descent over everything JSON would emit:
       |                 objects, arrays, Errors, toJSON() results, strings
       |                 owns the depth, width and total-leaf budgets
  L1  mask-leaf          mask ONE string; fail closed on every error path
       |                 owns the four markers and DEFAULT_LIMITS
  L0  core (injected)    scanAndRedact is a parameter, never an import
```

The boundary that matters is between L1 and L0. Nothing in L1–L3 imports the
core at runtime: the scanner arrives as an argument. A thin *live wrapper* per
adapter is the only module that imports `@redact-secret/core` /
`redact_secret`, and its whole job is to resolve initialization order and inject
the real scanner.

That split is what makes these packages testable without a built native addon,
and what keeps the host SDKs out of the runtime dependency graph.

## The core contract

An adapter depends on exactly four things. This list is the compatibility
surface the declared version ranges protect, and it is deliberately not allowed
to grow.

1. `initialize(): Promise<void>` — JavaScript only. Python's extension loads on
   import.
2. `scanAndRedact(text, options?) -> { text, findings }`
3. `finding.action`, specifically whether it is `block` or `warn`
4. `findings` is an array

In TypeScript these are imported as types from the core itself:

```ts
import type {
  SecretAction,          // "redact" | "block" | "warn" | "allow"
  SecretFinding,
  ScanResult,
  ScanAndRedactOptions,
} from "@redact-secret/core";

export type ScanAndRedact = (text: string, options?: ScanAndRedactOptions) => ScanResult;
```

If the core renames an action or reshapes a result, these packages fail to
compile instead of running on while letting a `block`-worthy secret through as
an inline placeholder.

The list is about what an adapter *reads from a result*, and it does not grow.
What an adapter may *pass in* is the options the core's own `scanAndRedact`
documents, and only when the caller asked (#175): `policy` always, and
`scanLimits` (the core's `limits`), `ruleset` and `placeholderFormatter` when
given, validated and snapshotted once by `resolveScanConfig`
(`packages/adapter/src/scan-options.ts`; Python: `scan_options.py`). Asking for
one adds the only other read of the core, its `VERSION`, in the live factories,
which check it against `SCAN_OPTION_CORE_FLOORS` and probe the options with one
scan of the empty text, so an older core or a rejected ruleset is a fixed,
input-free `CoreOptionsError` at construction rather than an option the core
silently ignores. With none of them asked, nothing is read and nothing extra is
passed, so the declared floor keeps working. They are whole-input options: the
core has no ruleset for an incremental session, so `adapter-ai-context` rejects
`ruleset` and `scanLimits` by name instead of claiming them. One policy decides:
the caller's `policy` replaces the core's built-in policy, ruleset findings
included, and is never combined with another.

**The one exception: `@redact-secret/adapter-ai-context`.** The core's
[AI-context boundary contract](https://github.com/redact-secret/redact-secret/blob/main/docs/reference/ai-context-boundary.md)
(redact-secret/redact-secret#610) deliberately widens the surface for that
package alone, and only by documented core APIs: the whole-input `policy` /
`limits` options, `createIncrementalSanitizer` with `append` / `finalize` /
`abort`, `SecretScanError.code` (read, and forwarded only when it is in the
core's fixed registry), and the eight safe finding fields. The contract, not
a version range alone, protects that surface: the package replays the core's
conformance fixture, vendored byte-for-byte at a pinned 40-hex core commit
(`fixtures/core/pins.json`), through its public API on the real core at both
range endpoints. `test/dependency-surface.test.ts` fails if the built package
reads any other core member. The logging and tracing adapters keep the
four-item surface above.

`@redact-secret/adapter-mcp` reads no core member at all. It reaches the core
only through `adapter-ai-context`'s boundary (`sanitizeValue`,
`sanitizeText`, `openStream`), and its `test/dependency-surface.test.ts`
fails if its built output imports anything else.

Because a typecheck only covers the core version that is installed, CI
typechecks at **both ends of every declared range**, host packages included.

## Host types

Host types are imported with `import type` and never with a value import. Type
imports are erased at compile time, so a host package appears in
`peerDependencies` and `devDependencies` but never in the runtime graph. The
runtime code stays structural: an object is a `SpanProcessor` because it has
`onEnd`, not because it came from a particular package.

## Fail-closed rules

L1 is small on purpose. It performs no detection; it decides how the core's
answer reaches the host. The four markers, when each fires, and
`DEFAULT_LIMITS` are listed once, in
[README.md § Fail-closed behavior](./README.md#fail-closed-behavior); they are
public API and move only in a major version. The reasons behind them:

- `block` replaces the **whole leaf**. The core already substitutes `block`
  findings in place like `redact` ones, but an inline placeholder still leaves
  the rest of the string visible, which is not what a host asked for when it
  declared a value block-worthy.
- An error produces a fixed marker, never the error's own message: an error
  message can carry the input.
- A value past a budget is never sent to the core, and elements or keys past a
  width limit are dropped rather than passed through unmasked.
- Values are masked; **object keys and attribute names are not scanned on their
  own** by the logging and tracing adapters (`walkValue`, the Python walker,
  pino's `streamWrite`, and both span processors). A key is kept as it is so
  the value keeps its shape. A key is, however, *context* for the string
  directly under it (#172): detection of a credential such as `api_key` depends
  on the field name, so the shared key-context primitive
  (`packages/adapter/src/key-context.ts`, `python/.../key_context.py`) scans
  such a leaf alone and, when that redacts or blocks nothing, once more as
  `{"<key>":"<leaf>"}` and maps the answer back to leaf offsets. The core
  decides detection and policy; no adapter holds a key list. The primitive was
  extracted from the AI-context boundary, where it keeps its all-or-nothing
  mapping (a finding that would rewrite the key blocks the value); the marker
  adapters map the same case to a block marker on the leaf. The AI-context
  boundary additionally scans every key on its own (`walkStrict` hands each key
  to its visitor).
- **Per-walk and per-string bounds do not bound a whole host operation**
  (#173). A span has many fields, a log record is masked by two pino hooks, and
  an AI context is built from many parts, each its own walk. One operation owns
  one `OperationBudget` (`packages/adapter/src/budget.ts`,
  `python/.../budget.py`), shared by every pass and field of it: both pino
  stages and the child-binding and `mixin()` values on the final line, every
  field of one span or `filter()` call, and every part of `buildContext`. It
  counts UTF-8 bytes and scanner invocations as *actual calls* and nodes,
  object keys, leaves and findings as *occurrences*, so a memoized repeat costs
  no scan but still costs a visit; key-context scans and object keys count
  explicitly. Exhaustion is sticky: the marker adapters mark the rest
  `[REDACTED:LIMIT_EXCEEDED]`, the AI-context and MCP boundaries return
  `blocked` / `limit_exceeded` with nothing partly approved. It is a work counter
  checked between scans, not a wall-clock interrupt. The per-walk `maxNodes`
  and `maxTotalLeaves` keep their meaning; this is their sum over the operation.
- Every visit counts against `maxNodes`, not only string leaves. The walk
  tracks only the current path, which is enough to detect a cycle, so a shared
  reference is walked once per path. Budgeting leaves alone would let an
  in-process graph of shared containers cost exponential time.

## Adapter-specific notes

### pino

`hooks.logMethod` is the only pino extension point that sees the raw call.
`formatters.log(obj)` never receives `msg` at all — pino serializes the message
key separately from the merged object — and it runs before `serializers[key]`,
so it can reach a plain string field but never the message and never a
serialized `err.message`.

Two things keep pino's own call-shape handling intact:

1. **A leading `Error` stays a leading `Error`.** pino wraps a first argument
   that is `instanceof Error` under `errorKey`, and takes `msg` from its
   `message` only when the caller passed no message. The hook therefore hands
   pino a masked copy that keeps the original error's prototype, rather than a
   plain object or a rewritten argument list: `logger.error(err, "custom")`
   keeps `"custom"`, `logger.error(err)` gets the masked `err.message`, and
   `err.type` still names the error's class.
2. **A string message and its interpolation values are joined** into the exact
   string pino would format, *before* redaction. pino formats `msg` after the
   hook returns, so scanning the format string and its arguments separately
   misses a secret split across them — neither half matches on its own. The
   message is found where pino looks for it (after a first argument that is an
   object, `null` or `undefined`). A logger's `msgPrefix` is prepended by pino
   after the hook too, so it is scanned together with the message and stripped
   again; if a redaction reaches into the prefix, the whole masked text is kept
   and pino prints the static prefix before it.

Redaction then runs over one value tree and the redacted arguments are passed on
with `method.apply`, so every later pino stage — serializers, formatters, the
host's own path-based `redact` — runs unchanged over text pino can no longer see
in the clear.

`hooks.logMethod` cannot see two inputs that end up in the line: child-logger
bindings, which pino serializes once when `child()` or `setBindings()` runs, and
`mixin()` output, merged after the hook returns. `formatters.bindings` is no
fix — pino replaces it with an identity function for every child created
without its own `formatters` option. The sound hook is `hooks.streamWrite`,
which receives the finished JSON line. `createRedactingStreamWrite` masks every
string value in it in place (keys and every other byte are kept), and fails
closed to a fixed `{"msg":"[REDACTED:ERROR]"}` line if the line cannot be
lexed. It is a second scan of each line, so it is a separate hook the host
installs next to `logMethod` rather than a replacement: `logMethod` still keeps
raw values away from the host's own serializers, formatters and `mixin()`.

Because the pair is what covers the boundary and either hook alone leaves a
plaintext path, `createRedactingHooks` returns both, shaped as pino's `hooks`
option, so the complete setup is one call rather than two the host has to know
to pair. The single-hook factories stay exported: they are the escape hatch for
a host that knowingly has no bindings, `mixin()` or `base` and wants one scan
per line, and the migration path from `0.1.0`/`0.1.1`.

A host that already passes its own `hooks` hands them to the factory, which
composes rather than replaces them. One rule decides the order, in both hooks:
**redaction runs last, closest to the bytes.** The host's `logMethod` runs
first and is handed a `method` that redacts and then calls pino's real one, so
arguments the host's hook adds or rewrites are scanned, and a host hook that
never calls `method` still drops the record. The host's `streamWrite` runs
first on pino's own line and the redacting hook masks what it returns — pino
requires a `streamWrite` hook to return valid JSON, which is what the line
lexer is specified against — so fields the host's hook adds are scanned too. A
throwing or non-string host `streamWrite` falls back to redacting pino's own
line rather than letting it through. Keys other than these two are forwarded
to pino unchanged: a future pino hook is neither dropped nor claimed as
covered. What is still outside the boundary, and documented as such, is a
destination or transport that adds text after `streamWrite`, and any hook the
host wraps *around* the composed pair by hand. That ordering has one
consequence worth naming: a host `streamWrite` receives pino's line
**unmasked**, bindings and `mixin()` output included, so a hook that tees or
copies the line elsewhere is handling plaintext even though what reaches the
destination is masked.

`streamWrite` has to lex the finished line into string values and `JSON.parse`
each before the walker can bound anything, so it carries its own
**pre-processing ceilings** (#174, `PinoLineLimits`): the longest line, the most
value literals, and the most raw code units decoded, all in UTF-16 code units and
all checked before anything proportional to the line is allocated (the line
length first and unread, the span and decode counts as each span is found,
before any literal is decoded). A line past one is the fixed
`{"msg":"[REDACTED:LIMIT_EXCEEDED]"}` line with the original's newline and is
reported as one `limited` value with `lineReplaced: true`; a line that cannot be
lexed stays `{"msg":"[REDACTED:ERROR]"}` and `failed`. Neither forwards the
original, and the hook reads only the finished string, never a host
serialization hook. These ceilings are deliberately separate from the aggregate
budget above (which bounds the *scanning* of the values) and from the core's
whole-input limits (which bound one scan): this one bounds the work that happens
*before* the walker.

Reporting an outcome per record (#45) rides on the same seam. The two hooks
share a stack of in-flight records and the counter handed to the walkers is
resolved per masking call, because this path is re-entrant in three different
ways: `mixin()` and a serializer can log *after* masking, and a getter or
`toJSON()` on the merging object can log *during* the walk. A single shared
counter would give a nested record the outer record's partial numbers. The
masking is unaffected either way; only the attribution was, which is why it
took a test that logs from a getter to catch it.

### OpenTelemetry

`@redact-secret/adapter-otel-trace` is a **trace** integration: a
`SpanProcessor`, which sees spans and nothing else. OpenTelemetry Logs
(`LogRecord`s through `@opentelemetry/sdk-logs` or a log bridge) and metrics
never reach it. The package was published as `@redact-secret/adapter-otel`
up to `0.1.2`; that name is now a compatibility package that re-exports
`adapter-otel-trace` unchanged and marks every export `@deprecated`, so
existing imports keep working. `adapter-otel-logs` is reserved for a Logs
integration once a `LogRecordProcessor` boundary has been designed and
qualified against a real SDK; nothing implements it yet. The choice and its
release consequences are recorded in
[docs/decisions/2026-09-30-name-the-otel-trace-adapter-for-what-it-covers.md](docs/decisions/2026-09-30-name-the-otel-trace-adapter-for-what-it-covers.md).

The processor wraps any object shaped like a `SpanProcessor` and, in `onEnd`
before delegating, redacts every free-text field an exporter sends: the span
name, string and string-array attributes (keeping `null` holes in place), each
event's name and attributes, the status message, and each link's attributes.

One runtime assumption is load-bearing: `ReadableSpan`'s fields are typed
`readonly` but are plain writable objects at runtime, so the masked values are
written back in place. Every write is read back. If one does not take — a
frozen bag, a setter that ignores the write — the span is dropped with a
one-time process warning naming the field, never its value, rather than
exported unredacted or thrown out of `span.end()`. A status is replaced, not
mutated, since the object may be the caller's own. The real-host test asserts
the writes take effect on a real span at both ends of the declared SDK range,
and that a span frozen by an earlier processor is dropped without a throw.

The Python SDK offers no mutable view at all: `ReadableSpan.name`, `.status`,
`.attributes`, `.events` and `.links` are read-only, so
`redact_secret_adapters.otel` writes the private fields behind them (`_name`,
`_status`, `_attributes`, each event's `_name`/`_attributes`, each link's
`_attributes`). Event and link attributes are always an immutable
`BoundedAttributes`; span attributes are marked immutable in `Span.end()`
from 1.43 on, but still mutable in `on_end` on 1.16.0. Writes therefore go
through `BoundedAttributes`' backing `_dict`, the same bypass
`BoundedAttributes.__deepcopy__` uses, which works either way. Because the
fields are private, every write is read back through the public accessor; a
missing field or a write that does not show through drops the span with a
one-time `RuntimeWarning` rather than exporting it unredacted. The real-host
test checks all of this at both ends of the Python SDK's declared range.

### AI context

`adapter-ai-context` has no host SDK: its L3 is its own five operations
(`sanitizeText`, `sanitizeValue`, `sanitizeToolResult`, `buildContext`,
`openStream`), which the application calls where its framework builds a
context or receives a tool result. Its rules differ from the marker-based
adapters on purpose, because a model context, unlike a log line, is not safe
when partly masked:

- **All or nothing.** A `block` finding, a limit, an unsupported value, or a
  core failure fails the *whole* operation to a fixed `blocked` outcome with
  no value, never a marker in place. Nested values use L2's `walkStrict`,
  not `walkValue`, which returns the first failure instead of a masked copy.
  Object keys are scanned too, and a key finding that would be redacted blocks
  the value.
- **Staged streams.** An incremental session's output is held until a
  successful `finalize`, which releases it once; a later `block` could not
  recall text already released.
- **Fixed outcomes.** `ok` / `blocked` / `aborted`, with the contract's five
  reasons. Findings cross as allowlisted copies; error messages are never
  read.
- **Occurrence provenance** (#177). A finding's `start`/`end` index into one
  scanned string, never a whole document, and the core numbers findings per scan,
  so a flattened `ok.findings` repeats ids. Each finding therefore has an
  *occurrence*: `partIndex`, `rangeScope` (`text`, `leaf`, `stream`, and `key` for
  telemetry only), `rangeUnit` (UTF-16 code units) and a leaf or key ordinal that
  advances per visit, so a memoized repeat or a shared reference still has its own.
  It is additive and non-sensitive (ordinals and fixed labels only), reaches
  `onFinding` as a third argument and `findingOccurrences(outcome)` as an array
  aligned with `ok.findings`, and is kept *beside* the outcome (a `WeakMap`)
  rather than on it, because the outcome's JSON shape is the core's contract and
  the vendored fixture replays it byte for byte.

The live factory never rejects for an initialization failure: the boundary
it returns fails every operation closed with the core's mapped error, so an
application that skips its own error handling still cannot fall back to
sending raw input.

It is JavaScript only. No Python AI-context adapter exists yet; one would
replay the same vendored fixture (the core already runs its Python twin of
the runner against every wheel), and `walkStrict` would get a Python twin
with it.

### MCP

`adapter-mcp` implements the core's MCP boundary contract
(redact-secret/redact-secret#612) as a thin specialization of
`adapter-ai-context`. It contains no scan, walk, policy, or core-error
mapping: a whole `CallToolResult` is one `sanitizeValue`, a streamed result
is one `openStream`, and the key-context backstop is one `sanitizeText` per
serialized part. Key-identified leaves are redacted in place by the key-aware
`sanitizeValue` (redact-secret/redact-secret#842), so the backstop blocks only
on context a leaf pass cannot see (a sibling or parent key). What it adds is MCP shape only:

- **Block types.** The five types of protocol revisions 2025-06-18 and
  2025-11-25. Any other type, and any malformed shape, blocks as
  `unsupported_value`, so a later revision fails closed.
- **Binary payloads** are removed from the scan view and either block (the
  default) or are put back unscanned at their original key position.
- **Stopping a stream.** After every chunk it reads the stream's
  `accepting` flag. On `false` it pulls no more and closes the producer
  without waiting: `return()`, and `destroy()` when the source has one,
  because a Node.js `Readable`'s async iterator queues `return()` behind a
  pending `next()`.
- **Fixed results.** Every non-`ok` outcome becomes a fixed `isError` result
  and never a JSON-RPC error. The server wrappers catch a handler's throw
  before the SDK can turn `error.message` into result text.

The host seam is structural for both SDK lines, which differ in shape: a
handler's signal is `extra.signal` on 1.x and `ctx.mcpReq.signal` on 2.x,
and `client.callTool` takes `(params, schema, options)` on 1.x and
`(params, options)` on 2.x. The wrappers read either signal, and the host
passes its own `callTool` invocation to `sanitizeToolCall`, so no SDK is
imported. The tests import the SDKs for real: both lines, at both endpoints
of each declared range, over stdio and Streamable HTTP.

The core's MCP fixture is replayed by the core's own runner
(`fixtures/core/mcp-boundary.mjs`), vendored with the fixture, and not by a
port of it.

### Python `logging`

The filter formats `msg` with `args` (`record.getMessage()`) and masks the
result as one L1 leaf, so a secret split across the format string and an
argument is still seen whole; the arguments are then cleared. An exception is
masked as its formatted traceback, also one L1 leaf, and cached `exc_text` and
`stack_info` likewise. Only the `extra_fields` a caller names go through the L2
walker. Where the TypeScript walker serializes an object the way
`JSON.stringify` would, the Python walker has no single serialization to
mirror, so an object it does not walk (anything but a string, number, bool,
`None`, `dict`, `list`, `tuple` or exception) fails closed to
`[REDACTED:ERROR]` rather than reaching a `%(ctx)s` format or a `default=str`
JSON formatter unscanned.

A `logging.Filter` runs only where it is attached, which makes *placement* the
security decision in any application with more than one handler. On a handler,
it redacts the record before that handler formats it, and since the record is
mutated in place, before any handler that runs afterwards; a handler without
the filter that runs earlier sees plaintext. On a logger, it runs for records
logged on that logger before any handler, but not for records propagated from
child loggers — nor does a filter on an ancestor logger cover a child's own
handlers. For a `QueueHandler`/`QueueListener` pair the filter belongs on the
`QueueHandler`, which runs in the emitting thread, so only masked records cross
the queue; on the listener's sink it protects the final destination but not the
queue, and not wherever a `QueueHandler` subclass sends the record instead (a
socket, a `multiprocessing` queue). Attach it to every emitting handler.

Because none of that can be enforced from inside a filter, it is held by tests
instead: `python/tests/test_logging_placement.py` asserts each supported
placement and, as synthetic negative controls, that plaintext really does
escape each wrong one. The filter is idempotent, so two filtered handlers on
one record are safe, and a record with no finding is formatted exactly as it
would be without the filter.

## Cross-language contract

The JavaScript and Python implementations are separate code. They are kept
equivalent by **shared fixture files**: one JSON document of inputs and expected
outputs per adapter family, read by both languages' test suites, plus a
deterministic fake scanner in each language implementing the same rules so the
fixture means the same thing on both sides.

TypeScript protects the JavaScript side only. The fixtures are the only thing
holding the two languages together, so they are shared — one copy, read by both
— and never duplicated per package.

## Versioning

- Each package carries its own SemVer. Nothing here is released in lockstep with
  the core, or with the other packages in this repository.
- Each package declares a range against the core and, where it has one, a
  `peerDependency` range against its host. The core is a required
  `peerDependency` of every JavaScript package: a regular dependency could
  install a second copy of the native core next to the application's (with
  its own, separate `initialize()`), and an optional peer leaves the published
  type declarations, which import the core's types, unresolvable.
- A host range is only as wide as the tests that run against it. An untested
  version is not a supported version, however likely it is to work.
- Pre-1.0 while the core is pre-1.0: a 1.0 adapter that can only work against a
  beta core is a promise this project cannot keep.

## Security boundary

- The core stays side-effect free. An adapter may touch the host's logger or
  exporter; it performs no network, filesystem, environment or telemetry work of
  its own.
- No adapter logs, attaches, or re-exposes matched plaintext — including in its
  own error paths. This is why a core failure produces a fixed marker rather than
  the error's message.
- An adapter is never a second detector. It carries input in and the core's
  answer back out.
- Fixtures and tests use unmistakably synthetic values only. A real credential
  never enters this repository, in any file, including documentation.

## The vault boundary

`@redact-secret/vault` is an opt-in, in-memory capture published by the sibling
[`redact-secret-vault`](https://github.com/redact-secret/redact-secret-vault)
repository. It replaces a detected secret with a `<rsv_…>` token on the way to
a model and restores the original value into an application-designated field on
the way back. **This repository does not depend on it, and must not**: the core
and the adapters stay one-way. What is written down here is only how the two
sit next to each other.

| Owned here | Owned by the vault repository |
| --- | --- |
| Host integrations: pino, OpenTelemetry, Python `logging`, AI context, MCP | `capture()`, the token mapping, `restore()` |
| Fail-closed masking and the four markers | Reversibility, and every decision about who may reverse |

Three rules follow, and all three are tests
(`packages/*/test/vault-token.test.ts`, `python/tests/test_vault_token.py`,
from the shared `fixtures/vault-token-cases.json`):

- **Capture first, adapters after.** `capture()` and `createAiContextBoundary`
  occupy the same seam — the path to the model — so the order is fixed. What
  reaches an adapter is already tokenized text, and the adapter scans it as it
  would any other string.
- **A token passes through untouched.** No adapter here parses, rewrites or
  restores a `<rsv_…>` token. A rewrite would not leak anything; it would
  destroy a value the application still needs, and `restore()` would answer
  `RESTORE_DENIED` with nothing to point at. The core reports no finding on a
  token today, in a call argument, a `Bearer` header, an environment assignment
  or a JSON value under `api_key` — and the pinned tests are what keeps a
  widened detector from changing that silently.
- **A restored value never reaches an observability sink.** Restoration puts
  plaintext back; a log, a span or a model context is exactly where it must not
  go. The adapters have no restoration to misuse, which is the point of keeping
  it on the other side of the boundary.

Two paths are known **not** to preserve a token, and both are this
repository's documented fail-closed behavior rather than a bug: a leaf past
`maxStringLength` becomes `[REDACTED:LIMIT_EXCEEDED]`, and a core failure
becomes `[REDACTED:ERROR]`. Either replaces the whole leaf, tokens included,
with no error raised. They are asserted explicitly in both languages so a
reader meets them stated rather than as a value that can no longer be restored.

Separately, no default this repository ships may emit the literal `rsv_`: the
vault refuses any input that already contains one (`TOKEN_LITERAL_IN_INPUT`).
A custom `placeholderFormatter` is a supported option of `adapter-ai-context`,
so that is a test, not an assumption.

## Deliberate exclusions

- **Restoration.** Reversibility, token mapping and `restore()` belong to
  `@redact-secret/vault`; see [The vault boundary](#the-vault-boundary).
  No adapter here gains a dependency on it, or vault-aware behavior of its own.
- **Stream adapters** (Node `Transform`, Web `TransformStream`) belong to
  `@redact-secret/core` and stay there. The word "adapter" in this repository
  means an external host integration; the core repository additionally uses
  "host adapter" for the CLI and the language bindings. Three distinct meanings,
  one word — do not consolidate them by moving code.
- **MCP beyond `tools/call` and `resources/read`.** `adapter-mcp` covers
  tool arguments and results, which is the core's MCP boundary (#612), and
  `resources/read` results (redact-secret/redact-secret#843). Resource
  listings and templates, subscriptions and their notifications, prompts,
  sampling, elicitation, other notifications, other-language SDKs, HTTP+SSE,
  and `experimental.tasks` stay out until a contract covers them. Transport
  wiring stays with the host: the adapter acts on the parsed result.
- **Model-vendor wrappers** (OpenAI, Anthropic clients) and **model output
  scanning**: the AI-context boundary covers what goes into a context, and
  never patches a client.
- **LangChain**, and any other framework integration whose host contract has not
  been read and tested here.
- **OpenTelemetry Logs and metrics.** `adapter-otel-trace` is a span
  processor. A `LogRecordProcessor` needs its own design and real-SDK
  qualification; `adapter-otel-logs` is reserved for it, not implemented.
- **A Langfuse package.** Masking-callback hosts need the shared walker and one
  line of user code; a package would add a release surface and change nothing.

## Repository layout

```text
packages/
  adapter/              @redact-secret/adapter          shared L1 + L2, TypeScript
  adapter-pino/         @redact-secret/adapter-pino     L3 + live wrapper
  adapter-otel-trace/   @redact-secret/adapter-otel-trace  L3 + live wrapper, traces only
  adapter-otel/         @redact-secret/adapter-otel     deprecated name: re-exports adapter-otel-trace
  adapter-ai-context/   @redact-secret/adapter-ai-context  AI-context boundary + live wrapper
  adapter-mcp/          @redact-secret/adapter-mcp      MCP boundary over adapter-ai-context
python/
  redact_secret_adapters/                               shared + logging + otel extra
fixtures/                                               cross-language contract, shared
  core/                                                 core-owned contract files, vendored at a pinned core commit
site-feed/v1/                                           generated adapter release feed + its schema (RELEASING.md)
```
