# @redact-secret/adapter-otel

> **Not yet published.** This package is `"private": true` until its real-host
> test has run in CI at both ends of the declared SDK range.

A redacting OpenTelemetry JS `SpanProcessor`, over the
[Redact Secret](https://github.com/redact-secret/redact-secret) core.

```js
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel";

const provider = new NodeTracerProvider({
  spanProcessors: [await createRedactingSpanProcessor(new BatchSpanProcessor(exporter))],
});
```

Every string and string-array attribute on a span and its events is redacted
in `onEnd`, before the span reaches the next processor. Attribute names are not
allowlisted, so OpenInference (`llm.input_messages`, `input.value`, …) and GenAI
semantic-convention attributes (`gen_ai.prompt`, …) are covered without
hardcoding either convention.

## The load-bearing assumption

`ReadableSpan.attributes` is typed `readonly` but is a plain mutable object at
runtime, and this processor mutates it in place. If an SDK version freezes it,
the adapter stops working. `test/otel-host.test.ts` builds a real span, passes
it through a real `BasicTracerProvider`, and asserts the exporter saw redacted
attributes. That assertion is not optional.

## Exports

| Export | Purpose |
| --- | --- |
| `createRedactingSpanProcessor(next, options?)` | Live: awaits the core's `initialize()`, wraps `next` |
| `RedactingSpanProcessorWith` | `new (next, scanAndRedact, options?)` — injected scanner |
| `redactAttributesWith(scanAndRedact, attributes, options?)` | Mutates one attribute bag in place |

`options` is `{ policy, maxStringLength }`. See
[`@redact-secret/adapter`](../adapter#fail-closed-markers) for the markers.

## Supported SDK versions

`@opentelemetry/sdk-trace-base ^2.0.0`. The SDK is imported as types only — it
never enters this package's runtime graph.

## License

MIT
