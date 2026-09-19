# Architecture

This repository holds host integrations for
[Redact Secret](https://github.com/redact-secret/redact-secret). It contains no
detection logic, no policy, and no redaction algorithm. Everything here is
wiring, and the value of the wiring is that it is subtle enough to get wrong.

## The layering

Every adapter, in both languages, is the same four layers. Read them top to
bottom; the top two are host-specific, the bottom two are shared.

```text
  L3  host seam          pino hooks.logMethod · SpanProcessor.onEnd · logging.Filter.filter
       |                 structural (duck-typed) match against the host's extension point
       |                 no runtime import of the host package
  L2  value-tree walker  recursive descent over dicts / lists / strings
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

This is the strongest guard in the repository. If the core renames an action or
reshapes a result, these packages fail to compile — they do not keep running
while quietly letting a `block`-worthy secret through as an inline placeholder.

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
answer reaches the host.

- A `block` finding replaces the **whole leaf** with `[REDACTED:BLOCKED]`. The
  core already substitutes `block` findings in place like `redact` ones, but an
  inline placeholder still leaves the rest of the string visible, which is not
  what a host asked for when it declared a value block-worthy.
- Any throw becomes `[REDACTED:ERROR]`. Not the original text, and not the
  error's own message — an error message can carry the input.
- A value past a budget becomes `[REDACTED:LIMIT_EXCEEDED]` and is never sent to
  the core. Elements and keys past `maxArrayLength` / `maxObjectKeys` are
  dropped, never passed through unmasked.
- A cycle becomes `[REDACTED:CYCLE]`.

The markers and `DEFAULT_LIMITS` are public API. They move only in a major
version.

## Adapter-specific notes

### pino

`hooks.logMethod` is the only pino extension point that sees the raw call.
`formatters.log(obj)` never receives `msg` at all — pino serializes the message
key separately from the merged object — and it runs before `serializers[key]`,
so it can reach a plain string field but never the message and never a
serialized `err.message`.

Two transformations run before anything is scanned:

1. **A leading `Error` is normalized** to `[{ err }, err.message, ...rest]`.
   pino infers `msg` from `err.message` only when the first argument is
   `instanceof Error`; replacing that argument with a masked plain object would
   silently drop the `msg` field from the output.
2. **A string message and its interpolation values are joined** into the exact
   string pino would format, *before* redaction. pino formats `msg` after the
   hook returns, so scanning the format string and its arguments separately
   misses a secret split across them — neither half matches on its own.

Redaction then runs over one value tree and the redacted arguments are passed on
with `method.apply`, so every later pino stage — serializers, formatters, the
host's own path-based `redact` — runs unchanged over text pino can no longer see
in the clear.

### OpenTelemetry

The processor wraps any object shaped like a `SpanProcessor` and redacts every
string and string-array attribute on the span and its events in `onEnd` before
delegating.

One runtime assumption is load-bearing: `ReadableSpan.attributes` is typed
`readonly` but is a plain mutable object at runtime. If an SDK version freezes
it, this adapter becomes a silent no-op — which is exactly the failure mode the
fail-closed rules exist to prevent. The test suite asserts mutation actually
took effect on a real span, at both ends of the declared SDK range. That
assertion is not optional.

### Python `logging`

The filter walks the record's `msg`, `args` and any exception info through the
same L2/L1 layers, so a secret in a format string, in an interpolation argument,
or in an exception message is redacted before any handler formats the record.

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
