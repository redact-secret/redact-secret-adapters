"""Key-aware detection (redact-secret-adapters#172): the shared primitive, the
logging walker, the logging filter and the span processor, against a scanner
whose key-context answer the test controls, and the shared synthetic key/value
pairs through the real core."""

from __future__ import annotations

import json
import logging
from pathlib import Path

import pytest
from fake_scanner import FakeResult, KeyAwareScanner, fake_scan_and_redact

from redact_secret_adapters import (
    BLOCK_MARKER,
    ERROR_MARKER,
    LIMIT_MARKER,
    mask_leaf_outcome_with,
    mask_log_value_with,
    mask_secrets_with,
)
from redact_secret_adapters.key_context import (
    KeyContextFailure,
    key_context_prefix,
    key_context_view,
    scan_leaf_in_key_context,
)
from redact_secret_adapters.logging_filter import RedactSecretFilter
from redact_secret_adapters.otel import RedactingSpanProcessorWith, redact_attributes_with

LEAF = "synthetic-example-value-0001"
CASES = json.loads((Path(__file__).resolve().parents[2] / "fixtures" / "key-context-cases.json").read_text("utf-8"))[
    "cases"
]


def test_view_is_the_key_and_the_leaf_verbatim() -> None:
    assert key_context_prefix('a"b') == '{"a"b":"'
    assert key_context_view("password", 'x"\\y') == '{"password":"x"\\y"}'


def test_context_dependent_leaf_under_its_key_is_masked_and_elsewhere_is_not() -> None:
    scan = KeyAwareScanner()
    out = mask_secrets_with(scan, {"password": LEAF, "name": LEAF, "list": [LEAF]})
    assert out == {"password": "<SECRET_1>", "name": LEAF, "list": [LEAF]}
    assert mask_secrets_with(scan, LEAF) == LEAF


def test_key_context_reaches_nested_mappings_and_exception_attributes_and_keeps_the_shape() -> None:
    error = ValueError("failed")
    error.password = LEAF  # type: ignore[attr-defined]
    out = mask_log_value_with(KeyAwareScanner(), {"outer": {"client_secret": LEAF}, "error": error, "api_key": LEAF})
    assert out["outer"] == {"client_secret": "<SECRET_1>"}
    assert out["error"]["password"] == "<SECRET_1>"
    assert out["api_key"] == "<SECRET_1>"
    assert list(out) == ["outer", "error", "api_key"]


def test_non_string_mapping_keys_give_no_context() -> None:
    scan = KeyAwareScanner()
    assert mask_secrets_with(scan, {7: LEAF}) == {7: LEAF}


@pytest.mark.parametrize("leaf", ["😀synthetic-example-0001", "한국어-가짜-비밀번호-1234", 'say "hi" \\ ' + LEAF])
def test_offsets_are_leaf_offsets_across_emoji_and_korean(leaf: str) -> None:
    out = mask_leaf_outcome_with(KeyAwareScanner(), leaf, key="password")
    assert (out.text, out.outcome, out.findings) == ("<SECRET_1>", "redacted", 1)


def test_block_warn_and_allow_policies_from_the_view() -> None:
    block = mask_leaf_outcome_with(KeyAwareScanner(action="block"), LEAF, key="password")
    assert (block.text, block.outcome, block.findings) == (BLOCK_MARKER, "blocked", 1)
    for action in ("warn", "allow"):
        out = mask_leaf_outcome_with(KeyAwareScanner(action=action), LEAF, key="password")
        assert (out.text, out.outcome, out.findings) == (LEAF, "unchanged", 1)


def test_a_view_finding_over_the_key_blocks_the_leaf_never_the_key() -> None:
    assert mask_leaf_outcome_with(KeyAwareScanner(span_key=True), LEAF, key="password").text == BLOCK_MARKER
    assert mask_secrets_with(KeyAwareScanner(span_key=True), {"password": LEAF}) == {"password": BLOCK_MARKER}


@pytest.mark.parametrize("options", [{"throw_on_view": True}, {"corrupt_text": True}])
def test_a_failing_or_contract_breaking_view_fails_closed_and_the_original_never_survives(options: dict) -> None:
    out = mask_leaf_outcome_with(KeyAwareScanner(**options), LEAF, key="password")
    assert (out.text, out.outcome) == (ERROR_MARKER, "failed")


def test_a_malformed_view_result_fails_closed() -> None:
    def scan(text, policy=None):
        if text.startswith('{"'):
            return FakeResult(1, [])  # type: ignore[arg-type]
        return fake_scan_and_redact(text)

    assert mask_leaf_outcome_with(scan, LEAF, key="k").text == ERROR_MARKER


