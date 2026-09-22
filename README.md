# Redact Secret adapters

Host integrations for [Redact Secret](https://github.com/redact-secret/redact-secret):
installable packages that wire a logging or tracing host into the deterministic
core, so a secret never reaches a log line, a span attribute, or an
observability backend.

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

| Package | Registry | Host | Status |
| --- | --- | --- | --- |
| `@redact-secret/adapter` | npm | — (shared base) | Beta |
| `@redact-secret/adapter-pino` | npm | pino `^10.0.0` | Beta |
| `@redact-secret/adapter-otel` | npm | `@opentelemetry/sdk-trace-base` `^2.0.0` | Beta |
| `redact-secret-adapters` | PyPI | stdlib `logging`, OpenTelemetry (extra) | Beta |

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
alongside that mechanism rather than instead of it.

### OpenTelemetry

```js
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel";

const provider = new NodeTracerProvider({
  spanProcessors: [await createRedactingSpanProcessor(new BatchSpanProcessor(exporter))],
});
```

The span name, every string and string-array attribute, every event's name and
attributes, the status message, and every link's attributes are redacted before
the span reaches the next processor. Attribute names are not
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
| `[REDACTED:ERROR]` | Any failure inside the core call, including an uninitialized core. Never the original text, never the error's own message |
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
| `adapter-pino` | `pino ^10.0.0` | a real `pino` logger writing to a captured stream |
| `adapter-otel` | `@opentelemetry/sdk-trace-base ^2.0.0` | a real span passed through `onEnd` |
| `redact-secret-adapters` (`logging`) | CPython `>=3.10` stdlib | a real `logging.Logger` with the filter attached |
| `redact-secret-adapters[otel]` | `opentelemetry-sdk>=1.16.0,<2` | a real span passed through a real `TracerProvider` |

pino `9.x` is deliberately **not** in the declared range. It may work; it is not
tested, so it is not claimed.

## Relationship to the core

These packages depend on a narrow, deliberately small part of the core:
`initialize()`, `scanAndRedact()` and its result shape, and whether a finding's
action is `block` or `warn`. Nothing else. That surface is what the declared
compatibility range protects, and — because these packages are written in
TypeScript against the core's own exported types — a change to it fails the
build rather than degrading silently.

The core is released in lockstep across Rust, npm, PyPI and the CLI. These
packages are not part of that lockstep: a new pino release moves
`adapter-pino` and nothing else.

## What this repository does not contain

No detection: deciding what a secret is stays in the core. Also out of scope
are stream adapters (Node `Transform` and Web `TransformStream` ship inside
`@redact-secret/core` as `./node-stream` and `./web-stream`), MCP and
model-context wiring, LangChain, and a Langfuse package;
[ARCHITECTURE.md § Deliberate exclusions](./ARCHITECTURE.md#deliberate-exclusions)
gives the reason for each.

## Contributing

Read [ARCHITECTURE.md](./ARCHITECTURE.md) first. Every change must hold to its
[Security boundary](./ARCHITECTURE.md#security-boundary).

## License

MIT
