"""Real-host lifecycle qualification for the ``otel`` extra (#11): the
simple and batch span processors, span events, string and string-sequence
attributes, concurrent spans from threads, exporter failure, and the
provider/processor shutdown lifecycle. CI runs this at both ends of the
declared ``opentelemetry-sdk`` range, like ``test_otel_host.py``.

Every span carries its own id and its own synthetic secret, so an exported
span holding another span's id, a block marker it did not ask for, or any
``SECRET_TOKEN_`` text is cross-span leakage.

Skipped when ``opentelemetry-sdk`` is not installed.
"""

from __future__ import annotations

import logging
import re
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest

pytest.importorskip("opentelemetry.sdk.trace")

from fake_scanner import fake_scan_and_redact  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import (  # noqa: E402
    BatchSpanProcessor,
    SimpleSpanProcessor,
    SpanExporter,
    SpanExportResult,
)
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter  # noqa: E402

from redact_secret_adapters.otel import RedactingSpanProcessorWith  # noqa: E402

_TOKEN = "SECRET_TOKEN" + "_"
_PLAINTEXT = re.compile(r"SECRET_TOKEN_\d|BLOCK_ME")
THREADS = 8
SPANS_PER_THREAD = 40


def _emit_concurrently(provider: TracerProvider) -> int:
    tracer = provider.get_tracer("redact-secret-adapters-lifecycle-test")
    start = threading.Barrier(THREADS)

    def emit(thread: int) -> None:
        start.wait()
        for index in range(SPANS_PER_THREAD):
            span_id = f"{thread}-{index}"
            span = tracer.start_span(f"op {span_id}")
            span.set_attribute("span.id", span_id)
            span.set_attribute("input.value", f"prompt {span_id} with {_TOKEN}{thread}{index}")
            span.set_attribute("llm.tags", [f"tag {span_id}", _TOKEN + "7"])
            span.set_attribute("retries", index)
            if (thread * SPANS_PER_THREAD + index) % 5 == 0:
                span.set_attribute("guard", "BLOCK_ME")
            span.add_event(f"tool {span_id}", {"tool.args": f"args {span_id} {_TOKEN}3", "tool.list": [_TOKEN + "4"]})
            span.end()

    with ThreadPoolExecutor(max_workers=THREADS) as pool:
        list(pool.map(emit, range(THREADS)))
    return THREADS * SPANS_PER_THREAD


def _assert_no_cross_span_leak(spans, emitted: int) -> None:
    assert len(spans) == emitted
    seen = set()
    for span in spans:
        span_id = span.attributes["span.id"]
        seen.add(span_id)
        thread, index = (int(part) for part in span_id.split("-"))
        expected = {
            "span.id": span_id,
            "input.value": f"prompt {span_id} with <SECRET_1>",
            "llm.tags": (f"tag {span_id}", "<SECRET_1>"),
            "retries": index,
        }
        if (thread * SPANS_PER_THREAD + index) % 5 == 0:
            expected["guard"] = "[REDACTED:BLOCKED]"
        assert span.name == f"op {span_id}"
        assert dict(span.attributes) == expected
        assert [(event.name, dict(event.attributes)) for event in span.events] == [
            (f"tool {span_id}", {"tool.args": f"args {span_id} <SECRET_1>", "tool.list": ("<SECRET_1>",)})
        ]
        assert not _PLAINTEXT.search(span.to_json())
    assert len(seen) == emitted


@pytest.mark.parametrize("processor", ["simple", "batch"])
def test_concurrent_spans_are_exported_redacted_with_no_cross_span_leakage(processor: str) -> None:
    exporter = InMemorySpanExporter()
    inner = (
        SimpleSpanProcessor(exporter)
        if processor == "simple"
        else BatchSpanProcessor(exporter, max_queue_size=4096, max_export_batch_size=64, schedule_delay_millis=5)
    )
    provider = TracerProvider()
    provider.add_span_processor(RedactingSpanProcessorWith(inner, fake_scan_and_redact))
    emitted = _emit_concurrently(provider)
    assert provider.force_flush()
    _assert_no_cross_span_leak(exporter.get_finished_spans(), emitted)
    provider.shutdown()


