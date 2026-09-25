# Redact Secret adapters

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

## Packages

| Package | Registry | Host | Published |
| --- | --- | --- | --- |
| `@redact-secret/adapter` | npm | — (shared base) | `0.1.1`, beta |
| `@redact-secret/adapter-pino` | npm | pino `^10.0.0` | `0.1.1`, beta |
| `@redact-secret/adapter-otel` | npm | `@opentelemetry/sdk-trace-base` `^2.0.0` | `0.1.1`, beta |
| `redact-secret-adapters` | PyPI | stdlib `logging`, OpenTelemetry (extra) | `0.1.0`, beta |
| `@redact-secret/adapter-ai-context` | npm | — (framework-neutral AI context) | `0.1.0-alpha`, prerelease (dist-tag `alpha`) |
| `@redact-secret/adapter-mcp` | npm | MCP TypeScript SDK `>=1.13.0 <=1.30.1`, `2.0.0`–`2.1.0` | `0.1.0-alpha`, prerelease (dist-tag `alpha`) |

Every `0.1.0` was published on 2026-09-22 in release train
[`2026.09.22`](https://github.com/redact-secret/redact-secret-adapters/releases/tag/train/2026.09.22);
the npm versions above ship in the train after it. All of them require core
`0.1.0-beta.6` or later. The two `0.1.0-alpha` packages are prereleases: they
publish under the npm dist-tag `alpha`, not `latest`, so install them as
`@alpha` or by exact version. This README describes `develop`. Anything marked
**Unreleased** below is not in a published package: the Python package is
still `0.1.0`, and the
[`0.1.0` README](https://github.com/redact-secret/redact-secret-adapters/blob/2368d8c99f6b10e18874df0bcfec1818afd588ec/README.md)
describes exactly what it contains.

Every package declares a compatibility range against `@redact-secret/core` /
`redact-secret` and is tested against the host versions it claims. Each host
integration has a test against a real instance of its host, which CI runs at
both ends of the declared range, and a release publishes only from a commit
that passed CI ([RELEASING.md](./RELEASING.md)). See
[Supported host versions](#supported-host-versions).

### Install

```bash
npm install @redact-secret/core @redact-secret/adapter-pino pino
```

```bash
pip install redact-secret redact-secret-adapters          # stdlib logging
pip install redact-secret redact-secret-adapters[otel]    # + OpenTelemetry
```

`@redact-secret/adapter` is pulled in automatically by the host packages; install
it directly only when building your own integration.

## Quick start

### pino

```js
import pino from "pino";
import { createRedactingLogMethod } from "@redact-secret/adapter-pino";

const logger = pino({
  hooks: { logMethod: await createRedactingLogMethod() },
  redact: ["req.headers.authorization"], // pino's own path-based redact still applies, on top
});

logger.info("token is %s", secretValue); // the secret never reaches the transport
```

pino's own `redact` option censors by object *path*. It cannot see a token
inside a message string or an error message. This adapter redacts by *value*,
alongside that mechanism rather than instead of it. `logMethod` alone does not
see child-logger bindings or `mixin()` output.

Since `0.1.1`, `createRedactingStreamWrite`, a `streamWrite` hook, also
covers child bindings and `mixin()` output; install both hooks. `0.1.0` does
not export it. See the [package README](./packages/adapter-pino#readme).

### OpenTelemetry

```js
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel";

const provider = new NodeTracerProvider({
  spanProcessors: [await createRedactingSpanProcessor(new BatchSpanProcessor(exporter))],
});
```

Every string and string-array attribute on a span and its events is redacted
before the span reaches the next processor. Since `0.1.1` the span
name, event names, the status message and link attributes are redacted too
(**Unreleased** in the Python package). Attribute names are not
allowlisted, so OpenInference (`llm.input_messages`, `input.value`, …) and GenAI
semantic-convention attributes (`gen_ai.prompt`, …) are covered without
hardcoding either convention.

### Python `logging`

```python
import logging
from redact_secret_adapters.logging_filter import RedactSecretFilter

handler = logging.StreamHandler()
handler.addFilter(RedactSecretFilter())
logging.getLogger().addHandler(handler)
```

Python's standard library has no value-based redaction at all. This filter adds
it.

### AI context (prerelease)

```js
import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";

const boundary = await createAiContextBoundary({ wholeInputLimits, incrementalLimits, traversalLimits });
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
replaying the core's own conformance fixture, pinned to a core commit. Published as the
prerelease `0.1.0-alpha` (`npm install @redact-secret/adapter-ai-context@alpha`);
see the [package README](./packages/adapter-ai-context#readme).

### MCP (prerelease)

```js
import { createMcpBoundary, toCallToolResult } from "@redact-secret/adapter-mcp";

const mcp = await createMcpBoundary({ wholeInputLimits, incrementalLimits, traversalLimits });
const outcome = await mcp.sanitizeToolCall(({ signal }) => client.callTool(params, undefined, { signal }));
const safe = toCallToolResult(outcome); // sanitized result, a fixed isError result, or null if cancelled
```

The core's [MCP boundary contract](https://github.com/redact-secret/redact-secret/blob/main/docs/reference/mcp-boundary.md),
as a thin specialization of `adapter-ai-context`. It scans the whole tool
result (text, `structuredContent`, `_meta`, resources, links) before the result
is logged, persisted, or placed into model context. It also offers opt-in
argument sanitation, streamed tool output that stops reading on failure, and
fixed `isError` results in place of errors. It names every security non-goal
in its [package README](./packages/adapter-mcp#readme). Published as the
prerelease `0.1.0-alpha` (`npm install @redact-secret/adapter-mcp@alpha`).

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

Elements and keys beyond a limit are dropped, not passed through.

## Supported host versions

A published adapter states the host range it supports and runs a test against a
real instance of that host. The range is not a guess: it is what CI installs and
exercises, at both ends of the declared range.

| Adapter | Declared range | Verified by |
| --- | --- | --- |
| `adapter-pino` | `pino ^10.0.0` | a real `pino` logger: captured stream, sonic-boom async destination, worker-thread transport, concurrent loggers, a failing destination |
| `adapter-otel` | `@opentelemetry/sdk-trace-base ^2.0.0` | real spans through `SimpleSpanProcessor` and `BatchSpanProcessor`, concurrent spans, a failing exporter, flush and shutdown |
| `redact-secret-adapters` (`logging`) | CPython `>=3.10` stdlib | a real `logging.Logger`: filter before formatter, `QueueHandler`/`QueueListener`, threads sharing one handler, a failing handler |
| `redact-secret-adapters[otel]` | `opentelemetry-sdk>=1.16.0,<2` | real spans through simple and batch processors, spans from threads, a failing exporter, flush and shutdown |
| `adapter-ai-context` (prerelease) | `@redact-secret/core ^0.1.0-beta.6` (no host) | the core's AI-context conformance fixture replayed on the real core before and after `initialize()`, and an end-to-end agent turn with every limit |
| `adapter-mcp` (prerelease) | `@modelcontextprotocol/sdk >=1.13.0 <=1.30.1`, `@modelcontextprotocol/client`/`server >=2.0.0 <=2.1.0` | the core's MCP fixture and runner replayed through the public API and over real SDK clients and servers (stdio and Streamable HTTP, protocol 2025-06-18 and 2025-11-25); a host that logs, stores and builds context only from the boundary's output |

[`compatibility.json`](./compatibility.json) is the machine-readable form of
this table: every declared range, the endpoints CI installs, the runtimes it
exercises, and the test files that qualify each package.
`npm run compat:check` fails CI when the record, the manifests, and `ci.yml`
disagree.

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

`scripts/measure-overhead.mjs` (pino, OpenTelemetry JS, `maskSecrets`) and
`scripts/measure-overhead.py` (`logging`, OpenTelemetry Python,
`mask_secrets`) time the same workloads, built from
[`fixtures/overhead-profiles.json`](./fixtures/overhead-profiles.json). Each
harness keeps four costs apart: the host alone, the adapter's own traversal
(over a scanner that finds nothing), the core's scan of exactly the leaves the
adapter hands it, and the host plus adapter plus the real core. Neither
harness carries a threshold or a verdict. The numbers depend on the host, so
the baseline and any budget over it live in
[redact-secret-benchmarks](https://github.com/redact-secret/redact-secret-benchmarks),
not here.

```bash
npm run build && node scripts/measure-overhead.mjs --out overhead-js.json
pip install -e "./python[otel]" && python scripts/measure-overhead.py --out overhead-python.json
```

One-off costs are measured apart from per-event ones:
`scripts/measure-footprint.mjs` (`npm run footprint`) records each npm
package's packed and unpacked size, and its initialization time in a fresh
process (importing the package, the core's own `initialize()` alone, and the
package's live factory end to end), so the adapter's share of start-up is
separable from the core's. The `ai-context-js` host in `measure-overhead.mjs`
measures `adapter-ai-context`'s traversal and scan overhead per context.

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

## What this repository does not contain

No detection: deciding what a secret is stays in the core. Also out of scope
are stream adapters (Node `Transform` and Web `TransformStream` ship inside
`@redact-secret/core` as `./node-stream` and `./web-stream`), MCP messages
other than `tools/call`, model-vendor or LangChain wrappers, and a Langfuse package;
[ARCHITECTURE.md § Deliberate exclusions](./ARCHITECTURE.md#deliberate-exclusions)
gives the reason for each.

## Contributing

Read [ARCHITECTURE.md](./ARCHITECTURE.md) first. Every change must hold to its
[Security boundary](./ARCHITECTURE.md#security-boundary).

## License

MIT
