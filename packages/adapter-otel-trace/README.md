# @redact-secret/adapter-otel-trace

[![npm version](https://img.shields.io/npm/v/@redact-secret/adapter-otel-trace)](https://www.npmjs.com/package/@redact-secret/adapter-otel-trace)
[![npm downloads](https://img.shields.io/npm/dm/@redact-secret/adapter-otel-trace)](https://www.npmjs.com/package/@redact-secret/adapter-otel-trace)
[![OpenTelemetry SDK peer range](https://img.shields.io/npm/dependency-version/@redact-secret/adapter-otel-trace/peer/@opentelemetry/sdk-trace-base)](https://www.npmjs.com/package/@redact-secret/adapter-otel-trace?activeTab=dependencies)
[![Node.js](https://img.shields.io/node/v/@redact-secret/adapter-otel-trace)](https://www.npmjs.com/package/@redact-secret/adapter-otel-trace)
[![types included](https://img.shields.io/npm/types/@redact-secret/adapter-otel-trace)](https://www.npmjs.com/package/@redact-secret/adapter-otel-trace)
[![CI](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/redact-secret/redact-secret-adapters/badge)](https://scorecard.dev/viewer/?uri=github.com/redact-secret/redact-secret-adapters)
[![License: MIT](https://img.shields.io/npm/l/@redact-secret/adapter-otel-trace)](https://github.com/redact-secret/redact-secret-adapters/blob/main/LICENSE)

Keep secrets out of OpenTelemetry **traces**. Wrap the span processor you
already have, and span names, attributes, events and links are redacted before
they reach your exporter.

Built on the [Redact Secret](https://github.com/redact-secret/redact-secret)
core, which does the detection.

## Install

```bash
npm install @redact-secret/core @redact-secret/adapter-otel-trace @opentelemetry/sdk-trace-base
```

Needs Node.js 22 or 24 and `@opentelemetry/sdk-trace-base ^2.0.0`. ESM only.

## Quick start

```js
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";

const provider = new NodeTracerProvider({
  spanProcessors: [await createRedactingSpanProcessor(new BatchSpanProcessor(exporter))],
});
```

A complete, runnable example:

<!-- smoke-test:example -->
```js
import { BasicTracerProvider, SimpleSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { JsonTraceSerializer } from "@opentelemetry/otlp-transformer";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";

// Synthetic, revoked-shaped values only — never a real credential.
const token = "ghp_SYNTHETICREVOKED00000000000000000000";

// Writes the OTLP/JSON request body an OTLP http/json exporter would send.
const exporter = {
  export(spans, done) {
    process.stdout.write(`${new TextDecoder().decode(JsonTraceSerializer.serializeRequest(spans))}\n`);
    done({ code: 0 });
  },
  shutdown: async () => {},
};

const provider = new BasicTracerProvider({
  spanProcessors: [await createRedactingSpanProcessor(new SimpleSpanProcessor(exporter))],
});
const span = provider.getTracer("checkout").startSpan(`deploy ${token}`);
span.setAttribute("llm.input_messages", `deploy with token ${token}`);
span.addEvent("tool_call", { "tool.args": `Bearer ${token}` });
span.end();
await provider.shutdown();
// ...{"name":"deploy <SECRET_1>",...,"attributes":[{"key":"llm.input_messages","value":{"stringValue":"deploy with token <SECRET_1>"}}],...
```

CI runs this block verbatim from a clean install outside the repository
(`npm run smoke-test`), against the real core, and inspects the exporter's
bytes.

To check that your own provider and exporter are covered, run the
[placement recipe](https://github.com/redact-secret/redact-secret-adapters/tree/main/examples/placement-js):
it serializes a span with a synthetic token the way an exporter would and
includes a processor registered ahead of the redacting one as a negative control.

## What is covered

| Covered | Not covered |
| --- | --- |
| The span name | OpenTelemetry **Logs** (`LogRecord`s from `@opentelemetry/sdk-logs` or a log bridge) |
| Every string and string-array attribute (a `null` hole in an array stays in place) | Metrics |
| Every event's name and attributes | Attribute **names**, which are never scanned on their own or rewritten (a name is only context for the string value under it). Do not put a secret in an attribute key |
| The status message | Spans the wrapped processor never receives: sampled out, or handled by a processor registered ahead of this one |
| Every link's attributes | |

Attribute names are not allowlisted, so OpenInference (`llm.input_messages`,
`input.value`, …) and GenAI semantic-convention attributes (`gen_ai.prompt`,
…) are covered without hardcoding either convention.

**This is a trace processor only.** A `LogRecord` never passes through it and
reaches its exporter as it was written. For logs use
[`@redact-secret/adapter-otel-logs`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter-otel-logs),
a separate package currently published as a beta (`0.1.0-beta.5`, dist-tag `beta`).

When a value cannot be scanned, a fixed marker replaces it. See
[`@redact-secret/adapter`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#fail-closed-markers)
for the markers.

### A span that cannot be redacted is dropped

(Other markers and limits, and what to do about each:
[troubleshooting](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/troubleshooting.md#logs-and-spans-markers).)

`ReadableSpan`'s fields are typed `readonly` but are plain writable objects at
runtime, and this processor writes the masked values back in place. Every
write is read back. If one does not take (for example, an earlier processor
froze the attributes), the span is **dropped**: not exported, and nothing is
thrown out of `span.end()`. A one-time process warning
(`REDACT_SECRET_SPAN_DROPPED`) names the field, never its value.

`test/otel-host.test.ts` builds a real span, passes it through a real
`BasicTracerProvider`, and asserts the exporter saw redacted fields. That
assertion is not optional.

## Options

```js
await createRedactingSpanProcessor(next, { pii, onOutcome, policy, maxStringLength, operationLimits, scanLimits, ruleset, placeholderFormatter, actionPolicy });
```

| Option | What it does |
| --- | --- |
| `pii` | Turn on PII detection, e.g. `["pii:global"]`. See below |
| `onOutcome` | A callback with counts per span, for your metrics. See below |
| `policy` | The core's policy, passed through unchanged. It replaces the core's built-in policy for every finding, a `ruleset` detector's included |
| `scanLimits` | The core's whole-input limits, `{ maxInputBytes, maxFindings }`, for every scan. See [Core scan options](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#core-scan-options) |
| `ruleset` | A declarative detector ruleset (text or bytes) |
| `placeholderFormatter` | The core's placeholder formatter |
| `actionPolicy` | The core's declarative action policy (object, JSON text or bytes), for every string of a span. Mutually exclusive with `policy`; needs core `0.1.0-beta.14` or later, else construction rejects with `CoreOptionsError`. See [Declarative `actionPolicy`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#declarative-actionpolicy) |
| `maxStringLength` | Strings longer than this become `[REDACTED:LIMIT_EXCEEDED]` unscanned |
| `operationLimits` | Override the aggregate budget of **one span**. See below |

### One budget per span

The span name, every attribute, every event and link, and the status message
share **one** aggregate budget per span, so a span with many events and links
cannot multiply the scanning even when each string is within `maxStringLength`.
Past a bound every string not yet inspected becomes
`[REDACTED:LIMIT_EXCEEDED]` unscanned and the span is still forwarded, never with
text the budget did not allow to be inspected; nothing in `onOutcome` carries
input. A key-context scan counts as a scan, and attribute names count as keys.
A span ended re-entrantly inside the next processor has its own budget. Units,
defaults and the caveat that this is a work counter and not a timeout are in
[`@redact-secret/adapter`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#aggregate-operation-budget).

### PII detection

The core detects credentials out of the box. PII detection is a separate
activation:

```js
const processor = await createRedactingSpanProcessor(next, { pii: ["pii:global"] });
```

It is process-wide and one-shot. If the selection you asked for is not the
one active, the factory **rejects** with a fixed `code`
(`PII_ACTIVATION_NOT_ACTIVE` or `PII_ACTIVATION_UNSUPPORTED`) rather than
returning a processor that scans with PII silently off.

**Activation is not masking.** Under the core's default policy only
`High`-confidence PII is redacted; `Medium` and `Low` resolve to `warn`, which
leaves the text alone. Pass your own `policy` if you need those masked. A span
whose `values.findings` is non-zero while `values.redacted` stays at zero is
exactly this case.

Full rules:
[PII guide](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/pii.md).

### Counting what happened

`onOutcome` reports one summary per **span**. It is observational: increment
your own counters from it. This package creates no exporter or network client
for you.

```js
const processor = await createRedactingSpanProcessor(new BatchSpanProcessor(exporter), {
  onOutcome: ({ values, dropped }) => {
    metrics.increment("span.redacted_values", values.redacted);
    if (dropped) metrics.increment("span.dropped_unredactable");
  },
});
```

```text
{ host: "otel", unit: "span",
  values: { scanned, findings, redacted, blocked, limited, failed },
  dropped: false }
```

- Every string attribute, array element, event name and status message is its
  own counted leaf. Attribute *names* are not scanned and not counted.
- `findings` is not a count of distinct credentials, and `redacted` is lower
  than `findings` whenever a finding leaves text alone. The counts are defined
  in
  [`@redact-secret/adapter`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#outcome-counters).
- `dropped` is **this processor's** decision: it did not hand the span to the
  next processor because a masked value would not write back. It does not mean
  the span was sampled out, and `dropped: false` does **not** mean the span was
  exported. Whether the next processor kept it and whether an exporter
  succeeded are things this adapter never learns.
- The observer runs once the span has been forwarded or dropped, so it cannot
  change what is exported. Anything it throws is swallowed and never read.
- It is re-entrancy-guarded: an observer that ends another span does not
  recurse.

## Exports

| Export | Purpose |
| --- | --- |
| `createRedactingSpanProcessor(next, options?)` | Live: awaits the core's `initialize()`, wraps `next` |
| `RedactingSpanProcessorWith` | `new (next, scanAndRedact, options?)`, with an injected scanner |
| `redactAttributesWith(scanAndRedact, attributes, options?)` | Mutates one attribute bag in place; throws a `TypeError` (naming no value) if it cannot |

`options` is `{ policy, maxStringLength }` (`MaskLeafOptions`, re-exported
here) plus `onOutcome` and, on the live factory, `pii`. The older
`RedactAttributesOptions` alias is deprecated.

## Supported versions

`@opentelemetry/sdk-trace-base ^2.0.0` and `@redact-secret/core`
`^0.1.0-beta.6`. CI runs the real-host tests at both ends of each range. The
SDK is imported as types only. It never enters this package's runtime graph.

## Migrating from `@redact-secret/adapter-otel`

This package was published as
[`@redact-secret/adapter-otel`](https://www.npmjs.com/package/@redact-secret/adapter-otel)
up to `0.1.2`. `0.1.0` of this package is that same code: the same exports,
options, outcome shape, peer ranges and fail-closed markers. Only the name
changes, so migrating is a dependency swap and an import specifier:

```sh
npm uninstall @redact-secret/adapter-otel
npm install @redact-secret/adapter-otel-trace
```

```diff
-import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel";
+import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";
```

Nothing breaks if you do not migrate yet. Later releases of
`@redact-secret/adapter-otel` re-export this package, so both names hand out
the same functions and the same `RedactingSpanProcessorWith` class, and mixing
them in one process is safe. Those releases mark every export `@deprecated`,
which editors show as a strikethrough.

Neither name protects OpenTelemetry Logs, before or after migrating.

## Contributing

Issues and pull requests are welcome:
[CONTRIBUTING.md](https://github.com/redact-secret/redact-secret-adapters/blob/main/CONTRIBUTING.md).
Changes are listed in this package's `CHANGELOG.md`.

## License

MIT
