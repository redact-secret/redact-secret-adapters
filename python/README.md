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
`stack_info`, and redacts any `extra_fields=[...]` you name.

Attach it to each emitting **handler**: ancestor logger filters do not run for
propagated child records.

`RedactSecretFilter(scan_and_redact, ...)` accepts an injected scanner; with no
argument it uses `redact_secret.scan_and_redact`.

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
