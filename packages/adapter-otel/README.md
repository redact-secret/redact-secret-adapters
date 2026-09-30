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

`options` is `{ policy, maxStringLength }` — `MaskLeafOptions`, re-exported
here — plus `onOutcome` since `0.1.2`, and `pii` on the live factory
(**Unreleased**). The older `RedactAttributesOptions` alias is deprecated. See
[`@redact-secret/adapter`](../adapter#fail-closed-markers) for the markers.

**Attribute names are not scanned.** The processor masks attribute *values*
(and the span name, event names, and status message). Every attribute key,
on the span, its events, and its links, reaches the exporter unchanged, so an
attribute *named* after a secret keeps that name. Do not put a secret in an
attribute key.

## PII detection is opt-in

**Unreleased.** The core detects credentials out of the box; PII detection is a
separate activation, and it is process-wide and one-shot — the first selection
wins, and a later *different* one fails with `PII_ACTIVATION_CONFLICT`.

Either order works. Activate it yourself before building the provider:

```js
await initialize({ pii: ["pii:global"] });
const processor = await createRedactingSpanProcessor(next); // accepted, not fought over
```

or let the factory do it, which is the order to prefer when this adapter is the
first thing in the process to touch the core:

```js
const processor = await createRedactingSpanProcessor(next, { pii: ["pii:global"] });
```

When you pass `pii`, the factory reads the core's `piiActivation()` afterwards
and **rejects** if the active selection is not the one you asked for, rather
than returning a processor that scans with PII silently off. The rejection
carries a fixed `code` — `PII_ACTIVATION_NOT_ACTIVE`, or
`PII_ACTIVATION_UNSUPPORTED` against a core too old to report an activation —
and never echoes a selector, the input, or the core's own message. Omitting
`pii` needs no newer core: the declared `@redact-secret/core` range is
unchanged, and every other initialization failure still rejects exactly as it
did.

**Activation is not masking.** Under the core's default policy, PII types are
confidence-gated rather than always redacted: a `High`-confidence finding
redacts, while `Medium` and `Low` resolve to `warn` — and a `warn` finding
leaves the text alone. Enabling PII therefore still lets lower-confidence PII
reach the exporter as plaintext. Pass your own `policy` mapping those findings
to `redact` if you need them masked; this package decides nothing about policy.
The counters below make it visible: a span whose `values.findings` is non-zero
while `values.redacted` stays at zero is exactly this case.

## Counting what happened

Since `0.1.2`, `onOutcome` reports one summary per **span**. It is
observational: increment your own counters from it. This package creates no
exporter or network client for you.

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

The counts are defined in
[`@redact-secret/adapter`](../adapter#outcome-counters) — `findings` is not a
count of distinct credentials, and `redacted` is lower than `findings` whenever
a finding leaves text alone. Every string attribute, array element, event name
and status message is its own counted leaf; attribute *names* are not scanned
and not counted.

`dropped` is **this processor's** decision: it did not hand the span to the
next processor because a masked value would not write back (see the
load-bearing assumption above). It does not mean the span was sampled out, and
`dropped: false` does **not** mean the span was exported — whether the next
processor kept it and whether an exporter succeeded are things this adapter
never learns and does not report.

- The observer runs once the span has been forwarded or dropped, so it cannot
  change what is exported, and anything it throws is swallowed and never read.
- It is re-entrancy- and thread-guarded: an observer that ends another span
  does not recurse, and one thread's report never suppresses another's.

## Supported SDK versions

`@opentelemetry/sdk-trace-base ^2.0.0`. The SDK is imported as types only — it
never enters this package's runtime graph.

## License

MIT
