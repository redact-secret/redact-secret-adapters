# @redact-secret/adapter-otel-logs

Keep secrets out of OpenTelemetry **logs**. Wrap the log record processor you
already have, and each log record's body, severity text, event name and
attribute values are redacted before they reach your exporter.

> **Status: beta.** `0.1.0-beta.2` is on npm under the dist-tag `beta`
> (`npm install @redact-secret/adapter-otel-logs@beta`). It depends on
> `@redact-secret/adapter` `^0.1.7`, which is not on npm yet and publishes in
> the next release train, so the install fails to resolve until then. The
> qualification below is unchanged from before publishing; a beta carries no
> stability promise. Nothing in this README is a promise about a release date.
> `@redact-secret/adapter-otel-trace` does **not** cover logs and never did;
> this is the package that does.

Built on the [Redact Secret](https://github.com/redact-secret/redact-secret)
core, which does the detection.

## Quick start

Needs Node.js 20, 22 or 24, `@opentelemetry/sdk-logs` `>=0.200.0 <=0.222.0`
and `@redact-secret/core` `^0.1.0-beta.6`. ESM only.

```js
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { createRedactingLogRecordProcessor } from "@redact-secret/adapter-otel-logs";

const loggerProvider = new LoggerProvider({
  processors: [await createRedactingLogRecordProcessor(new BatchLogRecordProcessor({ exporter }))],
});
```

A complete, runnable example:

<!-- smoke-test:example -->
```js
import { BatchLogRecordProcessor, LoggerProvider } from "@opentelemetry/sdk-logs";
import { JsonLogsSerializer } from "@opentelemetry/otlp-transformer";
import { createRedactingLogRecordProcessor } from "@redact-secret/adapter-otel-logs";

// Synthetic, revoked-shaped values only — never a real credential.
const token = "ghp_SYNTHETICREVOKED00000000000000000000";

// Writes the OTLP/JSON request body an OTLP http/json exporter would send.
const exporter = {
  export(records, done) {
    process.stdout.write(`${new TextDecoder().decode(JsonLogsSerializer.serializeRequest(records))}\n`);
    done({ code: 0 });
  },
  shutdown: async () => {},
  forceFlush: async () => {},
};

const loggerProvider = new LoggerProvider({
  processors: [await createRedactingLogRecordProcessor(new BatchLogRecordProcessor({ exporter }))],
});
loggerProvider.getLogger("checkout").emit({
  body: `deploy with token ${token}`,
  severityText: "ERROR",
  attributes: { "http.url": `https://example.test/reset?token=${token}`, "retry.count": 3 },
});
await loggerProvider.shutdown();
// ...{"body":{"stringValue":"deploy with token <SECRET_1>"},...,"attributes":[{"key":"http.url","value":{"stringValue":"https://example.test/reset?token=<SECRET_1>"}},...
```

CI runs this block verbatim from a clean install outside the repository
(`npm run smoke-test:otel-logs`), against the real core, and inspects the
exporter's bytes.

`sdk-logs` is experimental and its own constructors changed inside the
supported range. The example above uses the current shape
(`new BatchLogRecordProcessor({ exporter })` from 0.220, the `processors`
option from 0.201). On older releases pass `exporter` as the first argument
and register with `addLogRecordProcessor`. This package only wraps whatever
processor you built, so it works with either.

## Where to put it

Wrap the processor that owns the exporter, and register the wrapper:

```js
new LoggerProvider({ processors: [await createRedactingLogRecordProcessor(new BatchLogRecordProcessor({ exporter }))] });
```

The SDK hands **one record object** to every registered processor in order,
and lets a processor modify it during `onEmit`. Two consequences:

- A processor registered **ahead of** the wrapper sees the record before it is
  redacted. If it exports, that export is unprotected.
- A processor registered **after** it sees the redacted record.

A `BatchLogRecordProcessor` keeps the very record it is given, and the SDK
makes the record read-only once `emit` returns. Redaction therefore has to
happen in `onEmit`, which is why this is a processor wrapper and not an
exporter wrapper.

## What is covered

| Covered | Not covered |
| --- | --- |
| The body: a string, or a structured body (maps, arrays, nested to the depth budget), every string in it | Spans and **metrics**. Traces have their own package, [`@redact-secret/adapter-otel-trace`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter-otel-trace); nothing protects metrics |
| Every attribute value: strings, string arrays, maps and arrays of them | Attribute and map **keys**. Do not put a secret in a key |
| `exception.message`, `exception.stacktrace` and `exception.type`, which are ordinary string attributes by the time a processor runs | The **resource** (`service.name` and the rest of the resource attributes) and the instrumentation scope (name, version, schema URL, scope attributes). They are shared by many records and are configured by the application, not written per log call |
| Severity text and, where the SDK has one, the event name | Timestamps, severity number, trace and span ids |
| Byte values (`Uint8Array`), scanned as UTF-8 text | Records the wrapped processor never receives: filtered out by `enabled()` or a logger configuration, or handed to a processor registered ahead of this one |

When the SDK is given an `exception` on `emit`, it turns it into
`exception.*` attributes before any processor runs (`emit` ignores `exception` at the
low end of the supported range, 0.200.0, and accepts it at the high end), and
those attributes are covered as above.

When a value cannot be scanned, a fixed marker replaces it. See
[`@redact-secret/adapter`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#fail-closed-markers)
for the markers.

### Structured bodies, bytes and budgets

A structured body is walked: every string leaf is scanned once and the shape
is kept. A value past a budget never reaches the core and is never passed
through: it becomes `[REDACTED:LIMIT_EXCEEDED]`.

- The budgets are the shared adapter ones (`DEFAULT_LIMITS`: depth 8, 1000
  array elements, 200 object keys, 5000 string leaves, 20 000 visited
  values, 200 000 characters per string) and are **per record**, shared by
  the body and every attribute. `limits` and `maxStringLength` override them.
- A cycle becomes `[REDACTED:CYCLE]`. A value that throws when read becomes
  `[REDACTED:ERROR]`.
- Array elements and object keys past their bound are dropped, not passed
  through, and counted as `limited`.
- A `Uint8Array` is scanned as UTF-8 text. Bytes that are not valid UTF-8
  cannot be scanned for a text secret, so they are **replaced** with
  `[REDACTED:ERROR]` (as bytes) rather than exported opaque.
- An `Error` used as a body becomes `{ type, message, stack, cause }`, redacted.
  A `toJSON()` is applied, so it cannot run later and emit unredacted text.

### A record that cannot be redacted is dropped

Redaction writes in place: `setBody`, `setSeverityText` and `setEventName`,
and the record's public `attributes` bag. (`setAttribute` is deliberately not
used to rewrite: at the low end of the range it counts the call as a further
attribute and would report a spurious `droppedAttributesCount`.) Every write
is read back, allowing only the shorter string an SDK attribute-length limit
produces. If a write does not take, the record is **dropped**: not forwarded,
and nothing is thrown at the code that logged it. This happens, for example,
when a processor hands the record on after the SDK has made it read-only, or
when an earlier processor froze the attribute bag. A one-time process warning
(`REDACT_SECRET_LOG_RECORD_DROPPED`) names the field, never its value.

If the **scanner** fails, or the core says `block`, the record is not dropped:
the value becomes `[REDACTED:ERROR]` or `[REDACTED:BLOCKED]` and the record is
forwarded. An exception thrown by the wrapped processor is not swallowed.

## Options

```js
await createRedactingLogRecordProcessor(next, { pii, onOutcome, policy, maxStringLength, limits });
```

| Option | What it does |
| --- | --- |
| `pii` | Turn on PII detection, e.g. `["pii:global"]`. See below |
| `onOutcome` | A callback with counts per log record, for your metrics. See below |
| `policy` | The core's policy, passed through unchanged |
| `maxStringLength` | Strings longer than this become `[REDACTED:LIMIT_EXCEEDED]` unscanned |
| `limits` | Per-record walk budgets, a `Partial<Limits>`. An invalid value falls back to the default |

### PII detection

The core detects credentials out of the box. PII detection is a separate,
process-wide, one-shot activation, exactly as for the other adapters; the
factory **rejects** with a fixed `code` (`PII_ACTIVATION_NOT_ACTIVE` or
`PII_ACTIVATION_UNSUPPORTED`) rather than return a processor that scans with PII
silently off. Full rules:
[PII guide](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/pii.md).

Two things to know for logs:

- **Off is the default and it passes PII through.** With PII off, an email
  address in a log body is exported as written.
- **Activation is not masking, and detection reads the string.** Under the
  default policy only `High`-confidence PII is redacted. The core's detectors
  also use the text around a value: `customer email: jane.doe@acme-corp.io`
  is redacted, while an attribute whose *key* is `user_email` and whose value
  is the bare address is not, because this package scans values and never keys.
  Put the context in the value or pass your own `policy`.

### Counting what happened

`onOutcome` reports one summary per log record. It is observational: increment
your own counters from it. This package creates no exporter or network client.

```text
{ host: "otel-logs", unit: "log-record",
  values: { scanned, findings, redacted, blocked, limited, failed },
  dropped: false }
