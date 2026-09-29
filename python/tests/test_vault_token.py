"""Coexistence with ``@redact-secret/vault``
(redact-secret/redact-secret-adapters#52), mirroring
``packages/adapter/test/vault-token.test.ts``.

The vault ships from the sibling ``redact-secret-vault`` repository and
is **not** a dependency of this one. It replaces a detected secret with a
``<rsv_…>`` token on the way to a model and restores the original value
afterwards, so an adapter that rewrote a token would not leak anything -- it
would destroy a value the application still needs, and ``restore()`` would
answer ``RESTORE_DENIED`` with nothing to point at. Only the shape of the
token is reproduced here, from the shared
``fixtures/vault-token-cases.json``.

The live tests need the real ``redact_secret``; the boundary tests do not,
because the two paths they pin (``max_string_length`` and a raising core)
belong to this package and never reach the core at all.
"""

from __future__ import annotations

import logging
import unittest

import pytest
from fake_scanner import fake_scan_and_redact
from vault_token import VAULT_TOKEN, VAULT_TOKEN_CONTEXTS, VAULT_TOKEN_LITERAL

from redact_secret_adapters.mask_leaf import (
    BLOCK_MARKER,
    CYCLE_MARKER,
    ERROR_MARKER,
    LIMIT_MARKER,
    mask_leaf_with,
)
from redact_secret_adapters.mask_secrets import mask_secrets_with


def _raises(text: str, policy=None):
    raise RuntimeError("simulated core failure - must never surface to a caller")


class VaultTokenPreservationTest(unittest.TestCase):
    """The real core leaves a vault-shaped token alone, in every adversarial context."""

    def setUp(self) -> None:
        pytest.importorskip("redact_secret")

    def test_every_adversarial_context_survives_mask_secrets(self) -> None:
        from redact_secret_adapters.mask_secrets import mask_secrets

        for name, text in VAULT_TOKEN_CONTEXTS:
            with self.subTest(context=name):
                self.assertEqual(mask_secrets(data=text), text)

    def test_a_token_survives_every_position_the_walker_reaches(self) -> None:
        from redact_secret_adapters.mask_secrets import mask_secrets

        data = {
            "api_key": VAULT_TOKEN,
            "content": ['Client(api_key="' + VAULT_TOKEN + '")', {"nested": {"deep": VAULT_TOKEN}}],
            "headers": {"Authorization": "Bearer " + VAULT_TOKEN},
            "count": 2,
        }
        self.assertEqual(mask_secrets(data=data), data)

    def test_a_token_survives_the_logging_filter(self) -> None:
        from redact_secret_adapters.logging_filter import RedactSecretFilter

        record = logging.makeLogRecord({"msg": "api_key=%s", "args": (VAULT_TOKEN,)})
        self.assertTrue(RedactSecretFilter().filter(record))
        self.assertEqual(record.getMessage(), "api_key=" + VAULT_TOKEN)

    def test_a_token_survives_the_span_processor(self) -> None:
        pytest.importorskip("opentelemetry.sdk.trace")
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import SimpleSpanProcessor
        from opentelemetry.sdk.trace.export.in_memory_span_exporter import InMemorySpanExporter

        from redact_secret_adapters.otel import create_redacting_span_processor

        exporter = InMemorySpanExporter()
        provider = TracerProvider()
        provider.add_span_processor(create_redacting_span_processor(SimpleSpanProcessor(exporter)))
        tracer = provider.get_tracer("redact-secret-adapters-vault-token-test")
        for _name, text in VAULT_TOKEN_CONTEXTS:
            span = tracer.start_span(text)
            span.set_attribute("input.value", text)
            span.end()
        exported = exporter.get_finished_spans()
        self.assertEqual([span.name for span in exported], [text for _name, text in VAULT_TOKEN_CONTEXTS])
        for span, (name, text) in zip(exported, VAULT_TOKEN_CONTEXTS):
            with self.subTest(context=name):
                self.assertEqual(span.attributes["input.value"], text)
        provider.shutdown()


class VaultTokenKnownBoundaryTest(unittest.TestCase):
    """The two paths where a token legitimately does **not** survive.

    Both are this package's documented fail-closed behaviour, not a bug. They
    are asserted so a reader finds them stated here rather than discovering
    them from a value that can no longer be restored.
    """

    def test_a_leaf_past_max_string_length_loses_the_token(self) -> None:
        text = 'Client(api_key="' + VAULT_TOKEN + '")'
        masked = mask_leaf_with(fake_scan_and_redact, text, max_string_length=len(text) - 1)
        self.assertEqual(masked, LIMIT_MARKER)

    def test_a_core_failure_loses_the_token(self) -> None:
        masked = mask_leaf_with(_raises, 'Client(api_key="' + VAULT_TOKEN + '")')
        self.assertEqual(masked, ERROR_MARKER)

    def test_the_same_two_boundaries_through_the_walker(self) -> None:
        text = 'Client(api_key="' + VAULT_TOKEN + '")'
        limited = mask_secrets_with(fake_scan_and_redact, {"arg": text}, limits={"max_string_length": len(text) - 1})
        self.assertEqual(limited, {"arg": LIMIT_MARKER})
        failed = mask_secrets_with(_raises, {"arg": text})
        self.assertEqual(failed, {"arg": ERROR_MARKER})


class VaultTokenPlaceholderTest(unittest.TestCase):
    """No default this package ships may emit the literal the vault refuses.

    ``@redact-secret/vault`` rejects any input that already holds ``rsv_``
    (``TOKEN_LITERAL_IN_INPUT``), so a marker or placeholder carrying one
    would make the next capture unusable.
    """

    def test_the_literal_is_what_the_vault_refuses(self) -> None:
        self.assertEqual(VAULT_TOKEN_LITERAL, "rsv_")

    def test_no_marker_contains_the_literal(self) -> None:
        for marker in (BLOCK_MARKER, ERROR_MARKER, LIMIT_MARKER, CYCLE_MARKER):
            with self.subTest(marker=marker):
                self.assertNotIn(VAULT_TOKEN_LITERAL, marker)

    def test_no_default_placeholder_the_real_core_produces_contains_the_literal(self) -> None:
        pytest.importorskip("redact_secret")
        from redact_secret_adapters.mask_secrets import mask_secrets

        masked = mask_secrets(data="token " + "ghp_" + "x" * 36 + " here")
        self.assertNotIn(VAULT_TOKEN_LITERAL, masked)
        self.assertIn("<SECRET_1>", masked)
