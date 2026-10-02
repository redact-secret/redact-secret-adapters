import io
import logging

from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import ConsoleSpanExporter, SimpleSpanProcessor
from redact_secret_adapters.logging_filter import RedactSecretFilter
from redact_secret_adapters.otel import create_redacting_span_processor
from verify import TOKEN, run


def stream_handler() -> tuple[logging.Handler, io.StringIO]:
    """A handler that keeps the exact text it writes. Swap it for the handler you actually use."""
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter("%(levelname)s %(name)s %(message)s"))
    return handler, stream


def logger_for(name: str, *handlers: logging.Handler) -> logging.Logger:
    logger = logging.getLogger(f"placement.{name}")
    logger.handlers[:] = list(handlers)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


# snippet:start logging-protected
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


# snippet:end logging-protected


def one_handler_unfiltered() -> str:
    # Negative control: handlers run in order and a filter runs only on its own handler,
    # so the destination without one writes plaintext. If the verifier cannot see this, it is broken.
    unfiltered, unfiltered_out = stream_handler()
    filtered, _ = stream_handler()
    filtered.addFilter(RedactSecretFilter())
    logger_for("one-unfiltered", unfiltered, filtered).warning("deploy with token %s", TOKEN)
    return unfiltered_out.getvalue()


def emit_one_span(processors) -> None:
    provider = TracerProvider()
    for processor in processors:
        provider.add_span_processor(processor)
    with provider.get_tracer("placement").start_as_current_span(f"deploy {TOKEN}") as span:
        span.set_attribute("llm.input_messages", f"deploy with token {TOKEN}")
        span.add_event("tool_call", {"tool.args": f"Bearer {TOKEN}"})
    provider.shutdown()


def span_destinations() -> tuple[str, str]:
    guarded, ahead = io.StringIO(), io.StringIO()
    # snippet:start otel-placement
    emit_one_span(
        [
            # Control: a processor registered AHEAD of the redacting one sees the span before it is redacted.
            SimpleSpanProcessor(ConsoleSpanExporter(out=ahead)),
            # Wrap the processor that feeds the exporter. The redacting processor goes around it, not beside it.
            create_redacting_span_processor(SimpleSpanProcessor(ConsoleSpanExporter(out=guarded))),
        ]
    )
    # snippet:end otel-placement
    return guarded.getvalue(), ahead.getvalue()


_spans = span_destinations()

if __name__ == "__main__":
    run(
        [
            ("logging: two filtered handlers, both destinations", False, every_handler_filtered),
            ("logging: child logger propagating to a filtered handler", False, propagated_child_record),
            ("logging: a handler without the filter", True, one_handler_unfiltered),
            ("otel traces: exporter behind create_redacting_span_processor()", False, lambda: _spans[0]),
            ("otel traces: exporter on a processor registered ahead of the redacting one", True, lambda: _spans[1]),
        ]
    )
