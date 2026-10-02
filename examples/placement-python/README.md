# Placement verification: Python logging and OpenTelemetry

In Python the filter runs only on the handler it is attached to. This recipe sends a fixed
synthetic credential through real `logging` handlers and a real OpenTelemetry tracer into
captured memory, then checks the final text. It also runs **negative controls**: paths that
are deliberately unprotected, which the verifier must flag. If it ever reports a control as
protected, the verifier is broken.

- Runtime: Python 3.10 or later.
- Installs: `redact-secret-adapters[otel]` 0.1.3, `redact-secret` 0.1.0b12 (a beta, pinned exactly), `opentelemetry-sdk` 1.45.0.
- Everything stays in memory. Nothing contacts a collector, a log service or a production endpoint.

## Run it

Copy this folder out of the repository first (see [how](../README.md#run-one)), then:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

## What the verifier decides

It only looks at captured output:

<!-- snippet: examples/placement-python/verify.py#verdict -->
```python
def verdict(captured: str) -> str:
    """LEAKED: the synthetic credential is in the captured output.
    UNVERIFIED: nothing was captured, or no sanitized placeholder is in it, so nothing was proven.
    PROTECTED: output exists, the credential is absent, and a sanitized placeholder is present.
    """
    if TOKEN in captured:
        return "LEAKED"
    if not captured or not _PLACEHOLDER.search(captured):
        return "UNVERIFIED"
    return "PROTECTED"
```

A pipeline that drops all output is `UNVERIFIED`, not `PROTECTED`. The report prints a label, a
verdict and a placeholder count, never the captured text.

## The paths

Several handlers, and a child logger whose record propagates to a handler on its parent:

<!-- snippet: examples/placement-python/main.py#logging-protected -->
```python
def every_handler_filtered() -> str:
    console, console_out = stream_handler()
    audit, audit_out = stream_handler()
    for handler in (console, audit):
        handler.addFilter(RedactSecretFilter())  # one filter per handler that writes somewhere
    logger_for("every-handler", console, audit).warning("deploy with token %s", TOKEN)
    return console_out.getvalue() + audit_out.getvalue()  # both destinations are checked


def propagated_child_record() -> str:
    handler, out = stream_handler()
    handler.addFilter(RedactSecretFilter())
    parent = logger_for("propagation", handler)
    child = logging.getLogger(f"{parent.name}.child")  # no handler of its own: the parent's handler emits
    child.warning("deploy with token %s", TOKEN)
    return out.getvalue()
```

The control is a logger with one filtered and one **unfiltered** handler: the unfiltered one writes
plaintext. OpenTelemetry traces use one provider and two destinations; the registration order decides
which is protected:

<!-- snippet: examples/placement-python/main.py#otel-placement -->
```python
emit_one_span(
    [
        # Control: a processor registered AHEAD of the redacting one sees the span before it is redacted.
        SimpleSpanProcessor(ConsoleSpanExporter(out=ahead)),
        # Wrap the processor that feeds the exporter. The redacting processor goes around it, not beside it.
        create_redacting_span_processor(SimpleSpanProcessor(ConsoleSpanExporter(out=guarded))),
    ]
)
```

The exporter is OpenTelemetry's `ConsoleSpanExporter` writing each span's JSON to a string, so the check
covers supported exporter serialization and not just a callback.

## Expected output

<!-- expected-output -->
```text
ok   protected PROTECTED  logging: two filtered handlers, both destinations (2 placeholders)
ok   protected PROTECTED  logging: child logger propagating to a filtered handler (1 placeholders)
ok   control   LEAKED     logging: a handler without the filter (0 placeholders)
ok   protected PROTECTED  otel traces: exporter behind create_redacting_span_processor() (3 placeholders)
ok   control   LEAKED     otel traces: exporter on a processor registered ahead of the redacting one (0 placeholders)
OK: every protected path passed and every negative control was detected (tested paths only)
```

`ok` on a `control` row means the leak **was** detected. A `FAIL` row, or a final `FAIL:` line with a
non-zero exit code, means a protected path leaked or a control was not seen.

## Adapt it to your topology

1. Replace the handler and logger setup in `main.py` with the one your application really builds: your
   handlers, your `QueueHandler`/`QueueListener` pair, your logger hierarchy, your provider and
   processors. Attach the filter exactly where the application does.
2. Keep every destination in memory. Do not send the synthetic token to a real endpoint.
3. Keep `TOKEN` synthetic. Never put a real credential into this verifier.
4. Add a control for each path you worry about: the same calls through a handler or processor list built
   without the adapter. A recipe with no control proves little.

## What a pass means

A `PROTECTED` row means: for **this** pipeline, built **this** way, with **this** synthetic value, the
captured text held no trace of it and held a sanitized placeholder. It does not certify other handlers,
transports, processors, later configuration changes or other values. Detection is the core's, and a clean
result is not proof an input held no secret.

What the adapter covers and does not: the [Python guide](../../python#where-to-attach-it). The real-host
tests this recipe mirrors are `python/tests/test_logging_placement.py` and `python/tests/test_otel_host.py`.
If a row is not what you expected, see [troubleshooting](../../docs/troubleshooting.md).
