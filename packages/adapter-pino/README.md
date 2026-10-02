# @redact-secret/adapter-pino

[![npm version](https://img.shields.io/npm/v/@redact-secret/adapter-pino)](https://www.npmjs.com/package/@redact-secret/adapter-pino)
[![npm downloads](https://img.shields.io/npm/dm/@redact-secret/adapter-pino)](https://www.npmjs.com/package/@redact-secret/adapter-pino)
[![pino peer range](https://img.shields.io/npm/dependency-version/@redact-secret/adapter-pino/peer/pino)](https://www.npmjs.com/package/@redact-secret/adapter-pino?activeTab=dependencies)
[![Node.js](https://img.shields.io/node/v/@redact-secret/adapter-pino)](https://www.npmjs.com/package/@redact-secret/adapter-pino)
[![types included](https://img.shields.io/npm/types/@redact-secret/adapter-pino)](https://www.npmjs.com/package/@redact-secret/adapter-pino)
[![CI](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/redact-secret/redact-secret-adapters/badge)](https://scorecard.dev/viewer/?uri=github.com/redact-secret/redact-secret-adapters)
[![License: MIT](https://img.shields.io/npm/l/@redact-secret/adapter-pino)](https://github.com/redact-secret/redact-secret-adapters/blob/main/LICENSE)

Keep secrets out of [pino](https://github.com/pinojs/pino) logs. Tokens, API
keys and passwords are replaced before a line reaches its destination,
wherever in the log call they appear.

Built on the [Redact Secret](https://github.com/redact-secret/redact-secret)
core, which does the detection.

## Install

```bash
npm install @redact-secret/core @redact-secret/adapter-pino pino
```

Needs Node.js 20, 22 or 24 and pino `^10.0.0`. ESM only.

## Quick start

Add one option to the logger you already have:

```js
const logger = pino({ hooks: await createRedactingHooks() });
```

A complete, runnable example:

<!-- smoke-test:example -->
```js
import pino from "pino";
import { createRedactingHooks } from "@redact-secret/adapter-pino";

// Synthetic, revoked-shaped values only — never a real credential.
const token = "ghp_SYNTHETICREVOKED00000000000000000000";

const logger = pino(
  {
    base: null,
    timestamp: false,
    hooks: await createRedactingHooks(), // both hooks: the complete boundary
    redact: ["req.headers.authorization"], // pino's own path-based redact still applies, on top
    mixin: () => ({ requestId: "req-42" }),
    serializers: { req: (req) => ({ auth: req.auth }) },
  },
  { write: (line) => void process.stdout.write(line) },
);

logger.child({ session: token }).info({ req: { auth: `Bearer ${token}` } }, "deploy with token %s", token);
// {"level":30,"session":"<SECRET_1>","requestId":"req-42","req":{"auth":"Bearer <SECRET_1>"},"msg":"deploy with token <SECRET_1>"}
```

CI runs this block verbatim from a clean install outside the repository
(`npm run smoke-test`), against the real core, and inspects the bytes that
reach the destination.

## How it differs from pino's `redact`

pino's own `redact` option censors by object *path*. It cannot see a token
inside a message string or an error message. This adapter redacts by *value*.
Use both: they work side by side.

## What is covered

| Covered | Not covered |
| --- | --- |
| The message, joined with its `%s` values before scanning, so a secret split across the format string and its arguments is still caught | Object **keys**, which are never scanned on their own or rewritten (a key is only context for the value under it). Do not put a secret in a key |
| Every string in a merging object, at any depth, including class instances and `toJSON()` values | Text a `destination` or transport adds after the line is written |
| An `Error` anywhere in the call, including a bare `logger.error(err)`: `message`, `stack` and own properties | A hook you wrap *around* the redacting hooks by hand |
| Child-logger bindings, `mixin()` output, serializer output, `base` | |

A clean-looking line is not proof the input held no secret: detection belongs
to the core and is not complete.

To check that **your** logger, child loggers and destination are covered, run the
[placement recipe](https://github.com/redact-secret/redact-secret-adapters/tree/main/examples/placement-js), which sends a synthetic token through a
real pino logger and includes unprotected paths as negative controls.

When something cannot be scanned, a fixed marker is written instead of the
text: `[REDACTED:BLOCKED]` for a `block` finding, `[REDACTED:ERROR]` for any
core failure. A line that cannot be parsed fails closed to
`{"msg":"[REDACTED:ERROR]"}` (exported as `PINO_ERROR_LINE`). What to check and how to correct each marker:
[troubleshooting](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/troubleshooting.md#logs-and-spans-markers).
All markers and
limits:
[`@redact-secret/adapter`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#fail-closed-markers).

## Options

```js
await createRedactingHooks({ hooks, pii, onOutcome, policy, limits, operationLimits, lineLimits, scanLimits, ruleset, placeholderFormatter });
```

| Option | What it does |
| --- | --- |
| `hooks` | Your own pino hooks, to compose with rather than replace. See below |
| `pii` | Turn on PII detection, e.g. `["pii:global"]`. See below |
| `onOutcome` | A callback with counts per log record, for your metrics. See below |
| `policy` | The core's policy, passed through unchanged. It replaces the core's built-in policy for every finding, a `ruleset` detector's included |
| `scanLimits` | The core's whole-input limits, `{ maxInputBytes, maxFindings }`, for every scan of both hooks. See [Core scan options](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#core-scan-options) |
| `ruleset` | A declarative detector ruleset (text or bytes), whole-input scans |
| `placeholderFormatter` | The core's placeholder formatter |
| `limits` | Override the walk limits (`DEFAULT_LIMITS` in `@redact-secret/adapter`) |
| `operationLimits` | Override the aggregate budget of **one log record**, shared by both hooks. See below |
| `lineLimits` | Override the pre-processing ceilings `streamWrite` applies to the finished line. See below |

### One budget per record

`logMethod` and `streamWrite` both mask the same record, so `createRedactingHooks`
creates **one** aggregate budget per log record and spends it across both, plus
child bindings and `mixin()` output on the final line. Many small fields,
or a record the two passes would each scan in full, cannot multiply the work:
past a bound the remaining values become `[REDACTED:LIMIT_EXCEEDED]`, and if the
budget is spent before `streamWrite` visits any value the whole line is the
fixed `{"msg":"[REDACTED:LIMIT_EXCEEDED]"}` line (`PINO_LIMIT_LINE`,
`lineReplaced: true`). Each record, including one logged from inside a getter
while another is being masked, has its own budget. The counters, their
occurrence-versus-call units, the defaults and the fact that this is not a
wall-clock timeout are in
[`@redact-secret/adapter`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#aggregate-operation-budget).
The paired factory owns the unit, so it rejects a caller-owned `operation`.

### Pre-processing ceilings on the final line

`streamWrite` has to find the string values in the finished JSON line and decode
them before the walker can bound anything. Without a ceiling, an oversized line,
or one made of very many tiny literals or very long escape-heavy ones, would be
lexed, collected into arrays and `JSON.parse`d first, and only then meet a walk
limit. `lineLimits` is that ceiling, applied **before** anything proportional to
the line is allocated:

| Ceiling | Default | Refuses |
| --- | --- | --- |
| `maxLineLength` | 4194304 (4 Mi code units) | a line longer than this, checked first and unread |
| `maxValueSpans` | 20000 | a line with more string literals that are *values* (keys are not counted), checked as each is found |
| `maxDecodeLength` | 2097152 (2 Mi code units) | a line whose value literals, plus the key literal each sits under, total more raw code units than this to decode, checked before any is decoded |

Sizes are UTF-16 code units (`string.length`), not bytes: a code-unit count is the
one thing readable before the line is looked at. A bound met exactly is accepted,
one more is refused. A refused line is replaced by the fixed, valid
`{"msg":"[REDACTED:LIMIT_EXCEEDED]"}` line (`PINO_LIMIT_LINE`) with the
original's newline, **never** by the original line and never because a parser
failed: `lineReplaced` is `true`, and the `limited` counter (not `failed`) counts
it. A line that is malformed or has an unterminated string is still the fixed
`{"msg":"[REDACTED:ERROR]"}` line (`PINO_ERROR_LINE`). The hook reads only the
finished string and calls no serialization hook of the host's. Because redaction
runs last, a host `streamWrite` that grows the line is measured after it grew.

**How the three kinds of limit differ.** They bound different work at different
times and are configured separately:

| Kind | Bounds | When | Over the limit |
| --- | --- | --- | --- |
| `lineLimits` (this section) | lexing and decoding the line into the values to mask | before anything is allocated for the line | the whole line becomes the limit line |
| `limits` / `operationLimits` | the traversal of the values (`maxDepth`, `maxTotalLeaves`, ...) and the aggregate work of one record | while the walker visits them | the value, or the rest, becomes `[REDACTED:LIMIT_EXCEEDED]` |
| the core's whole-input limits | one `scanAndRedact` call (`maxInputBytes`, `maxFindings`, enforced by the core) | inside the core, per scan | that leaf becomes `[REDACTED:ERROR]` (a core failure) |

### Composing with your own hooks

Pass the `hooks` object you would otherwise have given `pino()`:

```js
const logger = pino({
  hooks: await createRedactingHooks({ hooks: myHooks }), // composed, not replaced
});
```

**Redaction always runs last, closest to the bytes.** Your `logMethod` runs
first and the redacting hook runs immediately before pino's own `method`, so
arguments your hook adds or rewrites are scanned too; a hook that never calls
`method` still drops the record, exactly as before. Your `streamWrite` runs
first on pino's line and the redacting hook masks what it returns, so fields
your hook adds are scanned too.

Things to be aware of:

- Only `logMethod` and `streamWrite` are composed. Any other key on the object
  is forwarded to pino unchanged: not covered, and not silently dropped.
- A `hooks.logMethod` or `hooks.streamWrite` that is not a function is a
  `TypeError` at setup.
- Because your `streamWrite` runs **first**, it receives pino's line
  **unmasked**, child bindings and `mixin()` output included. A hook that
  transforms the line and returns it is fine. A hook that tees, copies or logs
  that line somewhere else is handling plaintext.

### PII detection

The core detects credentials out of the box. PII detection is a separate
activation:

```js
const logger = pino({ hooks: await createRedactingHooks({ pii: ["pii:global"] }) });
```

It is process-wide and one-shot. If the selection you asked for is not the
one active, the factory **rejects** with a fixed `code`
(`PII_ACTIVATION_NOT_ACTIVE` or `PII_ACTIVATION_UNSUPPORTED`) rather than
returning hooks that scan with PII silently off.

**Activation is not masking.** Under the core's default policy only
`High`-confidence PII is redacted; `Medium` and `Low` resolve to `warn`, which
leaves the text alone. Pass your own `policy` if you need those masked. A
record whose `values.findings` is non-zero while `values.redacted` stays at
zero is exactly this case.

Full rules:
[PII guide](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/pii.md).

### Counting what happened

`onOutcome` reports one summary per **log record**. It is observational:
increment your own counters from it. This package creates no logger, exporter
or network client for you.

```js
const hooks = await createRedactingHooks({
  onOutcome: ({ level, values, lineReplaced }) => {
    metrics.increment("log.records", { level });
    metrics.increment("log.redacted_values", values.redacted);
    if (lineReplaced) metrics.increment("log.lines_replaced");
  },
});
```

```text
{ host: "pino", unit: "log-record", level: 30,
  stages: ["log-method", "stream-write"],
  values: { scanned, findings, redacted, blocked, limited, failed },
  lineReplaced: false }
```

- Both hooks' passes over one record are **summed**, not reported twice: a
  secret in the message is one `redacted`, not one per hook.
- `findings` is not a count of distinct credentials, and `redacted` is lower
  than `findings` whenever a finding leaves text alone. The counts are defined
  in
  [`@redact-secret/adapter`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#outcome-counters).
- `lineReplaced` means the `streamWrite` hook could not parse the line and
  wrote the fixed `[REDACTED:ERROR]` line instead. **It is not a claim that
  the destination accepted anything**: whether a destination or transport
  succeeded is not something this adapter learns.
- Masking finishes before the observer runs. Anything it throws is swallowed,
  never read, and never changes what is written.
- It is re-entrancy-guarded: an observer that logs through the logger it
  observes does not recurse, and those nested records are not reported.
- A record a *host* `logMethod` drops before the redacting hook runs is not
  reported at all.
- Only the paired factory takes `onOutcome`, because only the pair can
  guarantee one summary per record.

## Why both hooks

`createRedactingHooks` installs `hooks.logMethod` **and**
`hooks.streamWrite`, because neither covers the other's input:

| Hook | Sees | Does not see |
| --- | --- | --- |
| `logMethod` | a call's own arguments (message, interpolation values, merging object, `Error`s) before pino merges, serializes, formats or writes anything | child-logger bindings (`logger.child({ … })`, `setBindings`), `mixin()` output |
| `streamWrite` | the finished JSON line: every string value in it, whatever produced it (bindings, `mixin()`, serializers, `base`) | a value before the host's own serializers, `formatters` and `redact` run on it |

With `logMethod` alone, a secret in a child binding or in `mixin()` output
reaches the destination **in plaintext**: pino serializes bindings once when
the child is created, and merges `mixin()` after the hook returns. With
`streamWrite` alone, raw values still reach the host's own serializers and
formatters first.

The cost of the pair is that each line's strings are scanned twice, once as
call arguments and once as line values. That is deliberate, and it is why the
hooks stay separately exported: an application that knowingly uses no child
bindings, `mixin()` or `base`, and wants one scan, can install
`createRedactingLogMethod()` alone and own that boundary.

## Exports

| Export | Purpose |
| --- | --- |
| `createRedactingHooks(options?)` | Live: awaits the core's `initialize()`, returns `{ logMethod, streamWrite }` for `pino({ hooks })`. The complete boundary in one step |
| `createRedactingHooksWith(scanAndRedact, options?)` | The same pair over an injected scanner |
| `createRedactingLogMethod(options?)` | Live: one `hooks.logMethod`. Not the complete boundary on its own |
| `createRedactingStreamWrite(options?)` | Live: one `hooks.streamWrite`. Not the complete boundary on its own |
| `createRedactingLogMethodWith(scanAndRedact, options?)` | The `logMethod` hook over an injected scanner |
| `createRedactingStreamWriteWith(scanAndRedact, options?)` | The `streamWrite` hook over an injected scanner |
| `PINO_ERROR_LINE` | The fixed line written when a line cannot be parsed |
| `formatPinoMessage(fmt, values)` | Internal: the port of pino's message formatter the hook joins with. Kept for compatibility, not a supported API |

`options` is `{ policy, limits }` for the single-hook factories, and
`{ policy, limits, hooks, onOutcome }` for the pair. Every live factory also
takes `pii`. The `…With` variants take the scanner as an argument, which is
what the tests use.

## Supported versions

- `pino ^10.0.0`, verified by a real `pino` logger writing to a captured
  stream, run in CI at both ends of that range. pino `9.x` is deliberately not
  in the range: it may work; it is not tested, so it is not claimed.
- `@redact-secret/core ^0.1.0-beta.6`.
- `createRedactingHooks` needs `adapter-pino` `0.1.2` or later.

pino is imported as a type only. It never enters this package's runtime graph.

## Contributing

Issues and pull requests are welcome:
[CONTRIBUTING.md](https://github.com/redact-secret/redact-secret-adapters/blob/main/CONTRIBUTING.md).
Changes are listed in this package's `CHANGELOG.md`.

## License

MIT