```

- Every string leaf (body, attribute values, array elements, severity text,
  event name, bytes) is its own counted leaf. Keys are neither scanned nor
  counted.
- `dropped` is **this processor's** decision. It does not mean the record was
  filtered out, and `dropped: false` does **not** mean it was exported:
  whether the next processor kept it and whether an exporter succeeded are
  things this adapter never learns.
- The observer runs once the record has been forwarded or dropped, so it
  cannot change what is exported. Anything it throws is swallowed and never
  read. It is re-entrancy-guarded.
- The counts are defined in
  [`@redact-secret/adapter`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter#outcome-counters).

## Exports

| Export | Purpose |
| --- | --- |
| `createRedactingLogRecordProcessor(next, options?)` | Live: awaits the core's `initialize()`, wraps `next` |
| `RedactingLogRecordProcessorWith` | `new (next, scanAndRedact, options?)`, with an injected scanner |
| `OtelLogRecordOutcome`, `RedactingLogRecordProcessorOptions`, `CreateRedactingLogRecordProcessorOptions` | Types |

The wrapper also forwards `forceFlush` (and its options), `shutdown`, and the
SDK's optional `enabled()`, so wrapping a processor changes neither which
records are created nor when they flush.

## Supported versions

`@opentelemetry/sdk-logs` `>=0.200.0 <=0.222.0` and `@redact-secret/core`
`^0.1.0-beta.6`. CI runs the real-host tests at both ends of each range
(`@opentelemetry/sdk-logs` 0.200.0 and 0.222.0 today); a release in between
is inside the declared range and untested. The SDK is imported as types only.
It never enters this package's runtime graph.

The range is an explicit span, not a caret, because `sdk-logs` is a `0.x`
package: a caret on `0.200.0` would admit only that one minor. The upper bound
is the highest release tested; a newer one is unqualified until it is added as
an endpoint (`compatibility.json`). The floor is the first release of the
line that pairs with `@opentelemetry/sdk-trace-base` 2.x.

## Overhead and footprint

Measured on one machine and not a budget; see
[`docs/performance.md`](https://github.com/redact-secret/redact-secret-adapters/blob/main/docs/performance.md#opentelemetry-logs-adapter-178).

## Contributing

Issues and pull requests are welcome:
[CONTRIBUTING.md](https://github.com/redact-secret/redact-secret-adapters/blob/main/CONTRIBUTING.md).
Changes are listed in this package's `CHANGELOG.md`.

## License

MIT
