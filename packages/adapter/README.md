# @redact-secret/adapter

The shared base for [Redact Secret](https://github.com/redact-secret/redact-secret)
host adapters: mask one string, or walk a value tree and mask every string in
it, failing closed on every error path.

It contains no detection. The scanner is **injected**: this package has no
dependencies of its own, and `@redact-secret/core` is a peer dependency — the
one copy your application installs and initializes. Its type declarations
import the core's types, so the peer is required, not optional.

Install it directly only when building your own integration;
`@redact-secret/adapter-pino` pulls it in automatically.

```bash
npm install @redact-secret/core @redact-secret/adapter
```

## Masking callbacks (Langfuse and similar)

```js
import { createMaskSecrets } from "@redact-secret/adapter";

const maskSecrets = await createMaskSecrets();
const langfuse = new Langfuse({ mask: ({ data }) => maskSecrets(data) });
```

`createMaskSecrets` is the one export that loads `@redact-secret/core` at
runtime. It imports the core on call, awaits `initialize()`, and returns
`(data) => masked`.

## Injected API

```js
import { initialize, scanAndRedact } from "@redact-secret/core";
import { maskLeafWith, maskSecretsWith, maskLogValueWith } from "@redact-secret/adapter";

await initialize();
maskLeafWith(scanAndRedact, "one string");
maskSecretsWith(scanAndRedact, { any: ["plain", "tree"] });
maskLogValueWith(scanAndRedact, { err: new Error("also walks Errors") });
```

| Export | Purpose |
| --- | --- |
| `maskLeafWith(scan, text, { policy, maxStringLength })` | Mask one string |
| `maskSecretsWith(scan, data, { policy, limits })` | Walk a value tree and mask every string in it (see below) |
| `maskLogValueWith(scan, data, { policy, limits })` | The same walk, under its logging-side name |
| `createMaskSecrets({ policy, limits })` | Live wrapper over the real core |
| `walkStrict(value, { maxDepth, maxNodes }, { string, key })` | The all-or-nothing walk (see below; since `0.1.1`) |
| `maskLeafOutcomeWith(scan, text, opts)` / `countLeaf` / `createOutcomeCounter` / `toValueCounts` / `addCounts` / `notify` | The outcome contract (see below; since `0.1.3`) |
| `activateCore(core, { pii })` / `activePiiActivation` / `readPiiActivation` / `CoreActivationError` | The core-activation step every live factory runs (see below; **Unreleased**) |
| `ScanAndRedact` | The injected scanner's type |

The walk returns a masked copy of everything JSON serialization would emit:

- plain objects and arrays, recursively;
- an `Error` as `{ type, message, stack, ...ownProps, cause }`, every string
  in it masked (an axios error's `config.headers` included);
- an object with a `toJSON()` method (`Date`, `URL`, `Buffer`, …) as its
  masked `toJSON()` result;
- any other object (class instances, `IncomingMessage`, …) as a plain object
  of its masked own enumerable properties.

Numbers, booleans, `null`, `undefined`, bigints and functions pass through. A
getter or `toJSON()` that throws becomes `[REDACTED:ERROR]` for that value; the
walk itself never throws.

## The all-or-nothing walk

Since `0.1.1`, `walkStrict` is the walker for hosts where a partially
scanned value is not a safe value, such as a model context
(`@redact-secret/adapter-ai-context`). It scans nothing itself: every string
and every own enumerable object key goes to the caller's visitor, which
returns `{ ok: true, text }` (or `{ ok: true }` for a key, which is never
rewritten) or `{ ok: false, failure }` to end the walk. The result is a fresh
copy, or the first failure; no marker is ever substituted.

| Failure | When |
| --- | --- |
| `limit_exceeded` | More than `maxDepth` nested containers (the root counts as 1), or more than `maxNodes` visited values (keys are not counted) |
| `unsupported_value` | Anything but a string, finite number, boolean, `null`, array, or plain object — including `undefined`, an array hole, a `Date`, a class instance, an `Error` — a cycle, or a value whose read throws |
| the visitor's own | A visitor returned `{ ok: false, failure }` |

A shared, acyclic reference is copied as many times as it is reached. A
visitor that throws is a bug in the caller, and its exception propagates.

## Core activation and PII

**Unreleased.** `activateCore` is the one step every live factory in this
repository runs before it hands out a masker, and the one place the PII
activation rule lives.

```js
const core = await import("@redact-secret/core");
await activateCore(core, { pii: ["pii:global"] }); // or activateCore(core) for no selection
```

PII detection in the core is opt-in, **process-wide and one-shot**: the first
selection wins, and a later *different* one fails with
`PII_ACTIVATION_CONFLICT`. An empty selection is a different selection, not a
neutral one. So three rules, and nothing here decides policy:

| Called as | Behaviour |
| --- | --- |
| `activateCore(core)` | `initialize()`, exactly as before — but a `PII_ACTIVATION_CONFLICT` counts as **success**, because it means the application already activated its own selection. Every other failure is rethrown unchanged |
| `activateCore(core, { pii })` | `initialize({ pii })`, so the adapter-first order works and the selection is explicit |
| `activateCore(core, { pii })` | then reads `piiActivation()` and **refuses** when the active identity does not reflect the request |

`piiActivation()` is optional on the core binding, so it is feature-detected. A
core without it keeps working when `pii` is omitted — the declared
`@redact-secret/core` range does not move for this — and fails with
`PII_ACTIVATION_UNSUPPORTED` when `pii` is passed, rather than silently doing
nothing. Both refusals are a `CoreActivationError` with a fixed `code` and a
fixed `message`: no selector, no input, no field path, no core exception text.

`activePiiActivation()` returns the identity the last successful activation
observed, or `undefined`. It is deliberately **not** a counter field — a
counter is six non-negative integers and nothing else — and the selection is
one-shot, so the identity is one process-wide fact read on demand rather than
repeated per record or per span.

**Activation is not masking.** Under the core's default policy, PII types are
confidence-gated rather than always redacted: `High` redacts, `Medium` and
`Low` resolve to `warn`, and a `warn` finding leaves the text alone (see the
markers below). Lower-confidence PII therefore still reaches a destination as
plaintext. Supply your own `policy` mapping those findings to `redact` if you
need them masked; nothing here synthesizes one. The counters make it
observable — see the next section.

## Outcome counters

Since `0.1.3`, the host adapters report what happened to a log record or a span
through one shared, **input-free** contract. This package holds it; the host
packages hand it to your callback (`adapter-pino`'s `onOutcome`,
`adapter-otel`'s `onOutcome`). Nothing here creates a logger, an exporter or a
network client — you increment your own metrics.

A counter is six non-negative integers and nothing else. There is no field for
a value, a masked value, a field path, a key, an offset, a detector id or an
error message, so there is nothing to accidentally forward.

| Count | Means |
| --- | --- |
| `scanned` | Leaves handed to the core. A leaf a bound refused before the core saw it is not one of these |
| `findings` | Findings the core reported, summed. **Not** distinct credentials: one credential in five leaves is five findings |
| `redacted` | Leaves whose text the core changed. Lower than `findings` when an action leaves text alone (a `warn`) — a leaf with findings and no redaction is how the PII `warn` gap above shows up |
| `blocked` | Leaves replaced whole by `BLOCK_MARKER` |
| `limited` | Values replaced by `LIMIT_MARKER` — past a walk budget or over `maxStringLength`. Never scanned |
| `failed` | Values replaced by `ERROR_MARKER`, plus the `CYCLE_MARKER` case |

Pass `{ counter }` in `MaskOptions` to have the walk add to one; the walk only
ever increments, so a host adapter that masks a unit in more than one pass
(pino scans a record's arguments *and* its finished line) keeps one accurate
total per unit rather than double counting. `maskLeafWith` and the walkers
return exactly what they always did.

A host's own delivery outcome is a separate, named field on that host's outcome
type, because only that adapter knows it: `adapter-pino`'s `lineReplaced`,
`adapter-otel`'s `dropped`. **None of them means "delivered" or "exported"** —
no adapter here learns whether a destination, a handler or an exporter
succeeded, and none of them claims to.

## Fail-closed markers

Public API; they change only in a major version.

| Marker | When |
| --- | --- |
| `BLOCK_MARKER` `[REDACTED:BLOCKED]` | A `block` finding — the **entire** leaf is replaced |
| `ERROR_MARKER` `[REDACTED:ERROR]` | Any throw or malformed result from the core, or a value that cannot be read. Never the input, never the error's message |
| `LIMIT_MARKER` `[REDACTED:LIMIT_EXCEEDED]` | A value past a walk budget; never scanned, never passed through |
| `CYCLE_MARKER` `[REDACTED:CYCLE]` | A self-referencing object |

`DEFAULT_LIMITS`: `maxDepth` 8, `maxArrayLength` 1000, `maxObjectKeys` 200,
`maxStringLength` 200000, `maxTotalLeaves` 5000, `maxNodes` 20000. Elements and
keys beyond a limit are dropped, not passed through.

`maxNodes` counts every value the walk visits: containers and leaves alike,
but not object keys, the same rule as `walkStrict`'s `maxNodes`. A value
reached by more than one path counts once per path. The walk does not track
values it has already visited, so an object graph with shared references (the
same array held 1000 times at each of several levels) is walked once per path,
and without this budget its cost would grow exponentially. Past `maxNodes`,
every value, a number included, becomes `[REDACTED:LIMIT_EXCEEDED]`. An
override that is `undefined`, `NaN`, negative, or not a number falls back to
the default, as for every other limit.

## License

MIT
