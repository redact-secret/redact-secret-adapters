---
decision_id: decision-otel-logs-adapter-design-and-sdk-probe
status: accepted
scope: adapters
title: A separate OpenTelemetry Logs adapter, and the SDK endpoints it is qualified against
decided_at: 2026-10-01
issue: redact-secret/redact-secret-adapters#178
---
# A separate OpenTelemetry Logs adapter, and the SDK endpoints it is qualified against

## Decision

Add **`@redact-secret/adapter-otel-logs`** as a separate, optional JavaScript
package: a `LogRecordProcessor` wrapper over `@opentelemetry/sdk-logs`. It lands
on `develop` unreleased (`"private": true`, absent from `PACKAGES`), the way
`adapter-ai-context`, `adapter-mcp` and `adapter-otel-trace` did, so no train
plans it and nothing advertises it as installable. Python is a separate,
later scope.

- No change to `@redact-secret/adapter` or the core, and no logging SDK
  dependency in either. The package depends on the released
  `@redact-secret/adapter` `^0.1.7` (`^0.1.5` is the first line whose `Limits` carry
  `maxNodes`) and declares `@redact-secret/core` `^0.1.0-beta.6` like every
  other package.
- `adapter-otel-trace` is not touched, and its docs still say it does not
  protect Logs.

## Capability probe

Released `@opentelemetry/sdk-logs` versions inspected on 2026-10-01 (every
release from `0.200.0` to `0.222.0`, the line paired with the `2.x`
OpenTelemetry JS packages; `0.222.0` is `latest`, `0.300.0-development.0` is a
canary and is not considered):

| Capability | Finding | Consequence |
| --- | --- | --- |
| Where a record can be changed | `Logger.emit` builds the record, calls `onEmit(record, context)` on the active processor, and only then marks it read-only. The SDK states a processor "may freely modify logRecord for the duration of the OnEmit call". | Redact in `onEmit`, before delegating. A `BatchLogRecordProcessor` keeps the object it is given, so there is no later moment to redact. |
| Supported write API | `setBody`, `setSeverityText`, `setSeverityNumber`, `setAttribute`, `setAttributes` on every release; `setEventName` and `eventName` only on the high end. | Use the setters for body, severity text and event name. |
| `setAttribute` as a rewrite | At `0.200.0` it increments the record's total attribute count on every call, so rewriting an existing key would export `droppedAttributesCount: 1`. | Rewrite attribute values through the public `attributes` bag, read the value back, and test that `droppedAttributesCount` stays 0 at both endpoints. This is public, not private, SDK surface; there is no supported "replace attribute" call. |
| Record type | `LogRecord` (a class) at `0.200.0`, `ReadWriteLogRecord` (an interface) at `0.222.0`; the `LogRecordProcessor.onEmit` parameter type differs accordingly. | Take the parameter type from `Parameters<LogRecordProcessor["onEmit"]>` and describe the slice used structurally, so one source typechecks at both ends. |
| `forceFlush`, `enabled` | `forceFlush()` takes no argument at the low end and `ForceFlushOptions` at the high end; `enabled()` exists at the high end and the SDK asks processors before creating a record. | Forward `forceFlush` arguments untouched; forward `enabled`, defaulting to enabled, so wrapping changes neither flushing nor which records exist. |
| `exception` on `emit` | Accepted at the high end (turned into `exception.message`, `.stacktrace`, `.type` attributes before processors run); ignored at `0.200.0`. | Exceptions are covered as ordinary string attributes, and the tests assert on whatever the installed SDK produces. |
| Host constructors | `new LoggerProvider({ processors })` from `0.201`; `addLogRecordProcessor` through `0.202`. `new BatchLogRecordProcessor(exporter, config)` through `0.219`, `new BatchLogRecordProcessor({ exporter, ...config })` from `0.220`. | Host API, not ours. The wrapper takes any processor. The tests detect the shape; the README documents both. |
| Serialization | `@opentelemetry/otlp-transformer`'s `JsonLogsSerializer` serializes `ReadableLogRecord[]` at both ends. | Assert on the serialized bytes of a real Simple and Batch processor, not only on the in-memory record. |

### Endpoints

The peer range is `>=0.200.0 <=0.222.0`, not a caret: a caret on a `0.x` version
admits one minor only. CI installs both endpoints (`0.200.0` and `0.222.0`)
with `npm run range-endpoint` and runs the real-host tests at each; a release
between them is inside the declared range and untested, as with the MCP SDK
ranges. A newer release is unqualified until it becomes an endpoint in
`compatibility.json`. `0.200.0` is the floor because it is the first release
of the line that pairs with the `2.x` packages `adapter-otel-trace` already
declares; earlier `0.x` releases pair with the `1.x` line.

## Behavior decisions (the issue's scope list)

- **Structured bodies.** Walked: every string leaf, in maps and arrays, is
  scanned once and the shape is kept. Bytes are scanned as UTF-8; bytes that are
  not valid UTF-8 cannot be scanned and are replaced, not exported opaque.
- **Block and core failures.** Per value: `[REDACTED:BLOCKED]` and
  `[REDACTED:ERROR]`, the shared markers. The record is still forwarded, as for
  spans, because losing a log record for a scanner fault is worse than a
  marker, and no plaintext leaves either way.
- **Immutable records.** Every write is read back. A record that will not take a
  write is dropped with a one-time warning naming the field, never its value.
  The test hands the processor a record after the SDK made it read-only.
- **Operation budgets.** The shared `DEFAULT_LIMITS`, per record, shared by the
  body and every attribute; past a budget a value is `[REDACTED:LIMIT_EXCEEDED]`.
- **Lifecycle.** `forceFlush`, `shutdown` and `enabled` are forwarded. An
  exception from the wrapped processor is not swallowed.
- **Outcome reporting.** One input-free summary per record
  (`{ host: "otel-logs", unit: "log-record", values, dropped }`), the shared
  contract. `dropped` is this processor's decision only.

## What is not claimed

- Resource attributes, instrumentation scope, attribute and map keys, trace and
  span ids, timestamps and severity number are not scanned.
- The SDK shares one record object between processors in registration order. A
  raw exporter registered ahead of the wrapper sees the unredacted record; this
  is documented and tested, not hidden.
- The adapter detects nothing. Whether a bare value is recognized (an email in
  an attribute whose key says "email") is the core's decision, and the adapter
  scans values, never keys.
- Python (`opentelemetry-sdk` logs) is out of scope here.

## Release consequences

Wiring it in later follows `RELEASING.md § A brand-new npm package`: drop
`"private"`, add the `PACKAGES` entry, the publish job, rehearsal dry run, tag
and report rows and release notes, and publish `0.1.0` by hand once. None of
that is done by this change.
