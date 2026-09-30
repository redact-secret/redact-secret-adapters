# Redact Secret adapters

[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15002/badge)](https://www.bestpractices.dev/projects/15002)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/redact-secret/redact-secret-adapters/badge)](https://scorecard.dev/viewer/?uri=github.com/redact-secret/redact-secret-adapters)
[![CI](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml)
[![CodeQL](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/codeql.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/codeql.yml)
[![License: MIT](https://img.shields.io/github/license/redact-secret/redact-secret-adapters)](./LICENSE)

**Python(PyPI)**
[![PyPI: redact-secret-adapters](https://img.shields.io/pypi/v/redact-secret-adapters?label=redact-secret-adapters)](https://pypi.org/project/redact-secret-adapters/)

**JavaScript(npm)**
[![npm: @redact-secret/adapter](https://img.shields.io/npm/v/@redact-secret/adapter?label=%40redact-secret%2Fadapter)](https://www.npmjs.com/package/@redact-secret/adapter)
[![npm: @redact-secret/adapter-pino](https://img.shields.io/npm/v/@redact-secret/adapter-pino?label=%40redact-secret%2Fadapter-pino)](https://www.npmjs.com/package/@redact-secret/adapter-pino)
[![npm: @redact-secret/adapter-otel-trace](https://img.shields.io/npm/v/@redact-secret/adapter-otel-trace?label=%40redact-secret%2Fadapter-otel-trace&registry_uri=https%3A%2F%2Fregistry.npmjs.org)](https://www.npmjs.com/package/@redact-secret/adapter-otel-trace)
[![npm: @redact-secret/adapter-otel](https://img.shields.io/npm/v/@redact-secret/adapter-otel?label=%40redact-secret%2Fadapter-otel)](https://www.npmjs.com/package/@redact-secret/adapter-otel)
[![npm: @redact-secret/adapter-ai-context](https://img.shields.io/npm/v/@redact-secret/adapter-ai-context?label=%40redact-secret%2Fadapter-ai-context&registry_uri=https%3A%2F%2Fregistry.npmjs.org)](https://www.npmjs.com/package/@redact-secret/adapter-ai-context)
[![npm: @redact-secret/adapter-mcp](https://img.shields.io/npm/v/@redact-secret/adapter-mcp?label=%40redact-secret%2Fadapter-mcp&registry_uri=https%3A%2F%2Fregistry.npmjs.org)](https://www.npmjs.com/package/@redact-secret/adapter-mcp)


Host integrations for [Redact Secret](https://github.com/redact-secret/redact-secret):
installable packages that wire a logging, tracing, or AI-context host into the
deterministic core, so a secret never reaches a log line, a span attribute, an
observability backend, or a model's context.

> The core decides what a secret is. These packages decide nothing — they carry
> text into the core and carry the core's answer back out.

## Why this repository exists

The core repository ships worked examples of these integrations, but a consumer
could only copy a file out of it. From that moment they owned a fork: no
version, no changelog, no notice when the host SDK's contract moved, and no way
for this project to fix wiring it had written itself.

These packages close that gap without moving the wiring into the core. The
core's release matrix, its lockstep versioning, and its side-effect-free
boundary are unchanged. Adapters version independently, on the cadence their
hosts actually move at.

## Which package do I need?

| I want to protect | Install | Status | Where it attaches | Not covered |
| --- | --- | --- | --- | --- |
| **pino** log lines | `npm i @redact-secret/core @redact-secret/adapter-pino pino` | released | `pino({ hooks })` — both hooks, from one `createRedactingHooks()` call | object *keys*; anything a destination or transport adds after `streamWrite` |
| **OpenTelemetry JS** traces (spans) | `npm i @redact-secret/core @redact-secret/adapter-otel-trace @opentelemetry/sdk-trace-base` (before its first release: `@redact-secret/adapter-otel`, the same code) | released as `adapter-otel`; `adapter-otel-trace` is not yet published | wraps the next `SpanProcessor` in your provider's `spanProcessors` | OpenTelemetry **Logs** and metrics; attribute names; spans the wrapped processor never receives (sampled out, a processor registered ahead of it) |
| Python **`logging`** records | `pip install redact-secret redact-secret-adapters` | released | `handler.addFilter(...)` on **every emitting handler** | record attributes not named in `extra_fields`; handlers without the filter |
| **OpenTelemetry Python** traces (spans) | `pip install redact-secret "redact-secret-adapters[otel]"` | released | wraps the next span processor | as OpenTelemetry JS, plus: a span whose private fields will not take the write is **dropped**, not exported |
| OpenTelemetry **Logs** (`LogRecord`s, JS or Python) | — | **not covered** | nothing here sees a log record | everything: `adapter-otel-logs` is a reserved name, not a package |
| A host that hands you a value to **mask** (Langfuse and similar) | `npm i @redact-secret/core @redact-secret/adapter` / `pip install redact-secret redact-secret-adapters` | released | the host's `mask` callback | whatever the host does not route through that callback |
| **AI context** — user input, tool results, a built context, streamed text | `npm i @redact-secret/core @redact-secret/adapter-ai-context` | released | your own code, where the context is built | binary/non-JSON values and encoded text (refused, not decoded); model *output* |
| **MCP** `tools/call` and `resources/read` results | `npm i @redact-secret/core @redact-secret/adapter-mcp` | released | around your `callTool` / tool handler | MCP methods other than those two; binary payloads (blocked by default) |

Statuses are not gradations of care — a prerelease publishes under the npm
dist-tag `alpha`, not `latest`, so it is opt-in by tag or exact version until
its consumer path is qualified. Detailed host behavior lives in each package's
own README, linked from the quick starts below; **no finding is never proof
that the input held no secret**.

## Packages

**This README describes `develop`.** The two columns are different claims: what
you can install today, and what this branch declares for the next release
train. A version in the second column exists only here until that train is cut.

| Package | Registry | Host | Published — installable now | Declared on `develop` |
| --- | --- | --- | --- | --- |
| `@redact-secret/adapter` | npm | — (shared base) | `0.1.5`, beta | `0.1.5` |
| `@redact-secret/adapter-pino` | npm | pino `^10.0.0` | `0.1.2`, beta | `0.1.2` |
| `@redact-secret/adapter-otel-trace` | npm | `@opentelemetry/sdk-trace-base` `^2.0.0` (traces only) | — not yet published | `0.1.0` |
| `@redact-secret/adapter-otel` | npm | deprecated name: re-exports `adapter-otel-trace` | `0.1.2`, beta | `0.1.3` (re-export) |
| `redact-secret-adapters` | PyPI | stdlib `logging`, OpenTelemetry (extra) | `0.1.2`, beta | `0.1.2` |
| `@redact-secret/adapter-ai-context` | npm | — (framework-neutral AI context) | `0.1.1`, beta | `0.1.1` |
| `@redact-secret/adapter-mcp` | npm | MCP TypeScript SDK `>=1.26.0 <=1.30.1`, `2.0.0`–`2.1.0` | `0.1.2`, beta | `0.1.2` |

A prerelease publishes under the npm dist-tag `alpha`, never `latest`, so it is
opt-in by tag or exact version. pip skips a pre-release unless asked for one.
Statuses are not gradations of care — see
[Which package do I need?](#which-package-do-i-need).

Every `0.1.0` was published on 2026-09-22 in release train
[`2026.09.22`](https://github.com/redact-secret/redact-secret-adapters/releases/tag/train/2026.09.22);
the published column above shipped in the trains after it. The
[`0.1.0` README](https://github.com/redact-secret/redact-secret-adapters/blob/2368d8c99f6b10e18874df0bcfec1818afd588ec/README.md)
describes exactly what that release contains.

The opt-in [`pii` activation option](#pii-detection-is-opt-in) on every live
factory, `adapter-pino`'s `createRedactingHooks`, the outcome counters under
[Counting what happened](#counting-what-happened), and the Python package's
corrected activation guidance shipped in train
[`2026.09.29`](https://github.com/redact-secret/redact-secret-adapters/releases/tag/train/2026.09.29)
(`adapter` `0.1.3`, `adapter-pino` and `adapter-otel` `0.1.2`,
`redact-secret-adapters` `0.1.1`) and, for the two AI packages, in their
`0.1.0` stable release.

### Core versions

Every package declares `@redact-secret/core` / `redact-secret`
`0.1.0-beta.6` or later, and none of that changes here. Core
`0.1.0-beta.11` / `0.1.0b11` is the newest, and is what the quick starts below
are verified against; `0.1.0-beta.6` is the floor, and CI runs the real-host
tests at both. Passing `pii` to a factory needs `0.1.0-beta.10` or later, the
release that added opt-in PII detection; everything else works at the floor.
From beta.11 the core loads its PII runtime only when `initialize({ pii })`
names a selector, which needs nothing from the adapters. See
[Supported host versions](#supported-host-versions).

`@redact-secret/vault` `0.1.0-beta.1`, from the sibling vault repository, pins
the core to `0.1.0-beta.10` **exactly**. An application that installs it
alongside these adapters and moves to beta.11 therefore hits a peer conflict —
not because either range is wrong, but because the pins have not yet met. Nothing here
depends on the vault and an adapter release does not wait on it; see
[Composing with the vault](#composing-with-the-vault).

Every package declares a compatibility range against `@redact-secret/core` /
`redact-secret` and is tested against the host versions it claims. Each host
integration has a test against a real instance of its host, which CI runs at
both ends of the declared range, and a release publishes only from a commit
that passed CI ([RELEASING.md](./RELEASING.md)). See
[Supported host versions](#supported-host-versions).

`@redact-secret/adapter` is pulled in automatically by the host packages; install
it directly only when building your own integration.

## Quick start

Every example below is executed from a clean install outside this repository,
against the real core, by `npm run smoke-test` and
`python scripts/smoke-test-python-wheel.py` in CI. The values are synthetic.

### pino

```js
import pino from "pino";
import { createRedactingHooks } from "@redact-secret/adapter-pino";

const logger = pino({
  hooks: await createRedactingHooks(), // both hooks: the complete boundary
  redact: ["req.headers.authorization"], // pino's own path-based redact still applies, on top
});

logger.child({ session: secretValue }).info("token is %s", secretValue);
// neither the message nor the child binding reaches the transport
```

pino's own `redact` option censors by object *path*. It cannot see a token
inside a message string or an error message. This adapter redacts by *value*,
alongside that mechanism rather than instead of it.

`createRedactingHooks` returns **both** hooks pino needs, because neither
covers the other's input: `hooks.logMethod` sees a call's arguments before
pino serializes or formats anything but never sees child-logger bindings or
`mixin()` output, and `hooks.streamWrite` sees the finished line but only
after the host's own serializers and `formatters` have run on raw values.
Installing one of them leaves a plaintext path. The cost of the pair is that
each line's strings are scanned twice.

Pass your own hooks to compose with them rather than replace them —
`createRedactingHooks({ hooks: myHooks })`; redaction runs last, closest to
the bytes. `createRedactingHooks` needs `adapter-pino 0.1.2`;
`0.1.1` exports `createRedactingLogMethod` and `createRedactingStreamWrite`
separately, and `0.1.0` has no `streamWrite` hook at all. Full ordering rules,
the executable example, and what stays outside the boundary: the
[package README](./packages/adapter-pino#readme).

### OpenTelemetry traces

```js
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";

const provider = new NodeTracerProvider({
  spanProcessors: [await createRedactingSpanProcessor(new BatchSpanProcessor(exporter))],
});
```

Every string and string-array attribute on a span and its events is redacted
before the span reaches the next processor. Since `0.1.1` the span
name, event names, the status message and link attributes are redacted too
(in the Python package since `0.1.1`). Attribute names are not
allowlisted, so OpenInference (`llm.input_messages`, `input.value`, …) and GenAI
semantic-convention attributes (`gen_ai.prompt`, …) are covered without
hardcoding either convention.

This is a **trace** processor. OpenTelemetry **Logs** — a `LogRecord` from
`@opentelemetry/sdk-logs` or a log bridge — never pass through it and are not
protected by anything in this repository; nor are metrics.

The package was published as `@redact-secret/adapter-otel` up to `0.1.2`, and
`@redact-secret/adapter-otel-trace` is its trace-only name from its first
release (redact-secret/redact-secret-adapters#49). Until that is on npm,
install `@redact-secret/adapter-otel`, which is the same code. Existing
`@redact-secret/adapter-otel` imports keep working after it: the old name
re-exports the new one, and migrating is an import-specifier change —
[migration guide](./packages/adapter-otel-trace#migrating-from-redact-secretadapter-otel).

### Python `logging`

```python
import logging
from redact_secret_adapters.logging_filter import RedactSecretFilter

redact = RedactSecretFilter()  # no per-record state: one instance can be shared
for handler in (logging.StreamHandler(), logging.FileHandler("audit.log")):
    handler.addFilter(redact)  # every emitting handler, not the logger
    logging.getLogger().addHandler(handler)
```

Python's standard library has no value-based redaction at all. This filter adds
it.

A `logging.Filter` runs **only where it is attached**, so this is not global
automatic protection — placement is the decision:

- Attach it to **every emitting handler**. Handlers run in order and the filter
  mutates the record in place, so an unfiltered handler that runs *before* a
  filtered one emits plaintext.
- A filter on a **logger** does not run for records **propagated** from child
  loggers. A filter on a handler does, wherever that handler is attached — but
  not for a handler the child carries itself.
- With `QueueHandler`/`QueueListener`, attach it to the **`QueueHandler`**, so
  only masked records cross the queue. A filter on the listener's sink protects
  the final destination but not the queue.
- Record attributes are covered only when you name them:
  `RedactSecretFilter(extra_fields=["user"])`.

Your formatters, `extra` configuration and exception logging keep working
unchanged. The full table of placements, and the negative controls that assert
plaintext really escapes each wrong one, are in the
[package README](./python#readme).

### AI context (prerelease)

```js
import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";

const boundary = await createAiContextBoundary(); // conservative documented default limits
const context = boundary.buildContext([
  { role: "user", boundary: "user-input", text: userText },
  { role: "tool", boundary: "tool-result", value: toolResult },
]);
if (context.outcome === "ok") callModel(context.value); // otherwise nothing of the input is returned
```

The core's framework-neutral
[AI-context boundary contract](https://github.com/redact-secret/redact-secret/blob/main/docs/reference/ai-context-boundary.md):
user input, tool results, nested values, constructed context and staged
streams, each ending in `ok` / `blocked` / `aborted`, fail-closed and
all-or-nothing, with allowlisted finding metadata. It is qualified by
replaying the core's own conformance fixture, pinned to a core commit.

The bounds are always in force; `AI_CONTEXT_DEFAULT_LIMITS` only means you no
longer have to invent them before the first call, and any set can still be
passed explicitly. There is no unbounded mode. Non-JSON values, binary content
and encoded text are **blocked, not decoded** — convert them yourself, so what
is scanned is exactly what you send. Published as `0.1.0` (`npm install @redact-secret/adapter-ai-context`);
`createAiContextBoundary()` with no limits needs `0.1.0-alpha.2` or later. See the
[package README](./packages/adapter-ai-context#readme).

### MCP (prerelease)

```js
import { createMcpBoundary, toCallToolResult } from "@redact-secret/adapter-mcp";

const mcp = await createMcpBoundary(); // conservative documented default limits
const outcome = await mcp.sanitizeToolCall(({ signal }) => client.callTool(params, undefined, { signal }));
const safe = toCallToolResult(outcome); // sanitized result, a fixed isError result, or null if cancelled
```

The core's [MCP boundary contract](https://github.com/redact-secret/redact-secret/blob/main/docs/reference/mcp-boundary.md),
as a thin specialization of `adapter-ai-context`. It scans the whole tool
result (text, `structuredContent`, `_meta`, resources, links) before the result
is logged, persisted, or placed into model context. It also offers opt-in
argument sanitation, streamed tool output that stops reading on failure, and
fixed `isError` results in place of errors. Binary payloads (`image`, `audio`,
a base64 `blob`) cannot be scanned, so they **block** the whole result by
default; `binaryContent: "pass"` lets a string payload through unscanned at its
original position instead. A content type no qualified protocol revision
defines also blocks, and a cancelled call is `aborted` with nothing to deliver.
It names every security non-goal in its
[package README](./packages/adapter-mcp#readme). Published as `0.1.0` (`npm install @redact-secret/adapter-mcp`);
`createMcpBoundary()` with no limits needs `0.1.0-alpha.2` or later.

### Masking callbacks (Langfuse and similar)

Hosts that hand you a value to mask need no dedicated package — the shared
walker is the whole integration:

```js
import { createMaskSecrets } from "@redact-secret/adapter";

const maskSecrets = await createMaskSecrets();
const langfuse = new Langfuse({ mask: ({ data }) => maskSecrets(data) });
```

```python
from redact_secret_adapters.mask_secrets import mask_secrets

langfuse = Langfuse(mask=mask_secrets)
```

## Fail-closed behavior

Every adapter shares one primitive for masking a single string, and that
primitive never lets an error put text on the wire. These markers are public
API: they are what a host sees, and they change only in a major version.

| Marker | When |
| --- | --- |
| `[REDACTED:BLOCKED]` | A `block` finding — the **entire** leaf is replaced, not just the matched span |
| `[REDACTED:ERROR]` | Any failure inside the core call, including an uninitialized core. Since `@redact-secret/adapter` `0.1.1`: also a malformed result, and any value that cannot be read (a throwing getter or `toJSON()`). Never the original text, never the error's own message |
| `[REDACTED:LIMIT_EXCEEDED]` | A value past a walk budget. It is never scanned and never passed through unmasked |
| `[REDACTED:CYCLE]` | A self-referencing object |

Bounds (`DEFAULT_LIMITS`, overridable per call):

| Limit | Default |
| --- | --- |
| `maxDepth` | 8 |
| `maxArrayLength` | 1000 |
| `maxObjectKeys` | 200 |
| `maxStringLength` | 200000 |
| `maxTotalLeaves` | 5000 |
| `maxNodes` | 20000 |

Elements and keys beyond a limit are dropped, not passed through. `maxNodes`
counts every value visited, containers and leaves alike but not keys, once per
path. It bounds the work for an in-process object graph with shared
references, which the walk visits once per path. The Python walker uses the
same limits in snake case (`max_nodes`, ...).

## PII detection is opt-in

The core detects credentials out of the box. **PII detection is a separate,
explicit activation**, and it is process-wide and one-shot: the first selection
wins, and a later *different* one fails with `PII_ACTIVATION_CONFLICT`. An
empty selection is a different selection, not a neutral one.

Either order works. Activate it yourself and the factories accept it:

```js
import { initialize } from "@redact-secret/core";

await initialize({ pii: ["pii:global"] }); // the application's own choice
const logger = pino({ hooks: await createRedactingHooks() }); // accepted, not fought over
```

Or let the factory activate it, which is the order to prefer when the adapter
is the first thing in the process to touch the core:

```js
const logger = pino({ hooks: await createRedactingHooks({ pii: ["pii:global"] }) });
```

`pii` is accepted by `createRedactingHooks`, `createRedactingLogMethod`,
`createRedactingStreamWrite`, `createRedactingSpanProcessor`,
`createAiContextBoundary` and `createMcpBoundary`. When you pass it, the
factory reads the core's `piiActivation()` afterwards and **refuses** if the
active selection is not the one you asked for, rather than running with PII
silently off — as a rejection in `adapter-pino` and `adapter-otel-trace`, and as the
usual fail-closed `blocked` / `core_error` in `adapter-ai-context` and
`adapter-mcp`, which never reject. The refusal carries a fixed code
(`PII_ACTIVATION_NOT_ACTIVE`, or `PII_ACTIVATION_UNSUPPORTED` against a core
too old to report an activation) and never echoes a selector, the input, or the
core's own message. Omitting `pii` needs no newer core: the declared
`@redact-secret/core` range is unchanged.

In Python there is no init step for credentials — the extension loads on
`import redact_secret` — but PII is the same explicit call, and **placement is
the whole rule**:

```python
import redact_secret
redact_secret.initialize(pii=["pii:global"])  # before the first record or span
```

Handlers attach and tracer providers are built at import time, so a module
imported earlier can emit before that line runs. Those records are scanned with
PII off and report nothing, with no error. The adapters cannot close that
window — the process owns the activation — so it is pinned as a known
limitation in `python/tests/test_pii_activation.py` rather than hidden.

**Activation is not masking.** Under the core's default policy, PII types are
confidence-gated rather than always redacted: a `High`-confidence finding
redacts, while `Medium` and `Low` resolve to `warn` — and a `warn` finding
leaves the text alone. So enabling PII still lets lower-confidence PII reach a
log line, a span or an AI context as plaintext. Supply your own `policy`
mapping those findings to `redact` if you need them masked; this repository
decides nothing about policy. The counters below make it observable: a value
with a non-zero `findings` that is not counted in `redacted` is exactly this.

## Counting what happened

Every host adapter can report one **input-free** summary per unit of work — one
pino log record, one span, one Python `logging` record — through the same
contract, so a consumer can count sanitized, blocked, limited and failed values
without the adapters coupling to a metrics backend. No adapter here creates a
logger, an exporter or a network client for it; you increment your own counters.

```js
const hooks = await createRedactingHooks({
  onOutcome: ({ level, values }) => metrics.increment("log.redacted_values", values.redacted, { level }),
});
```

```python
handler.addFilter(RedactSecretFilter(on_outcome=lambda o: metrics.increment("log.records", level=o.level)))
```

A summary carries six non-negative integers and nothing else — no value, no
masked value, no field path, no key, no offset, no error message:

| Count | Means |
| --- | --- |
| `scanned` | Values handed to the core. One a bound refused first is not counted here |
| `findings` | Findings the core reported, summed. **Not** distinct credentials: one credential in five values is five findings |
| `redacted` | Values whose text the core changed. Lower than `findings` when a finding leaves text alone (a `warn`) |
| `blocked` | Values replaced whole by `[REDACTED:BLOCKED]` |
| `limited` | Values past a bound: replaced by `[REDACTED:LIMIT_EXCEEDED]`, never scanned |
| `failed` | Values replaced by `[REDACTED:ERROR]`, plus the cycle case |

The unit is the host's, and so is the delivery field: pino reports one summary
per **record** with both hooks' passes summed rather than double counted, plus
`lineReplaced`; OpenTelemetry reports one per **span**, plus `dropped`.
**Neither means "delivered"** — whether a destination, a handler or an exporter
succeeded is something no adapter here learns, so none of them claims it.
`dropped` is the adapter's own refusal to forward a span it could not redact,
not a sampling decision.

An observer runs after the value is masked and cannot change it; anything it
throws is swallowed and never read; and it is re-entrancy-guarded, so an
observer that logs through the logger it observes does not recurse.
In the Python package since `0.1.1`. Details:
[`@redact-secret/adapter`](./packages/adapter#outcome-counters).

## Supported host versions

A published adapter states the host range it supports and runs a test against a
real instance of that host. The range is not a guess: it is what CI installs and
exercises, at both ends of the declared range.

| Adapter | Declared range | Verified by |
| --- | --- | --- |
| `adapter-pino` | `pino ^10.0.0` | a real `pino` logger: captured stream, sonic-boom async destination, worker-thread transport, concurrent loggers, a failing destination |
| `adapter-otel-trace` | `@opentelemetry/sdk-trace-base ^2.0.0` | real spans through `SimpleSpanProcessor` and `BatchSpanProcessor`, the OTLP JSON bytes the exporter sends, concurrent spans, a failing exporter, flush and shutdown. Traces only |
| `adapter-otel` (deprecated name) | `@opentelemetry/sdk-trace-base ^2.0.0` | the same export list and objects as `adapter-otel-trace`, and the same OTLP JSON bytes for one span; the clean-install smoke test also compares the release on npm |
| `redact-secret-adapters` (`logging`) | CPython `>=3.10` stdlib | a real `logging.Logger`: filter before formatter, `QueueHandler`/`QueueListener`, threads sharing one handler, a failing handler |
| `redact-secret-adapters[otel]` | `opentelemetry-sdk>=1.16.0,<2` | real spans through simple and batch processors, spans from threads, a failing exporter, flush and shutdown |
| `adapter-ai-context` (prerelease) | `@redact-secret/core ^0.1.0-beta.6` (no host) | the core's AI-context conformance fixture replayed on the real core before and after `initialize()`, and an end-to-end agent turn with every limit |
| `adapter-mcp` (prerelease) | `@modelcontextprotocol/sdk >=1.26.0 <=1.30.1`, `@modelcontextprotocol/client`/`server >=2.0.0 <=2.1.0` | the core's MCP fixture and runner replayed through the public API and over real SDK clients and servers (stdio and Streamable HTTP, protocol 2025-11-25); a host that logs, stores and builds context only from the boundary's output |

[`compatibility.json`](./compatibility.json) is the machine-readable form of
this table: every declared range, the endpoints CI installs, the runtimes it
exercises, and the test files that qualify each package.
`npm run compat:check` fails CI when the record, the manifests, and `ci.yml`
disagree.

A declared range and a qualified endpoint are different claims. The range says
what installs; `endpoints` names the two versions CI actually installs and runs
the real-host tests against, and the semver expression between them is **not**
evidence that every version inside it was tested. As of 2026-09-29 the core
endpoints are `0.1.0-beta.6` and `0.1.0-beta.11` (`0.1.0b6` and `0.1.0b11` on
PyPI). A newer core does not narrow
the floor: a range is raised only when a package needs an API a lower core
lacks, which the `published-combination` job enforces. A core version that is
announced but not yet on the registry qualifies nothing —
[RELEASING.md § Qualifying a new core release](./RELEASING.md#qualifying-a-new-core-release)
is the procedure.

`qualifiedBy` in that record lists the tests that make an endpoint evidence,
and it is deliberately narrower than "the tests that cover this package". A
test that injects or mocks the core proves nothing about either endpoint, so
it is not listed there however thorough it is, and most of the activation
tests are exactly that — a real core's PII selection is process-wide and
one-shot, so a single test worker can exercise one ordering against it. The
two that do run against a real core, one ordering per spawned process
(`packages/adapter/test/activation-live.test.ts` and
`python/tests/test_pii_activation.py`), are listed.

### Combinations that are not claimed

| Combination | Status |
| --- | --- |
| Core between the two endpoints, e.g. `0.1.0-beta.8` or `0.1.0-beta.10` | Installs; inside the declared range but not an endpoint CI runs. Not claimed. |
| Core below `0.1.0-beta.6` | Refused at install (`ERESOLVE`, or pip). |
| A factory's `pii` option on a core below `0.1.0-beta.10` | Refused at runtime with a fixed code. Omitting `pii` works at the floor. |
| `@redact-secret/vault` `0.1.0-beta.1` with core `0.1.0-beta.11` | Peer conflict: the vault pins `0.1.0-beta.10` exactly. Its own bump is tracked in the vault repository. |
| Any version in the "Declared on `develop`" column | Not published. Nothing installs it until the train is cut. |

An unqualified host is either refused at install time or listed as
unqualified there:

- **Refused.** An out-of-range `pino`, `@opentelemetry/sdk-trace-base` or
  `@redact-secret/core` stops `npm install` with `ERESOLVE`, unless you
  override it with `--legacy-peer-deps` or `--force`. pip refuses an
  `opentelemetry-sdk` or `redact-secret` outside the declared range, and any
  CPython older than 3.10.
- **Documented, not refused.** Node.js outside 20.x, 22.x and 24.x (`engines`
  only warns) and CPython 3.15 or later install but are not tested.

pino `9.x` is deliberately **not** in the declared range. It may work; it is not
tested, so it is not claimed.

## Operational overhead

`scripts/measure-overhead.mjs` (pino, OpenTelemetry JS, `maskSecrets`, the
AI-context boundary, and the MCP boundary, whole-input and streamed) and
`scripts/measure-overhead.py` (`logging`, OpenTelemetry Python,
`mask_secrets`) time the same workloads, built from
[`fixtures/overhead-profiles.json`](./fixtures/overhead-profiles.json): typical
log, span and payload events, a 1×/4×/16× scaling series, and events past each
`DEFAULT_LIMITS` bound. Each harness keeps four costs apart: the host alone,
the adapter's own traversal (over a scanner that finds nothing), the core's
scan of exactly the leaves the adapter hands it, and the host plus adapter plus
the real core. Each is measured in three separate passes: batch wall time,
single-event latency (median, p95, p99, maximum), and memory (bytes allocated
per event in JavaScript, tracemalloc's peak in Python, and garbage-collection
count and pause).

Neither harness carries a threshold or a verdict. The numbers depend on the
host, so the baseline and any budget over it live in
[redact-secret-benchmarks](https://github.com/redact-secret/redact-secret-benchmarks),
not here.

```bash
npm run build && node scripts/measure-overhead.mjs --out overhead-js.json
pip install -e "./python[otel]" && python scripts/measure-overhead.py --out overhead-python.json
```

### Comparing releases

To compare against the previous release, install it into a prefix and pass
`--baseline`. Each harness then interleaves the previous release's modes with
the current build's in one session, sharing the host and the injected core, and
records for every result a `change` from baseline to current (a record, not a
verdict):

```bash
node scripts/install-overhead-baseline.mjs /tmp/overhead-baseline
node scripts/measure-overhead.mjs --baseline /tmp/overhead-baseline --out overhead-js.json
python scripts/install-overhead-baseline.py /tmp/overhead-baseline-python
python scripts/measure-overhead.py --baseline /tmp/overhead-baseline-python --out overhead-python.json
node scripts/summarize-overhead-change.mjs overhead-js.json overhead-python.json
```

`npm run bench:docker` (`-- --python` for the Python harness) does the same
inside [`docker/bench.Dockerfile`](./docker/bench.Dockerfile) or
[`docker/bench-python.Dockerfile`](./docker/bench-python.Dockerfile). The
runtime, the OS libraries, the core's native addon and the previous release
are pinned in the image, the container has no network, and the image id and
source commit are recorded in the output (`-- --cpuset 2,3` also pins CPUs).
The image fixes the software, not the hardware, so compare runs from different
machines only by their same-session `change`, never by absolute microseconds,
and never run it under emulation.

Which values to read, in order:

| Value | Why |
| --- | --- |
| `change.scannerCallsPerEvent` | Deterministic. If it moved, the two builds do different work, and a timing change between them is not like-for-like. |
| `change.traversal` | The adapter's own code only (walker and seam), independent of the core. This is the one to optimize. |
| `change.adapterCoreAllocatedBytesPerEvent` / `adapterCorePeakBytes` | Allocation moves first when a walker gets cheaper or more expensive. |
| `change.adapterCoreLatencyP95` / `P99` | The tail a logger or tracer notices. |
| `derived.adapterOverheadRatio` | Overhead as a fraction of the host's own time, for hosts that have one. |
| the `limit-*-over` rows | The fail-closed path past each limit. It must stay cheap. |

A change is only meaningful above the machine's noise floor. Measure it with an
A/A run, the current build against a copy of itself:
`npm run bench:docker -- --aa`, then `summarize-overhead-change.mjs` on its
output.

### One-off costs

`scripts/measure-footprint.mjs` (`npm run footprint`) records each npm
package's packed and unpacked size, and its initialization time in a fresh
process (importing the package, the core's own `initialize()` alone, and the
package's live factory end to end), so the adapter's share of start-up is
separable from the core's.

## Relationship to the core

The logging and tracing packages depend on a narrow, deliberately small part
of the core: `initialize()`, `scanAndRedact()` and its result shape, and
whether a finding's action is `block` or `warn`. Nothing else. The AI-context
package alone also uses the whole-input `policy`/`limits` options, the
incremental session, `SecretScanError.code`, and the safe finding fields, as
the core's AI-context contract allows
([ARCHITECTURE.md § The core contract](./ARCHITECTURE.md#the-core-contract)). That surface is what the declared
compatibility range protects, and — because these packages are written in
TypeScript against the core's own exported types — a change to it fails the
build rather than degrading silently.

The core is released in lockstep across Rust, npm, PyPI and the CLI. These
packages are not part of that lockstep: a new pino release moves
`adapter-pino` and nothing else.

## Composing with the vault

`@redact-secret/vault`, from the sibling
[`redact-secret-vault`](https://github.com/redact-secret/redact-secret-vault)
repository, is opt-in, in-memory capture: it replaces a detected secret with a
`<rsv_…>` token on the way to a model and restores the original value into a
field the application designates. **Nothing here depends on it**, and the two
compose in one order:

1. **Capture first.** `capture()` and `createAiContextBoundary` sit on the same
   seam — the path to the model — so the vault runs first and the adapter sees
   already-tokenized text.
2. **Adapters after.** A `<rsv_…>` token passes through every adapter here
   byte for byte. No adapter parses, rewrites or restores one; a rewrite would
   not leak anything, it would destroy a value the application still needs, and
   `restore()` would answer `RESTORE_DENIED`.
3. **Never route a restored value to an observability sink.** Restoration puts
   plaintext back. Log it, attach it to a span, or put it back into model
   context, and the capture bought nothing.

Two paths deliberately do not preserve a token — a leaf past `maxStringLength`,
and a core failure — because both replace the whole leaf with a marker. Both are
pinned as tests, in both languages, along with the pass-through itself:
[ARCHITECTURE.md § The vault boundary](./ARCHITECTURE.md#the-vault-boundary).

## What this repository does not contain

No detection: deciding what a secret is stays in the core. Also out of scope
are stream adapters (Node `Transform` and Web `TransformStream` ship inside
`@redact-secret/core` as `./node-stream` and `./web-stream`), MCP messages
other than `tools/call`, model-vendor or LangChain wrappers, and a Langfuse package;
[ARCHITECTURE.md § Deliberate exclusions](./ARCHITECTURE.md#deliberate-exclusions)
gives the reason for each.

## Contributing

Read [CONTRIBUTING.md](./CONTRIBUTING.md) first: it covers how to report a bug or
request an enhancement, how to submit a change, and the requirements a change
must meet, including tests. Then read [ARCHITECTURE.md](./ARCHITECTURE.md);
every change must hold to its
[Security boundary](./ARCHITECTURE.md#security-boundary). Report suspected
vulnerabilities privately as described in [SECURITY.md](./SECURITY.md).

## License

MIT
