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
   misses a secret split across them — neither half matches on its own.

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

### OpenTelemetry

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

### Python `logging`

The filter formats `msg` with `args` (`record.getMessage()`) and masks the
result as one L1 leaf, so a secret split across the format string and an
argument is still seen whole; the arguments are then cleared. An exception is
masked as its formatted traceback, also one L1 leaf, and cached `exc_text` and
`stack_info` likewise. Only the `extra_fields` a caller names go through the L2
walker.

A `logging.Filter` runs only where it is attached. On a handler, it redacts the
record before that handler formats it, and since the record is mutated in
place, before any handler that runs afterwards; a handler without the filter
that runs earlier sees plaintext. On a logger, it runs for records logged on
that logger before any handler, but not for records propagated from child
loggers. Attach it to every emitting handler.

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
  `peerDependency` range against its host.
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

## Deliberate exclusions

- **Stream adapters** (Node `Transform`, Web `TransformStream`) belong to
  `@redact-secret/core` and stay there. The word "adapter" in this repository
  means an external host integration; the core repository additionally uses
  "host adapter" for the CLI and the language bindings. Three distinct meanings,
  one word — do not consolidate them by moving code.
- **MCP and model-context wiring** need the core's incremental sanitizer: a
  stateful, much wider surface than the four-item contract above, and not
  protected by a version range. It remains an example in the core repository
  until that surface is itself a published contract.
- **LangChain**, and any other framework integration whose host contract has not
  been read and tested here.
- **A Langfuse package.** Masking-callback hosts need the shared walker and one
  line of user code; a package would add a release surface and change nothing.

## Repository layout

```text
packages/
  adapter/              @redact-secret/adapter          shared L1 + L2, TypeScript
  adapter-pino/         @redact-secret/adapter-pino     L3 + live wrapper
  adapter-otel/         @redact-secret/adapter-otel     L3 + live wrapper
python/
  redact_secret_adapters/                               shared + logging + otel extra
fixtures/                                               cross-language contract, shared
```
