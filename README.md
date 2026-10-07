# Redact Secret adapters

[![CI](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml)
[![CodeQL](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/codeql.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/codeql.yml)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/15002/badge)](https://www.bestpractices.dev/projects/15002)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/redact-secret/redact-secret-adapters/badge)](https://scorecard.dev/viewer/?uri=github.com/redact-secret/redact-secret-adapters)
[![License: MIT](https://img.shields.io/github/license/redact-secret/redact-secret-adapters)](./LICENSE)

Keep API keys, tokens and passwords out of your logs, traces and AI prompts.

These packages plug [Redact Secret](https://github.com/redact-secret/redact-secret)
into the tools you already use. You add a few lines of setup; secrets are
replaced before they leave your process.

```js
logger.info("deploy with token %s", token);
// before: {"level":30,…,"msg":"deploy with token ghp_SYNTHETICREVOKED00000000000000000000"}
// after:  {"level":30,…,"msg":"deploy with token <SECRET_1>"}
```

The core decides what a secret is. The adapters only carry text into the core
and carry its answer back out.

## Which package do I need?

| I want to protect | Install | Guide |
| --- | --- | --- |
| [pino](#pino) log lines | `npm i @redact-secret/core @redact-secret/adapter-pino pino` | [adapter-pino](./packages/adapter-pino#readme) |
| [OpenTelemetry JS](#opentelemetry-traces-javascript) spans | `npm i @redact-secret/core @redact-secret/adapter-otel-trace @opentelemetry/sdk-trace-base` (the snippet below uses only this) | [adapter-otel-trace](./packages/adapter-otel-trace#readme) |
| [Python `logging`](#python-logging) records | `pip install redact-secret redact-secret-adapters` | [python](./python#readme) |
| [OpenTelemetry Python](#opentelemetry-traces-python) spans | `pip install redact-secret "redact-secret-adapters[otel]"` | [python](./python#opentelemetry-otel-extra) |
| [AI context](#ai-context): user input, tool results, streamed text | `npm i @redact-secret/core @redact-secret/adapter-ai-context` | [adapter-ai-context](./packages/adapter-ai-context#readme) |
| [MCP](#mcp) tool results and resource reads | `npm i @redact-secret/core @redact-secret/adapter-mcp` | [adapter-mcp](./packages/adapter-mcp#readme) |
| [A `mask` callback](#masking-callbacks-langfuse-and-similar) (Langfuse and similar) | `npm i @redact-secret/core @redact-secret/adapter`, or the Python package above | [adapter](./packages/adapter#readme) |

Requirements: Node.js 20, 22 or 24 for the npm packages, Python 3.10 or later
for the PyPI package. The npm packages are ESM only.

Current versions:
[![adapter](https://img.shields.io/npm/v/@redact-secret/adapter?label=adapter)](https://www.npmjs.com/package/@redact-secret/adapter)
[![adapter-pino](https://img.shields.io/npm/v/@redact-secret/adapter-pino?label=adapter-pino)](https://www.npmjs.com/package/@redact-secret/adapter-pino)
[![adapter-otel-trace](https://img.shields.io/npm/v/@redact-secret/adapter-otel-trace?label=adapter-otel-trace)](https://www.npmjs.com/package/@redact-secret/adapter-otel-trace)
[![adapter-ai-context](https://img.shields.io/npm/v/@redact-secret/adapter-ai-context?label=adapter-ai-context)](https://www.npmjs.com/package/@redact-secret/adapter-ai-context)
[![adapter-mcp](https://img.shields.io/npm/v/@redact-secret/adapter-mcp?label=adapter-mcp)](https://www.npmjs.com/package/@redact-secret/adapter-mcp)
[![redact-secret-adapters](https://img.shields.io/pypi/v/redact-secret-adapters?label=redact-secret-adapters%20%28PyPI%29)](https://pypi.org/project/redact-secret-adapters/)

Not covered by anything you can install today: OpenTelemetry metrics and model
output. A Logs adapter,
[`adapter-otel-logs`](./packages/adapter-otel-logs#readme), is published as
`0.1.0-beta.2` under the npm dist-tag `beta`; it depends on
`@redact-secret/adapter` `^0.1.7`, which ships in the next release train, so it
does not install from npm until then. `adapter-otel-trace` never covers logs. `@redact-secret/adapter-otel` is the deprecated old name of
`adapter-otel-trace`; existing imports keep working.

## Quick start

Find your host, copy the block, done. The values in these examples are
synthetic. The pino, Python `logging` and AI-context blocks are the exact source
of a complete project in [`examples/`](./examples) that installs the released
packages from the registry and checks its own output: run one from an empty
directory with the steps in [examples/README.md](./examples#run-one). CI runs
them, and fails if a block here drifts from its source.

### pino

<!-- snippet: examples/pino/app.mjs -->
```js
import { createRedactingHooks } from "@redact-secret/adapter-pino";
import pino from "pino";

// Synthetic, revoked-shaped value only. Never put a real credential in an example.
const token = "ghp_SYNTHETICREVOKED00000000000000000000";

const logger = pino({ base: null, timestamp: false, hooks: await createRedactingHooks() });

logger.child({ session: token }).info("deploy with token %s", token);
```

Prints `{"level":30,"session":"<SECRET_1>","msg":"deploy with token <SECRET_1>"}`.
Runnable: [`examples/pino`](./examples/pino).

Messages, merged objects, errors, child bindings and `mixin()` output are all
covered. pino's own `redact` option still works alongside it.
[Full guide](./packages/adapter-pino#readme).

### OpenTelemetry traces (JavaScript)

```js
import { BasicTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";

// `exporter` is the span exporter you already use.
const provider = new BasicTracerProvider({
  spanProcessors: [await createRedactingSpanProcessor(new BatchSpanProcessor(exporter))],
});
```

Wrap the processor you already have. Span names, attributes, events, links and
the status message are redacted before export.
[Full guide](./packages/adapter-otel-trace#readme).

### Python `logging`

<!-- snippet: examples/python-logging/app.py -->
```python
import logging

from redact_secret_adapters.logging_filter import RedactSecretFilter

# Synthetic, revoked-shaped value only. Never put a real credential in an example.
token = "ghp_SYNTHETICREVOKED00000000000000000000"

handler = logging.StreamHandler()
handler.addFilter(RedactSecretFilter())  # on the handler, not the logger
logging.getLogger().addHandler(handler)

logging.warning("deploy with token %s", token)
```

Prints `deploy with token <SECRET_1>`. Runnable: [`examples/python-logging`](./examples/python-logging).

Add the filter to **every handler** that writes somewhere. A handler without
it writes plaintext. [Full guide](./python#readme).

### OpenTelemetry traces (Python)

```python
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from redact_secret_adapters.otel import create_redacting_span_processor

provider = TracerProvider()
provider.add_span_processor(create_redacting_span_processor(BatchSpanProcessor(exporter)))
```

[Full guide](./python#opentelemetry-otel-extra).

### AI context

<!-- snippet: examples/ai-context/app.mjs -->
```js
import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";

// Synthetic, revoked-shaped values only. Never put a real credential in an example.
const userText = "deploy with API_KEY=ghp_SYNTHETICREVOKED00000000000000000000";
const toolResult = { content: [{ type: "text", text: "build ok" }], exitCode: 0 };

const boundary = await createAiContextBoundary();
const context = boundary.buildContext([
  { role: "user", boundary: "user-input", text: userText },
  { role: "tool", boundary: "tool-result", value: toolResult },
]);

if (context.outcome !== "ok") {
  // `reason` and `code` are fixed labels, safe to log. There is no value to use.
  throw new Error(`context refused: ${context.outcome} ${context.reason ?? ""}`);
}

// context.value is the only thing that may go to a model. This example prints it instead of calling one.
console.log(JSON.stringify(context.value));
```

Call it where your code builds the prompt. The result is `ok` with a sanitized
value, or `blocked` / `aborted` with no value at all. No model is called in the
example. Runnable: [`examples/ai-context`](./examples/ai-context).
[Full guide](./packages/adapter-ai-context#readme).

### MCP

```js
import { createMcpBoundary, toCallToolResult } from "@redact-secret/adapter-mcp";

const mcp = await createMcpBoundary();
const outcome = await mcp.sanitizeToolCall(({ signal }) => client.callTool(params, undefined, { signal }));
const safe = toCallToolResult(outcome); // sanitized result, a fixed error result, or null if cancelled
```

Wrap the tool call, then log, store or send to the model only `safe`.
[Full guide](./packages/adapter-mcp#readme).

### Masking callbacks (Langfuse and similar)

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

When something goes wrong, an adapter writes a fixed marker instead of the
original text. It never falls back to plaintext. These markers are public API
and change only in a major version.

| You see | It means |
| --- | --- |
| `<SECRET_1>` | The core found a secret and replaced just that part |
| `[REDACTED:BLOCKED]` | A `block` finding: the **whole** value is replaced, not just the matched part |
| `[REDACTED:ERROR]` | The scan failed, or the value could not be read. Never the input, never the error's message |
| `[REDACTED:LIMIT_EXCEEDED]` | The value is past a size limit. It was not scanned and not passed through |
| `[REDACTED:CYCLE]` | A self-referencing object |

The AI-context and MCP packages do not use markers. They return an outcome
(`ok`, `blocked`, `aborted`) and give you no value unless it is `ok`.

Each marker and outcome has a cause and a smallest safe correction, with the
differences between the kinds of limit:
[troubleshooting](./docs/troubleshooting.md#logs-and-spans-markers) (markers) and
[outcomes](./docs/troubleshooting.md#ai-context-and-mcp-outcomes).

Size limits (`DEFAULT_LIMITS`, overridable per call; snake case in Python):

| Limit | Default |
| --- | --- |
| `maxDepth` | 8 |
| `maxArrayLength` | 1000 |
| `maxObjectKeys` | 200 |
| `maxStringLength` | 200000 |
| `maxTotalLeaves` | 5000 |
| `maxNodes` | 20000 |

Elements and keys beyond a limit are dropped, not passed through. Details:
[`@redact-secret/adapter`](./packages/adapter#fail-closed-markers).

## Four things to know before you rely on it

1. **No finding is not proof.** Detection belongs to the core and is not
   complete. A clean log line does not prove the input held no secret.
2. **Object keys and attribute names are not scanned on their own** by the
   logging and tracing adapters, and are never rewritten. Do not put a secret
   in a key. A key is used as *context* for the string directly under it, so a
   credential whose detection depends on its field name (`api_key`,
   `password`) is masked; the core decides, and the cost is one more scan for
   each such string. (The AI-context and MCP packages do scan keys.)
3. **Placement matters.** An adapter protects only what passes through it: a
   Python handler without the filter, a span processor registered ahead of the
   redacting one, or a pino transport that adds its own text are outside it.
   Each package guide lists what it does not cover. To check your own output
   path with a synthetic credential and a negative control, run a
   [placement recipe](./examples#run-one):
   [JavaScript](./examples/placement-js), [Python](./examples/placement-python).
4. **PII is off by default.** The core detects credentials out of the box.
   Detecting personal data is a separate switch; see below.

## Options

### PII detection

```js
const logger = pino({ hooks: await createRedactingHooks({ pii: ["pii:global"] }) });
```

```python
import redact_secret
redact_secret.initialize(pii=["pii:global"])  # before the first record or span
```

The pino, OpenTelemetry, AI-context and MCP factories take `pii`, and so do the
Python `RedactSecretFilter` and `create_redacting_span_processor`. It is
process-wide and can be set once.
Under the core's default policy only high-confidence PII is redacted; pass your
own `policy` to mask the rest. To see credentials only, PII on, and an explicit
policy side by side on one synthetic input, run
[`examples/policy-js`](./examples/policy-js) or
[`examples/policy-python`](./examples/policy-python). [PII guide](./docs/pii.md).

### Counting what happened

```js
const hooks = await createRedactingHooks({
  onOutcome: ({ level, values }) => metrics.increment("log.redacted_values", values.redacted, { level }),
});
```

```python
handler.addFilter(RedactSecretFilter(on_outcome=lambda o: metrics.increment("log.records", level=o.level)))
```

`onOutcome` / `on_outcome` reports six counts per log record or span
(`scanned`, `findings`, `redacted`, `blocked`, `limited`, `failed`) and no
values, so you can feed your own metrics without leaking anything.
[Counter reference](./packages/adapter#outcome-counters).

### Policy and limits

Every factory passes the core's `policy` through, and the size limits can be
overridden. The option names differ a little per package; each package guide
has an options table.

## Supported versions

| Package | Works with |
| --- | --- |
| `adapter-pino` | pino `^10.0.0` |
| `adapter-otel-trace` | `@opentelemetry/sdk-trace-base` `^2.0.0` |
| `adapter-mcp` | `@modelcontextprotocol/sdk` `>=1.26.0 <=1.30.1`, or `@modelcontextprotocol/client` / `server` `>=2.0.0 <=2.1.0` |
| `redact-secret-adapters` | CPython `>=3.10`; `opentelemetry-sdk>=1.16.0,<2` for the `[otel]` extra |
| all of them | `@redact-secret/core` `^0.1.0-beta.6` / `redact-secret>=0.1.0b6,<0.2` |

CI runs every adapter against a real instance of its host at both ends of
each range. What is and is not claimed, in detail:
[docs/compatibility.md](./docs/compatibility.md).

## Contributing

New contributors are welcome, and you do not need to know the whole codebase.

```sh
git clone https://github.com/redact-secret/redact-secret-adapters.git
cd redact-secret-adapters
npm ci
npm test
```

That builds every package and runs the JavaScript tests. From there,
[CONTRIBUTING.md](./CONTRIBUTING.md) walks you through a first change: where
the code lives, how to run one package's tests, the Python setup, and what a
pull request needs.

- Found a bug or have an idea? [Open an issue](https://github.com/redact-secret/redact-secret-adapters/issues).
- A missed or false detection is the core's decision: report it to
  [redact-secret/redact-secret](https://github.com/redact-secret/redact-secret/issues).
- Found a vulnerability? Report it privately: [SECURITY.md](./SECURITY.md).
- Never paste a real credential anywhere in this project. Use obviously fake values.

## Learn more

| Document | What is in it |
| --- | --- |
| [ARCHITECTURE.md](./ARCHITECTURE.md) | How the adapters are layered, the security boundary, what is deliberately excluded, and how they compose with [`@redact-secret/vault`](./ARCHITECTURE.md#the-vault-boundary) |
| [docs/compatibility.md](./docs/compatibility.md) | Tested host and core versions, and combinations that are not claimed |
| [docs/troubleshooting.md](./docs/troubleshooting.md) | What each marker and outcome means, and the smallest safe fix |
| [docs/action-semantics.md](./docs/action-semantics.md) | What `allow`, `warn`, `redact` and `block` do at each boundary, including errors and limits; `allow` and `warn` leave the value in the output |
| [docs/policy-overlays.md](./docs/policy-overlays.md) | Default policy, a one-rule override that keeps the default for the rest, and a full callback replacement, with the exact output of each host; what is tested and what (per-handle isolation) is not supported |
| [examples/](./examples) | Runnable quickstarts, placement checks and a credential-versus-PII comparison |
| [docs/pii.md](./docs/pii.md) | Turning on PII detection, and what it does not do |
| [docs/performance.md](./docs/performance.md) | Measuring overhead and package footprint |
| [RELEASING.md](./RELEASING.md) | Branches, release trains, how a version is published |
| [ROADMAP.md](./ROADMAP.md) · [GOVERNANCE.md](./GOVERNANCE.md) · [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md) | Where the project is going and how it is run |
| [Security assurance case](./docs/assurance-case.md) | Why the security requirements are met, with evidence |

Each package keeps its own `CHANGELOG.md` next to its README.

## License

MIT
