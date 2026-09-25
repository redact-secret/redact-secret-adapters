"""Exercises the live wrappers against the real installed ``redact_secret``.
Detection itself is the core's job and is tested there; these push one
synthetic token the core is known to detect through each wrapper, so a
wrapper that silently skipped the core would fail.
"""

from __future__ import annotations

import logging

import pytest

pytest.importorskip("redact_secret")

from redact_secret_adapters.logging_filter import RedactSecretFilter  # noqa: E402
from redact_secret_adapters.mask_secrets import mask_secrets  # noqa: E402

# A GitHub-token-shaped placeholder: the right prefix and length, obviously
# not a credential. Split so the whole token never appears in this source.
_FAKE_TOKEN = "ghp_" + "x" * 36


def test_mask_secrets_uses_the_real_core() -> None:
    data = {"role": "user", "content": ["hello", "token " + _FAKE_TOKEN], "count": 2}
    assert mask_secrets(data=data) == {"role": "user", "content": ["hello", "token <SECRET_1>"], "count": 2}


def test_filter_without_arguments_uses_the_real_core() -> None:
    record = logging.makeLogRecord({"msg": "user %s sent %s", "args": ("alice", _FAKE_TOKEN)})
    assert RedactSecretFilter().filter(record) is True
    assert record.getMessage() == "user alice sent <SECRET_1>"


def test_span_processor_factory_uses_the_real_core() -> None:
    pytest.importorskip("opentelemetry.sdk.trace")
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import SimpleSpanProcessor
    from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

    from redact_secret_adapters.otel import create_redacting_span_processor

    exporter = InMemorySpanExporter()
    provider = TracerProvider()
    provider.add_span_processor(create_redacting_span_processor(SimpleSpanProcessor(exporter)))
    span = provider.get_tracer("redact-secret-adapters-live-test").start_span("call")
    span.set_attribute("input.value", "token " + _FAKE_TOKEN)
    span.end()
    (exported,) = exporter.get_finished_spans()
    assert exported.attributes["input.value"] == "token <SECRET_1>"
    provider.shutdown()
