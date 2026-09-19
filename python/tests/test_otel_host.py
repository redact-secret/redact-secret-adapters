"""The real-host test for the ``otel`` extra: a real span from a real
``TracerProvider``, read back from a real in-memory exporter.

``ReadableSpan.attributes`` is a read-only ``MappingProxyType``; the
processor reaches into the private ``_attributes`` field instead. If an SDK
version renames that field or hands ``on_end`` a copy, the processor becomes
a silent no-op and plaintext reaches the exporter with no error anywhere.
The duck-typed tests in ``test_otel.py`` cannot see that; this one can.

KNOWN FAILURE, recorded as a strict ``xfail``: against opentelemetry-sdk
1.44.0 -- the version the original example claimed to be pinned against --
``Span.end()`` sets ``self._attributes._immutable = True`` *before* calling
``on_end``, so the processor's ``attributes[key] = ...`` raises ``TypeError``
out of the host application's ``span.end()``. The example this module was
ported from was only ever tested with plain-dict stand-ins. The ``otel``
extra therefore does not work yet, and its version range in
``pyproject.toml`` stays a TODO until this test passes at both ends of one.
``strict=True`` makes the suite fail the moment this starts passing, so the
marker cannot outlive the defect.

Skipped when ``opentelemetry-sdk`` is not installed.
"""

from __future__ import annotations

import json

import pytest

pytest.importorskip("opentelemetry.sdk.trace")

from fake_scanner import fake_scan_and_redact  # noqa: E402
from opentelemetry.sdk.trace import TracerProvider  # noqa: E402
from opentelemetry.sdk.trace.export import SimpleSpanProcessor  # noqa: E402
from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter  # noqa: E402

from redact_secret_adapters.otel import RedactingSpanProcessorWith  # noqa: E402


@pytest.mark.xfail(
    strict=True,
    raises=TypeError,
    reason="opentelemetry-sdk freezes Span._attributes before on_end; in-place redaction raises TypeError",
)
def test_a_real_spans_attributes_are_actually_mutated_before_the_exporter_sees_them() -> None:
    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(RedactingSpanProcessorWith(SimpleSpanProcessor(exporter), fake_scan_and_redact))
    tracer = provider.get_tracer("redact-secret-adapters-host-test")

    span = tracer.start_span("llm-call")
    span.set_attribute("llm.input_messages", "call SECRET_TOKEN_1 now")
    span.set_attribute("llm.tags", ["ok", "BLOCK_ME here"])
    span.set_attribute("retry.count", 3)
    span.set_attribute("retry.ok", True)
    span.set_attribute("boom", "trigger BOOM here")
    span.add_event("tool_call", {"tool.args": "value SECRET_TOKEN_2 done"})
    span.end()
    provider.force_flush()

    (exported,) = exporter.get_finished_spans()
    assert dict(exported.attributes) == {
        "llm.input_messages": "call <SECRET_1> now",
        "llm.tags": ("ok", "[REDACTED:BLOCKED]"),
        "retry.count": 3,
        "retry.ok": True,
        "boom": "[REDACTED:ERROR]",
    }
    assert [dict(event.attributes) for event in exported.events] == [{"tool.args": "value <SECRET_1> done"}]

    serialized = exported.to_json() + json.dumps([dict(event.attributes) for event in exported.events])
    for plaintext in ("SECRET_TOKEN_1", "SECRET_TOKEN_2", "BLOCK_ME", "BOOM", "simulated core failure"):
        assert plaintext not in serialized

    provider.shutdown()
