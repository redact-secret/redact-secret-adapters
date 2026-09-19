"""Exercises the live wrappers against the real installed ``redact_secret``.
They deliberately pass no secret-shaped value -- detection is the core's job
and is tested there -- and assert only that the wiring carries clean text
through unchanged.
"""

from __future__ import annotations

import logging

import pytest

pytest.importorskip("redact_secret")

from redact_secret_adapters.logging_filter import RedactSecretFilter  # noqa: E402
from redact_secret_adapters.mask_secrets import mask_secrets  # noqa: E402


def test_mask_secrets_uses_the_real_core() -> None:
    data = {"role": "user", "content": ["hello", "world"], "count": 2}
    assert mask_secrets(data=data) == data


def test_filter_without_arguments_uses_the_real_core() -> None:
    record = logging.makeLogRecord({"msg": "user %s logged in", "args": ("alice",)})
    assert RedactSecretFilter().filter(record) is True
    assert record.getMessage() == "user alice logged in"