class _FailingExporter(SpanExporter):
    """Records what it was handed, then fails while echoing it."""

    def __init__(self, mode: str) -> None:
        self.mode = mode
        self.received: list[str] = []

    def export(self, spans):
        echoed = "\n".join(span.to_json() for span in spans)
        self.received.append(echoed)
        if self.mode == "raise":
            raise RuntimeError(f"exporter crashed on {echoed}")
        return SpanExportResult.FAILURE

    def shutdown(self) -> None:
        pass


@pytest.mark.parametrize("processor", ["simple", "batch"])
@pytest.mark.parametrize("mode", ["result", "raise"])
def test_a_failing_exporter_only_saw_and_only_reports_redacted_spans(
    processor: str, mode: str, caplog: pytest.LogCaptureFixture
) -> None:
    exporter = _FailingExporter(mode)
    inner = SimpleSpanProcessor(exporter) if processor == "simple" else BatchSpanProcessor(exporter)
    provider = TracerProvider()
    provider.add_span_processor(RedactingSpanProcessorWith(inner, fake_scan_and_redact))

    with caplog.at_level(logging.DEBUG):
        span = provider.get_tracer("redact-secret-adapters-lifecycle-test").start_span("export " + _TOKEN + "1")
        span.set_attribute("auth", "Bearer " + _TOKEN + "2")
        span.add_event("retry", {"tokens": [_TOKEN + "3"]})
        span.end()
        provider.force_flush()
        provider.shutdown()

    assert "<SECRET_1>" in "".join(exporter.received)
    reported = "\n".join(exporter.received)
    for record in caplog.records:
        reported += "\n" + record.getMessage()
        if record.exc_info:
            reported += "\n" + logging.Formatter().formatException(record.exc_info)
    assert not _PLAINTEXT.search(reported)
    if mode == "raise":
        # The SDK logs the exporter's exception, message included, which is
        # exactly why the span must already be redacted when it gets there.
        assert any(record.exc_info for record in caplog.records)


def test_shutdown_and_force_flush_reach_the_wrapped_processor_and_later_spans_are_not_exported() -> None:
    calls: list[object] = []
    exporter = InMemorySpanExporter()
    inner = SimpleSpanProcessor(exporter)

    class Recording:
        def on_start(self, span, parent_context=None):
            inner.on_start(span, parent_context)

        def on_end(self, span):
            inner.on_end(span)

        def force_flush(self, timeout_millis=30000):
            calls.append(("force_flush", timeout_millis))
            return inner.force_flush(timeout_millis)

        def shutdown(self):
            calls.append("shutdown")
            inner.shutdown()

    provider = TracerProvider()
    provider.add_span_processor(RedactingSpanProcessorWith(Recording(), fake_scan_and_redact))
    tracer = provider.get_tracer("redact-secret-adapters-lifecycle-test")
    tracer.start_span("before " + _TOKEN + "1").end()
    assert provider.force_flush(1234)
    exported = [span.name for span in exporter.get_finished_spans()]
    provider.shutdown()
    tracer.start_span("after " + _TOKEN + "2").end()

    # The SDK's multi-processor forwards what is left of the caller's deadline.
    assert [call if call == "shutdown" else call[0] for call in calls] == ["force_flush", "shutdown"]
    assert 0 < calls[0][1] <= 1234
    assert exported == ["before <SECRET_1>"]
    assert [span.name for span in exporter.get_finished_spans()] == ["before <SECRET_1>"]


def test_a_scanner_failure_on_one_span_never_affects_the_next() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(RedactingSpanProcessorWith(SimpleSpanProcessor(exporter), fake_scan_and_redact))
    tracer = provider.get_tracer("redact-secret-adapters-lifecycle-test")
    first = tracer.start_span("first")
    first.set_attribute("payload", "BOOM " + _TOKEN + "1")
    first.end()
    second = tracer.start_span("second")
    second.set_attribute("payload", "ok " + _TOKEN + "2")
    second.end()
    assert [span.attributes["payload"] for span in exporter.get_finished_spans()] == [
        "[REDACTED:ERROR]",
        "ok <SECRET_1>",
    ]
    provider.shutdown()
