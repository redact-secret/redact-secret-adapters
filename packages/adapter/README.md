# @redact-secret/adapter

[![npm version](https://img.shields.io/npm/v/@redact-secret/adapter)](https://www.npmjs.com/package/@redact-secret/adapter)
[![npm downloads](https://img.shields.io/npm/dm/@redact-secret/adapter)](https://www.npmjs.com/package/@redact-secret/adapter)
[![Node.js](https://img.shields.io/node/v/@redact-secret/adapter)](https://www.npmjs.com/package/@redact-secret/adapter)
[![types included](https://img.shields.io/npm/types/@redact-secret/adapter)](https://www.npmjs.com/package/@redact-secret/adapter)
[![CI](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/redact-secret/redact-secret-adapters/badge)](https://scorecard.dev/viewer/?uri=github.com/redact-secret/redact-secret-adapters)
[![License: MIT](https://img.shields.io/npm/l/@redact-secret/adapter)](https://github.com/redact-secret/redact-secret-adapters/blob/main/LICENSE)

The shared base of the [Redact Secret](https://github.com/redact-secret/redact-secret)
adapters: mask one string, or walk any value and mask every string in it. On
every error path it writes a fixed marker instead of the original text.

**Do you need this package directly?**

- You use pino, OpenTelemetry, an AI context or MCP: no. Install
  [that adapter](https://github.com/redact-secret/redact-secret-adapters#which-package-do-i-need)
  and this one comes with it.
- Your tool hands you a value to mask (Langfuse and similar), or you are
  building your own integration: yes.

It contains no detection. The core does that.

## Install

```bash
npm install @redact-secret/core @redact-secret/adapter
```

Needs Node.js 22 or 24. ESM only. `@redact-secret/core` is a required peer:
the one copy your application installs.

## Quick start

### Masking callbacks (Langfuse and similar)

```js
import { createMaskSecrets } from "@redact-secret/adapter";

const maskSecrets = await createMaskSecrets();
const langfuse = new Langfuse({ mask: ({ data }) => maskSecrets(data) });
```

`createMaskSecrets` loads the core, awaits `initialize()`, and returns
`(data) => masked`. It is the one export that loads `@redact-secret/core` at
runtime.

```js
maskSecrets({ user: "ada", auth: "Bearer ghp_SYNTHETICREVOKED00000000000000000000" });
// { user: "ada", auth: "Bearer <SECRET_1>" }
```

## Injected API

Everything else takes the scanner as an argument, so you can pass the real core
or a fake in tests:

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
| `createMaskSecrets({ policy, limits })` | Live wrapper over the real core |
| `maskLeafWith(scan, text, { policy, maxStringLength })` | Mask one string |
| `maskSecretsWith(scan, data, { policy, limits })` | Walk a value tree and mask every string in it |
| `maskLogValueWith(scan, data, { policy, limits })` | The same walk, under its logging-side name |
| `walkStrict(value, { maxDepth, maxNodes }, { string, key })` | The all-or-nothing walk (see below) |
| `maskLeafOutcomeWith` / `countLeaf` / `createOutcomeCounter` / `toValueCounts` / `addCounts` / `notify` | The outcome counters (see below) |
| `activateCore(core, { pii })` / `activePiiActivation` / `readPiiActivation` / `CoreActivationError` | The core-activation step every live factory runs (see below) |
| `BLOCK_MARKER` / `ERROR_MARKER` / `LIMIT_MARKER` / `CYCLE_MARKER` / `DEFAULT_LIMITS` | The markers and limits (see below) |
| `ScanAndRedact` | The injected scanner's type |

### What the walk returns

A masked copy of everything JSON serialization would emit:

- plain objects and arrays, recursively;
- an `Error` as `{ type, message, stack, ...ownProps, cause }`, every string
  in it masked (an axios error's `config.headers` included);
- an object with a `toJSON()` method (`Date`, `URL`, `Buffer`, …) as its
  masked `toJSON()` result;
- any other object (class instances, `IncomingMessage`, …) as a plain object
  of its masked own enumerable properties.

Numbers, booleans, `null`, `undefined`, bigints and functions pass through. A
getter or `toJSON()` that throws becomes `[REDACTED:ERROR]` for that value. The
walk itself never throws.

## Fail-closed markers

Public API. They change only in a major version. For what to check and how to
correct each one, see
[troubleshooting](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/troubleshooting.md#logs-and-spans-markers).

| Marker | When |
| --- | --- |
| `BLOCK_MARKER` `[REDACTED:BLOCKED]` | A `block` finding. The **entire** leaf is replaced |
| `ERROR_MARKER` `[REDACTED:ERROR]` | Any throw or malformed result from the core, or a value that cannot be read. Never the input, never the error's message |
| `LIMIT_MARKER` `[REDACTED:LIMIT_EXCEEDED]` | A value past a walk budget. Never scanned, never passed through |
| `CYCLE_MARKER` `[REDACTED:CYCLE]` | A self-referencing object |

`DEFAULT_LIMITS`:

| Limit | Default |
| --- | --- |
| `maxDepth` | 8 |
| `maxArrayLength` | 1000 |
| `maxObjectKeys` | 200 |
| `maxStringLength` | 200000 |
| `maxTotalLeaves` | 5000 |
| `maxNodes` | 20000 |

Elements and keys beyond a limit are dropped, not passed through. An override
that is `undefined`, `NaN`, negative, or not a number falls back to the default.

`maxNodes` counts every value the walk visits: containers and leaves alike, but
not object keys. A value reached by more than one path counts once per path.
The walk does not track values it has already visited, so an object graph with
shared references (the same array held 1000 times at each of several levels) is
walked once per path, and without this budget its cost would grow
exponentially. Past `maxNodes`, every value, a number included, becomes
`[REDACTED:LIMIT_EXCEEDED]`.

**Object keys and attribute names are not scanned on their own.**
`maskSecretsWith` and `maskLogValueWith` mask values only. Every key, including
the own property names copied from an `Error` or a class instance, reaches the
host unchanged, so `{ [token]: 1 }` keeps `token` in the output. Do not put a
secret in a key. `walkStrict` differs: it hands every key to the caller's
visitor, and the AI-context boundary built on it does scan keys.

**A key is context for the string directly under it.** A credential whose
detection depends on its field name (`{ api_key: "..." }`) is only recognised
with that name in view, so a string leaf directly under an object key is
scanned alone and, if that redacts or blocks nothing, once more as
`{"<key>":"<leaf>"}` (key and leaf verbatim). The core alone decides whether
the pair is a secret; this package holds no key list. A finding inside the
leaf is mapped back to leaf offsets and applied. A redacting or blocking
finding anywhere else would have to rewrite the key, so the leaf becomes
`[REDACTED:BLOCKED]` and the key is kept. An array element, a message, an
`Error`'s `message`, `stack` and `cause`, and the root have no direct key and
are scanned alone. The cost is one more `scanAndRedact` call per keyed string
leaf; the `scanned` counter still counts leaves. The primitive is exported as
`scanLeafInKeyContext` and shared with the AI-context boundary.

## Core scan options

Consumers should not need a hand-written `scanAndRedact` wrapper to use behavior the core
supports. Besides `policy`, every logging and tracing entry point (and
`maskSecretsWith`, `maskLogValueWith`, `createMaskSecrets`) passes four more
core options through, unchanged, on every scan:

| Option | Core option | What it is |
| --- | --- | --- |
| `scanLimits` | `limits` | The core's whole-input limits, `{ maxInputBytes, maxFindings }`: the UTF-8 bytes of one scanned text and the findings of one scan. Named `scanLimits` because `limits` is this package's *walk* limits |
| `ruleset` | `ruleset` | A declarative detector ruleset, as text or UTF-8 bytes ([core guide](https://github.com/redact-secret/redact-secret/blob/main/docs/guides/rulesets.md)). Its detectors add detections; they never outrank a built-in's |
| `placeholderFormatter` | `placeholderFormatter` | The core's placeholder formatter, `(finding, { placeholderIndex }) => string` |
| `actionPolicy` | `actionPolicy` | The core's declarative action policy, as an object, UTF-8 JSON text or UTF-8 bytes. Needs core `0.1.0-beta.14` or later. See [Declarative `actionPolicy`](#declarative-actionpolicy) |

```js
const maskSecrets = await createMaskSecrets({
  ruleset: organizationRuleset,
  policy: { evaluate: () => "redact" },
  placeholderFormatter: (finding, { placeholderIndex }) => `[${finding.type}#${placeholderIndex}]`,
  scanLimits: { maxInputBytes: 1 << 20, maxFindings: 256 },
});
```

**Policy precedence.** There is exactly one policy and the adapter never combines
two. Your `policy` replaces the core's built-in policy for every finding,
including those a `ruleset` detector adds; omit it and the core's policy decides.
Under the core's default policy a ruleset detector's `Medium`-confidence finding
only *warns*, which leaves the text alone, so supply a `policy` that returns
`redact` (or `block`) for it. The adapter's own rules (a `block` finding replaces
the whole leaf; a `warn` leaves the text alone) apply on top of the action the
policy returned and never change it.

**An injected `scanConfig` replaces loose options; it never merges with them.**
A host that builds its configuration once can pass the `scanConfig` that
`resolveScanConfig` returned (to `maskSecretsWith`, `maskLeafWith`, `maskLogValueWith`,
or the `scanConfig` option of the pino, OpenTelemetry trace and logs factories).
It is already bound to its `policy`, `actionPolicy`, `scanLimits`, `ruleset` and
`placeholderFormatter`, so giving any of those beside it is a `TypeError` with a
fixed message (`scanConfig already fixes the scan options: ...`), raised before
the core is loaded or any text scanned: no option wins silently and none is
ignored. A `scanConfig` that `resolveScanConfig` did not build is rejected too.
The factories verify the injected configuration against the installed core, the
same way as loose options, and one resolved policy reaches every leaf and
key-context scan. `pii` is not part of a `scanConfig` (it is the core's process-wide
activation) and stays a separate option of the live factories. The AI-context and
MCP boundaries do not take a whole-input `scanConfig` and reject it by name.
This is the existing injection seam, not a core scanner handle: the published
core exports no configuration-bound or instance-isolated scanner (core
redact-secret/redact-secret#1222 deferred one), so two configurations in one
process still share the core's process-wide state, and there is no per-factory
scanner object to pass.

**Snapshot and validation.** The options are validated and snapshotted once, when
the masker, hook or processor is built (`resolveScanConfig`; per call for the
bare `maskSecretsWith`): `scanLimits` is copied (only the two fields are read) and
a binary `ruleset` is copied byte for byte, so mutating your object or buffer
afterwards changes nothing. A `policy` and a `placeholderFormatter` are callbacks,
held by reference. A malformed option is a `TypeError` with a fixed message that
never carries the value.

**They are the core's, and separate from this package's limits.** A leaf the core
refuses (`scanLimits`, an invalid ruleset, a callback that throws) is
`[REDACTED:ERROR]`, never the input and never the exception's message. The
traversal limits (`limits`), the aggregate budget (`operationLimits`) and the
host's own ceilings are separate and unchanged. A keyed leaf is also scanned in
its key-context view, so under a byte ceiling its usable size is `maxInputBytes`
minus the key and a few bytes of punctuation.

**Unsupported cores are rejected, not ignored.** The live factories check the
installed core's `VERSION` against `SCAN_OPTION_CORE_FLOORS` (`0.1.0-beta.6` for
`scanLimits`, `ruleset` and `placeholderFormatter`, the declared floor;
`0.1.0-beta.14` for `actionPolicy`) and probe the options with one
scan of the empty text, so an older core, or a ruleset or limits the core refuses,
is a `CoreOptionsError` at construction with a fixed message, a fixed `code`
(`CORE_OPTION_UNSUPPORTED` or `CORE_OPTION_REJECTED`), the option *names*, and, for
a rejection, one of the core's own codes (`INVALID_RULESET`, `INVALID_LIMITS`, ...) as
`coreCode`. It never carries an option value, a ruleset, a policy document or the
core's message. A core that omits every new option is untouched, so the floor keeps working.

**Operation modes.** All of this is whole-input except `actionPolicy` and
`placeholderFormatter`. The AI-context boundary's incremental sessions take those
two and their own
`incrementalLimits`, the core has no ruleset for an incremental session, and that
boundary therefore rejects `ruleset` and `scanLimits` by name rather than ignore
them (its whole-input limits are `wholeInputLimits`).

### Declarative `actionPolicy`

`actionPolicy` is the core's data-driven way to change what a few rules do and keep
the default for everything else: the first rule that matches a finalized finding
decides its action, a rule may say `"default"`, and a finding no rule matches keeps
the default action. The core parses, validates and evaluates it. This package
neither reads nor re-implements it, and adds no detector.

```js
const maskSecrets = await createMaskSecrets({
  actionPolicy: {
    actionPolicyRevision: 1,
    base: "default",
    rules: [{ id: "warn-jwt", match: { type: ["jwt"] }, action: "warn" }],
  },
});
```

- **Forms.** A plain object, the document as UTF-8 JSON text, or as UTF-8 bytes
  (`Uint8Array`). Anything else is a `TypeError` with a fixed message.
- **One policy.** `actionPolicy` and a callback `policy` are mutually exclusive.
  Both is a `TypeError` before the core is loaded or any text is scanned. Your
  callback `policy` behaves exactly as before.
- **Snapshot.** Taken once when the masker, hook, processor or boundary is built:
  an object is serialized once (`JSON.stringify`, as the core does for a call) and
  bytes are copied, so changing your object or buffer afterwards changes nothing.
  The same snapshot goes to every scan: every leaf, every key-context view, every
  pass of every hook, and, for the AI-context boundary, every session.
- **Where.** `createMaskSecrets`, `createRedactingHooks` / `LogMethod` /
  `StreamWrite` (pino), `createRedactingSpanProcessor` (trace),
  `createRedactingLogRecordProcessor` (logs), and `createAiContextBoundary` /
  `createMcpBoundary`, on whole-input scans. The AI-context and MCP boundaries
  also give it to every incremental session (`openStream`). `ruleset` and
  `scanLimits` stay whole-input only, and the sessions keep their own
  `incrementalLimits`.
- **Host enforcement is unchanged.** The policy only decides the action. At a
  logging or tracing adapter `block` replaces the whole value, `warn` and `allow`
  keep the text, and `redact` and the placeholder are the core's; at the AI-context
  and MCP boundaries `block` is the documented `blocked` / `policy` outcome. See
  [Action semantics](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/action-semantics.md).
  PII stays opt-in: an `actionPolicy` activates nothing.
- **Verified core floor: `0.1.0-beta.14`.** That is the first *published*
  `@redact-secret/core` whose `scanAndRedact` and `createIncrementalSanitizer`
  accept it (`redact-secret` `0.1.0b14` on PyPI); an older core would ignore the
  key and run its default policy, so the live factories reject it by name with
  `CoreOptionsError` (`CORE_OPTION_UNSUPPORTED`, `options: ["actionPolicy"]`)
  instead. Every other option, and the callback `policy`, still work on the
  declared `^0.1.0-beta.6` floor. A document the core refuses is
  `CORE_OPTION_REJECTED` with `coreCode: "INVALID_ACTION_POLICY"`, never the
  document or the core's message. The check is one scan of the empty text: it
  proves the option is accepted, not that a rule decides as you intend. Test your
  policy against your own synthetic inputs.

## Aggregate operation budget

`DEFAULT_LIMITS` bound one *walk* and `maxStringLength` one *string*. Neither
bounds a whole host operation: a span has many attributes, events and links, a
log record is masked by two pino hooks, and an AI context is built from many
parts. Many individually valid fields could multiply the total scanning and the
retained findings. An **operation** is the unit a host counts in (one log
record, one span, one `buildContext` or `sanitizeValue` call, one `maskSecrets`
call), and it owns one `OperationBudget` that every pass and field of it shares.

```js
maskSecretsWith(scanAndRedact, data, { operationLimits: { maxLeaves: 1000 } });
// or share one budget across passes you own:
const operation = createOperationBudget({ maxBytes: 1 << 20 });
```

`DEFAULT_OPERATION_LIMITS` (every key optional; an unusable override falls back
per key):

| Limit | Default | Counts | Unit |
| --- | --- | --- | --- |
| `maxBytes` | 16777216 (16 MiB) | the UTF-8 bytes of every text handed to `scanAndRedact`, key-context views included | actual calls |
| `maxScans` | 50000 | every `scanAndRedact` invocation, key-context views included | actual calls |
| `maxNodes` | 100000 | every value visited, containers and leaves | occurrences |
| `maxKeys` | 100000 | every object key or attribute name visited | occurrences |
| `maxLeaves` | 25000 | every string leaf handed to a scan | occurrences |
| `maxFindings` | 100000 | every finding the core reported, summed | occurrences |

**Occurrences versus actual calls.** *Occurrences* are counted where a value is
visited, however it is reached and whether or not its scan was memoized, so a
shared reference reached by two paths counts twice. *Actual calls* are counted
where work is done, so a memoized repeat costs no scan and no bytes. Bytes are
UTF-8, not code units: a Korean character is 3, an emoji 4, a lone surrogate 3.
No existing counter changes meaning: `scanned` still counts leaves, and the
per-walk limits still apply to every pass. This budget is the **sum** over the
operation, and whichever bound is reached first wins.

**Exhaustion is sticky and deterministic.** The first charge that does not fit
marks the budget exhausted and every later charge fails, so nothing after the
overrun is scanned or passed on; a failed charge spends nothing. The same input
and limits always stop at the same place. What happens next belongs to the host:

- logging and tracing replace what was not inspected with
  `[REDACTED:LIMIT_EXCEEDED]` (counted as `limited`) and keep going, dropping
  object keys past the bound as `maxObjectKeys` does; a pino line refused whole
  becomes the fixed `{"msg":"[REDACTED:LIMIT_EXCEEDED]"}` line;
- the AI-context and MCP boundaries return `blocked` / `limit_exceeded` with no
  value and no findings, never a partly approved one.

**It is a work counter, not a wall-clock timeout.** It is checked between
scans, synchronously. One `scanAndRedact` call, once started, runs to its own
completion under the core's whole-input limits, and a host callback (a policy,
a getter, a `toJSON()`) that never returns is not interrupted. Use your own
timeout, or the AI-context boundary's `AbortSignal`, for cancellation.

## Outcome counters

The host adapters report what happened to a log record or a span through one
shared, **input-free** contract. This package holds it; the host packages hand
it to your callback (`onOutcome` in `adapter-pino` and `adapter-otel-trace`).
Nothing here creates a logger, an exporter or a network client. You increment
your own metrics.

A counter is six non-negative integers and nothing else. There is no field for
a value, a masked value, a field path, a key, an offset, a detector id or an
error message, so there is nothing to accidentally forward.

| Count | Means |
| --- | --- |
| `scanned` | Leaves handed to the core. A leaf a bound refused before the core saw it is not one of these |
| `findings` | Findings the core reported, summed. **Not** distinct credentials: one credential in five leaves is five findings |
| `redacted` | Leaves whose text the core changed. Lower than `findings` when an action leaves text alone (a `warn`) |
| `blocked` | Leaves replaced whole by `BLOCK_MARKER` |
| `limited` | Values replaced by `LIMIT_MARKER`: past a walk budget or over `maxStringLength`. Never scanned |
| `failed` | Values replaced by `ERROR_MARKER`, plus the `CYCLE_MARKER` case |

Pass `{ counter }` in `MaskOptions` to have the walk add to one. The walk only
ever increments, so a host adapter that masks a unit in more than one pass
(pino scans a record's arguments *and* its finished line) keeps one accurate
total per unit rather than double counting. `maskLeafWith` and the walkers
return exactly what they always did.

A host's own delivery outcome is a separate, named field on that host's outcome
type, because only that adapter knows it: `adapter-pino`'s `lineReplaced`,
`adapter-otel-trace`'s `dropped`. **None of them means "delivered" or
"exported"**. No adapter here learns whether a destination, a handler or an
exporter succeeded, and none of them claims to.

## The all-or-nothing walk

`walkStrict` is the walker for hosts where a partially scanned value is not a
safe value, such as a model context (`@redact-secret/adapter-ai-context`). It
scans nothing itself: every string and every own enumerable object key goes to
the caller's visitor, which returns `{ ok: true, text }` (or `{ ok: true }` for
a key, which is never rewritten) or `{ ok: false, failure }` to end the walk.
The result is a fresh copy, or the first failure. No marker is ever
substituted.

| Failure | When |
| --- | --- |
| `limit_exceeded` | More than `maxDepth` nested containers (the root counts as 1), or more than `maxNodes` visited values (keys are not counted) |
| `unsupported_value` | Anything but a string, finite number, boolean, `null`, array, or plain object (including `undefined`, an array hole, a `Date`, a class instance, an `Error`), a cycle, or a value whose read throws |
| the visitor's own | A visitor returned `{ ok: false, failure }` |

A shared, acyclic reference is copied as many times as it is reached. A visitor
that throws is a bug in the caller, and its exception propagates.

## Core activation and PII

`activateCore` is the one step every live factory in this repository runs
before it hands out a masker, and the one place the PII activation rule lives.

```js
const core = await import("@redact-secret/core");
await activateCore(core, { pii: ["pii:global"] }); // or activateCore(core) for no selection
```

PII detection in the core is opt-in, **process-wide and one-shot**: the first
selection wins, and a later *different* one fails with
`PII_ACTIVATION_CONFLICT`. An empty selection is a different selection, not a
neutral one.

| Called as | Behaviour |
| --- | --- |
| `activateCore(core)` | `initialize()`. A `PII_ACTIVATION_CONFLICT` counts as **success**, because it means the application already activated its own selection. Every other failure is rethrown unchanged |
| `activateCore(core, { pii })` | `initialize({ pii })`, then reads `piiActivation()` and **refuses** when the active identity does not reflect the request |

`piiActivation()` is optional on the core binding, so it is feature-detected. A
core without it keeps working when `pii` is omitted, and fails with
`PII_ACTIVATION_UNSUPPORTED` when `pii` is passed, rather than silently doing
nothing. Both refusals are a `CoreActivationError` with a fixed `code` and a
fixed `message`: no selector, no input, no field path, no core exception text.

`activePiiActivation()` returns the identity the last successful activation
observed, or `undefined`. It is deliberately **not** a counter field. The
selection is one-shot, so the identity is one process-wide fact read on demand
rather than repeated per record or per span.

**Activation is not masking.** Under the core's default policy, `High`
confidence PII redacts, while `Medium` and `Low` resolve to `warn`, and a
`warn` finding leaves the text alone. Supply your own `policy` if you need
those masked. In the counters, a leaf with findings and no redaction is how
this shows up. More:
[PII guide](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/pii.md).

## Contributing

Issues and pull requests are welcome:
[CONTRIBUTING.md](https://github.com/redact-secret/redact-secret-adapters/blob/main/CONTRIBUTING.md).
Changes are listed in this package's `CHANGELOG.md`.

## License

MIT
