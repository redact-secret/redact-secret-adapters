# @redact-secret/adapter-otel

A redacting OpenTelemetry JS `SpanProcessor`, over the
[Redact Secret](https://github.com/redact-secret/redact-secret) core.

```js
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel";

const provider = new NodeTracerProvider({
  spanProcessors: [await createRedactingSpanProcessor(new BatchSpanProcessor(exporter))],
});
```

In `onEnd`, before the span reaches the next processor, the processor redacts
the span name, every string and string-array attribute (a `null` hole in an
array is kept in place), every event's name and attributes, the status message,
and every link's attributes. Attribute names are not
allowlisted, so OpenInference (`llm.input_messages`, `input.value`, …) and GenAI
semantic-convention attributes (`gen_ai.prompt`, …) are covered without
hardcoding either convention.

## The load-bearing assumption

`ReadableSpan`'s fields are typed `readonly` but are plain writable objects at
runtime, and this processor writes the masked values back in place. Every write
is read back; if one does not take (for example, an earlier processor froze the
attributes), the span is **dropped** — not exported, and nothing is thrown out
of `span.end()` — and a one-time process warning
(`REDACT_SECRET_SPAN_DROPPED`) names the field, never its value.
`test/otel-host.test.ts` builds a real span, passes it through a real
`BasicTracerProvider`, and asserts the exporter saw redacted fields. That
assertion is not optional.

## Exports

| Export | Purpose |
| --- | --- |
| `createRedactingSpanProcessor(next, options?)` | Live: awaits the core's `initialize()`, wraps `next` |
| `RedactingSpanProcessorWith` | `new (next, scanAndRedact, options?)` — injected scanner |
| `redactAttributesWith(scanAndRedact, attributes, options?)` | Mutates one attribute bag in place; throws a `TypeError` (naming no value) if it cannot |

`options` is `MaskLeafOptions` (`{ policy, maxStringLength }`), re-exported
here; the older `RedactAttributesOptions` alias is deprecated. See
[`@redact-secret/adapter`](../adapter#fail-closed-markers) for the markers.

## Supported SDK versions

`@opentelemetry/sdk-trace-base ^2.0.0`. The SDK is imported as types only — it
never enters this package's runtime graph.

## License

MIT