def test_a_key_longer_than_the_string_limit_is_refused_before_any_scan() -> None:
    def scan(text, policy=None):
        raise AssertionError("must not be called")

    assert mask_leaf_outcome_with(scan, "v", key="k" * 20, max_string_length=10).outcome == "limited"
    assert LIMIT_MARKER == "[REDACTED:LIMIT_EXCEEDED]"


def test_a_leaf_the_core_already_redacts_is_not_scanned_again() -> None:
    scan = KeyAwareScanner()
    assert mask_leaf_outcome_with(scan, "SECRET_TOKEN_1", key="note").text == "<SECRET_1>"
    assert scan.calls == ["SECRET_TOKEN_1"]


def test_the_primitive_reports_policy_and_core_error_kinds() -> None:
    def scan(candidate: str):
        return (candidate, [])

    assert scan_leaf_in_key_context(scan, "v", None) == ("v", [])
    with pytest.raises(KeyContextFailure) as raised:
        scan_leaf_in_key_context(lambda text: ("x", []) if text.startswith('{"') else (text, []), "v", "k")
    assert raised.value.kind == "core_error"


def test_extra_fields_use_the_field_name_as_the_key() -> None:
    record = logging.makeLogRecord({"msg": "hello", "api_key": LEAF, "name2": LEAF, "payload": {"password": LEAF}})
    RedactSecretFilter(KeyAwareScanner(), extra_fields=("api_key", "name2", "payload")).filter(record)
    assert record.api_key == "<SECRET_1>"  # type: ignore[attr-defined]
    assert record.name2 == LEAF  # type: ignore[attr-defined]
    assert record.payload == {"password": "<SECRET_1>"}  # type: ignore[attr-defined]
    assert record.getMessage() == "hello"


def test_message_and_stack_text_have_no_key() -> None:
    record = logging.makeLogRecord({"msg": LEAF})
    scan = KeyAwareScanner()
    RedactSecretFilter(scan).filter(record)
    assert record.msg == LEAF
    assert scan.calls == [LEAF]


class _Next:
    def __init__(self) -> None:
        self.ended: list = []

    def on_end(self, span) -> None:
        self.ended.append(span)


class _Span:
    def __init__(self, attributes: dict) -> None:
        self._name = "operation"
        self.name = "operation"
        self._attributes = attributes
        self.attributes = attributes
        self.events = ()
        self.links = ()
        self.status = None


def test_span_attributes_are_keyed_and_array_elements_are_not() -> None:
    nxt = _Next()
    span = _Span({"api_key": LEAF, "name": LEAF, "password": [LEAF], "count": 3})
    RedactingSpanProcessorWith(nxt, KeyAwareScanner()).on_end(span)
    assert nxt.ended and span.attributes == {"api_key": "<SECRET_1>", "name": LEAF, "password": [LEAF], "count": 3}


def test_redact_attributes_with_uses_the_attribute_name() -> None:
    attributes = {"password": LEAF, "note": LEAF}
    redact_attributes_with(KeyAwareScanner(), attributes)
    assert attributes == {"password": "<SECRET_1>", "note": LEAF}


# --- the shared pairs through the real core -------------------------------

redact_secret = pytest.importorskip("redact_secret")


def _expected(case: dict) -> str:
    return case["value"] if case["masked"] is None else case["masked"]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_shared_pairs_through_the_real_core_walker(case: dict) -> None:
    out = mask_secrets_with(redact_secret.scan_and_redact, {case["key"]: case["value"]})
    assert out == {case["key"]: _expected(case)}


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_shared_pairs_through_the_real_core_logging_filter(case: dict) -> None:
    record = logging.makeLogRecord({"msg": "m", "payload": {case["key"]: case["value"]}})
    RedactSecretFilter(extra_fields=("payload",)).filter(record)
    assert record.payload == {case["key"]: _expected(case)}  # type: ignore[attr-defined]


@pytest.mark.parametrize("case", CASES, ids=[c["id"] for c in CASES])
def test_shared_pairs_through_the_real_core_span_processor(case: dict) -> None:
    nxt = _Next()
    span = _Span({case["key"]: case["value"]})
    RedactingSpanProcessorWith(nxt, redact_secret.scan_and_redact).on_end(span)
    assert span.attributes == {case["key"]: _expected(case)}


@pytest.mark.parametrize(("action", "expected"), [("block", BLOCK_MARKER), ("warn", LEAF), ("allow", LEAF)])
def test_policy_applies_to_a_key_context_finding_in_the_real_core(action: str, expected: str) -> None:
    out = mask_secrets_with(redact_secret.scan_and_redact, {"api_key": LEAF}, policy=lambda finding, context: action)
    assert out == {"api_key": expected}


def test_a_throwing_policy_fails_closed_without_the_message() -> None:
    def policy(finding, context):
        raise RuntimeError(LEAF)

    out = mask_secrets_with(redact_secret.scan_and_redact, {"api_key": LEAF}, policy=policy)
    assert out == {"api_key": ERROR_MARKER}
