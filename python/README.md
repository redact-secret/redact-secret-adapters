# redact-secret-adapters

Host integrations for [Redact Secret](https://github.com/redact-secret/redact-secret)
in Python: value-based redaction for the standard library's `logging`, plus the
shared fail-closed walker.

```bash
pip install redact-secret redact-secret-adapters
```

## `logging`

```python
import logging
from redact_secret_adapters.logging_filter import RedactSecretFilter

handler = logging.StreamHandler()
handler.addFilter(RedactSecretFilter())
logging.getLogger().addHandler(handler)
```

The filter formats `msg` with `args` before scanning, then clears the
arguments so a downstream formatter cannot rebuild the original. It replaces
`exc_info` with redacted traceback text, scans cached `exc_text` and
`stack_info`, and redacts any `extra_fields=[...]` you name: a string extra is
masked, and a dict/list/tuple extra is walked and replaced by a masked copy.
If the message cannot be formatted (a bad `%` format, a raising `__str__`), it
becomes `[REDACTED:ERROR]` rather than raising into the logging call.

`RedactSecretFilter(scan_and_redact, ...)` accepts an injected scanner; with no
argument it uses `redact_secret.scan_and_redact`.

### Where to attach it

A `logging.Filter` runs **only where it is attached**. In an application with
more than one handler, placement is the security decision, not the filter. The
supported setup is one line per emitting handler:

```python
import logging
from redact_secret_adapters.logging_filter import RedactSecretFilter

console = logging.StreamHandler()
audit = logging.FileHandler("audit.log")

redact = RedactSecretFilter()  # no per-record state: one instance can be shared
for handler in (console, audit):
    handler.addFilter(redact)  # every emitting handler, not the logger
    logging.getLogger().addHandler(handler)
```

This is not global automatic protection. A handler added anywhere else — by a
library, by `logging.basicConfig`, by a child logger of your own — is
unprotected until it, too, carries the filter.

| Placement | Covers | Leaves unprotected |
| --- | --- | --- |
| Every emitting **handler** (supported) | that handler, and any handler that runs after it on the same record | a handler attached later without the filter |
| A **handler** on an ancestor logger | records that propagate to it, including from child loggers | a handler the child carries itself |
| A **logger** | records logged directly on that logger | records **propagated** from child loggers — `Logger.filter` never runs for an ancestor |
| The `QueueListener`'s sink handler | the final destination | the record while it sits on the queue, and anywhere a `QueueHandler` subclass sends it (a socket, a `multiprocessing` queue) |

Handlers run in the order they were added and the filter mutates the record in
place, so a filtered handler also protects every handler after it — and an
**unfiltered handler that runs before it emits plaintext**. Do not rely on
order: filter each one.

For a `QueueHandler`/`QueueListener` pair, attach the filter to the
**`QueueHandler`**. It runs in the emitting thread, so only masked records
cross the queue:

```python
handler = logging.handlers.QueueHandler(records)
handler.addFilter(RedactSecretFilter())
listener = logging.handlers.QueueListener(records, logging.StreamHandler())
```

`python/tests/test_logging_placement.py` asserts each supported placement and,
as synthetic negative controls, that plaintext really does escape each wrong
one.

The filter changes nothing else about your configuration: each handler keeps
its own formatter, named `extra_fields` still render, exception logging still
works, and a record with no finding is formatted byte-for-byte as it would be
without the filter. Masking an already-masked record again is a no-op, so two
filtered handlers on one record are safe. What the filter does **not** cover:
record attributes you did not name in `extra_fields`, and anything a custom
formatter adds after it runs.

## Masking callbacks (Langfuse and similar)

```python
from redact_secret_adapters.mask_secrets import mask_secrets

langfuse = Langfuse(mask=mask_secrets)
```

## Fail-closed markers

| Marker | When |
| --- | --- |
| `[REDACTED:BLOCKED]` | A `block` finding — the **entire** leaf is replaced |
| `[REDACTED:ERROR]` | Any exception from the core. Never the input, never the exception's message |
| `[REDACTED:LIMIT_EXCEEDED]` | A value past a walk budget; never scanned, never passed through |
| `[REDACTED:CYCLE]` | A self-referencing object |

`DEFAULT_LIMITS`: `max_depth` 8, `max_array_length` 1000, `max_object_keys` 200,
`max_string_length` 200000, `max_total_leaves` 5000.

## OpenTelemetry (`[otel]` extra)

```python
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from redact_secret_adapters.otel import create_redacting_span_processor

provider = TracerProvider()
provider.add_span_processor(create_redacting_span_processor(BatchSpanProcessor(otlp_exporter)))
```

A span's name and status description, every string and string-sequence
attribute (a `None` inside a sequence stays in place), every event's name and
attributes, and every link's attributes are redacted before the span reaches
the next processor, including OpenInference and GenAI semantic-convention
attributes, without hardcoding either convention's attribute list.

`opentelemetry-sdk` has no public way to change a span before export, so the
adapter writes the private fields behind the read-only accessors (`_name`,
`_status`, `_attributes` and its backing `_dict`) and reads each write back
through the public accessor. If an SDK release moves one of those fields, the
span is **dropped** rather than exported unredacted, and a `RuntimeWarning` is
issued once per processor. See `redact_secret_adapters.otel` for details.

Supported range: `opentelemetry-sdk>=1.16.0,<2` — CI runs
`tests/test_otel_host.py`, a real `TracerProvider`/exporter round trip, at
both ends of that range on every run.

## Development

```bash
pip install -e "./python[otel,test]"
pytest
```

The fixture tests read the same JSON files in the repository's `fixtures/`
directory as the TypeScript suite; that shared file is what keeps the two
languages equivalent.

## License

MIT
