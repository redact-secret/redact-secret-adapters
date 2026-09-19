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

## OpenTelemetry (`[otel]` extra) — not working yet

`redact_secret_adapters.otel` is included but **does not work against a real
SDK**: `opentelemetry-sdk` 1.44.0 freezes a span's attributes before `on_end`
runs, so in-place redaction raises `TypeError`. `tests/test_otel_host.py`
records this as a strict expected failure. The extra has no version range, and
is not a supported integration, until that test passes.

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
