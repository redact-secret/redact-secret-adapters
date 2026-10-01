"""The aggregate operation budget (redact-secret-adapters#173): what each
counter counts, boundary values, sticky exhaustion, the logging filter and span
processor sharing one budget per record and span, and thread isolation."""

from __future__ import annotations

import logging
import threading

import pytest
from fake_scanner import KeyAwareScanner, RecordingScanner, fake_scan_and_redact

from redact_secret_adapters import LIMIT_MARKER, OutcomeCounter, mask_leaf_outcome_with, mask_secrets_with
from redact_secret_adapters.budget import (
    DEFAULT_OPERATION_LIMITS,
    OperationBudget,
    resolve_operation_limits,
    utf8_byte_length,
)
from redact_secret_adapters.logging_filter import RedactSecretFilter
from redact_secret_adapters.otel import RedactingSpanProcessorWith, create_redacting_span_processor


def test_utf8_byte_accounting() -> None:
    assert [utf8_byte_length(t) for t in ("", "abc", "é", "한국어", "😀", "a😀한é")] == [0, 3, 2, 9, 4, 10]
    assert utf8_byte_length("\ud800") == 3
    assert utf8_byte_length("한😀é") == len("한😀é".encode())


def test_defaults_and_unusable_overrides() -> None:
    assert DEFAULT_OPERATION_LIMITS == {
        "max_bytes": 16_777_216,
        "max_nodes": 100_000,
        "max_keys": 100_000,
        "max_leaves": 25_000,
        "max_scans": 50_000,
        "max_findings": 100_000,
    }
    resolved = resolve_operation_limits({"max_bytes": float("nan"), "max_nodes": -1, "max_leaves": 3, "max_scans": "9"})
    assert resolved == {**DEFAULT_OPERATION_LIMITS, "max_leaves": 3}
    assert resolve_operation_limits(None) == DEFAULT_OPERATION_LIMITS


@pytest.mark.parametrize(
    ("limit", "charge"),
    [
        ("max_nodes", lambda b: b.charge_node()),
        ("max_keys", lambda b: b.charge_key()),
        ("max_leaves", lambda b: b.charge_leaf()),
        ("max_scans", lambda b: b.charge_scan(0)),
        ("max_findings", lambda b: b.charge_findings(1)),
    ],
)
def test_every_counter_stops_at_exactly_its_limit_and_a_failed_charge_spends_nothing(limit, charge) -> None:
    budget = OperationBudget({limit: 3})
    assert [charge(budget), charge(budget), charge(budget)] == [True, True, True]
    assert budget.exhausted is False
    before = budget.usage()
    assert charge(budget) is False
    assert budget.exhausted is True
    assert budget.usage() == before


def test_bytes_boundary_and_sticky_exhaustion() -> None:
    budget = OperationBudget({"max_bytes": 10})
    assert budget.charge_scan(4) and budget.charge_scan(6)
    assert budget.usage()["bytes"] == 10
    over = OperationBudget({"max_bytes": 10})
    assert over.charge_scan(11) is False
    assert over.usage() == {"bytes": 0, "nodes": 0, "keys": 0, "leaves": 0, "scans": 0, "findings": 0}
    assert over.charge_scan(1) is False and over.charge_node() is False


def test_a_leaf_past_the_budget_is_limited_and_the_core_is_not_called() -> None:
    scanner = RecordingScanner()
    budget = OperationBudget({"max_scans": 1})
    assert mask_leaf_outcome_with(scanner, "SECRET_TOKEN_1", budget=budget).text == "<SECRET_1>"
    out = mask_leaf_outcome_with(scanner, "SECRET_TOKEN_2", budget=budget)
    assert (out.text, out.outcome) == (LIMIT_MARKER, "limited")
    assert [text for text, _ in scanner.calls] == ["SECRET_TOKEN_1"]


def test_the_key_context_view_is_charged_as_a_second_scan_and_its_bytes() -> None:
    budget = OperationBudget()
    mask_leaf_outcome_with(KeyAwareScanner(), "한국어", key="k", budget=budget)
    assert budget.usage()["scans"] == 2
    assert budget.usage()["bytes"] == 9 + 17
    tight = OperationBudget({"max_scans": 1})
    assert mask_leaf_outcome_with(KeyAwareScanner(), "한국어", key="k", budget=tight).outcome == "limited"


def test_many_small_fields_stop_at_the_leaf_bound_and_nothing_unscanned_passes() -> None:
    data = {f"f{i}": f"SECRET_TOKEN_{i}" for i in range(50)}
    scanner = RecordingScanner()
    out = mask_secrets_with(scanner, data, operation_limits={"max_leaves": 10})
    assert list(out.values()).count("<SECRET_1>") == 10
    assert list(out.values()).count(LIMIT_MARKER) == 1
    assert "SECRET_TOKEN" not in repr(out)
    assert len(scanner.calls) == 10
    assert mask_secrets_with(RecordingScanner(), data, operation_limits={"max_leaves": 10}) == out


def test_a_shared_reference_is_stopped_by_the_node_bound() -> None:
    shared = ["a", "b", "c"]
    out = mask_secrets_with(fake_scan_and_redact, [shared] * 200, operation_limits={"max_nodes": 50})
    assert LIMIT_MARKER in repr(out)


def test_many_keys_are_stopped_by_the_key_bound() -> None:
    data = {f"k{i}": "SECRET_TOKEN_9" for i in range(100)}
    out = mask_secrets_with(fake_scan_and_redact, data, operation_limits={"max_keys": 7})
    assert len(out) == 7
    assert "SECRET_TOKEN" not in repr(out)


def test_unicode_bytes_not_code_points_are_counted() -> None:
    leaf = "한" * 10
    assert mask_secrets_with(fake_scan_and_redact, [leaf, leaf], operation_limits={"max_bytes": 59}) == [
        leaf,
        LIMIT_MARKER,
    ]
    assert mask_secrets_with(fake_scan_and_redact, [leaf, leaf], operation_limits={"max_bytes": 60}) == [leaf, leaf]


def _record(**fields) -> logging.LogRecord:
    return logging.makeLogRecord({"msg": "hello", **fields})


def test_the_filter_shares_one_budget_across_message_stack_and_every_extra_field() -> None:
    scanner = RecordingScanner()
    record = _record(a={"x": "SECRET_TOKEN_1"}, b=["SECRET_TOKEN_2"], c="SECRET_TOKEN_3", stack_info="stack")
    # message (1) + stack_info (1) + a.x alone and in context (1: it is redacted alone) + b[0] + c
    RedactSecretFilter(scanner, extra_fields=("a", "b", "c"), operation_limits={"max_scans": 3}).filter(record)
    assert len(scanner.calls) == 3
    assert LIMIT_MARKER in repr((record.a, record.b, record.c))  # type: ignore[attr-defined]
    assert "SECRET_TOKEN" not in repr((record.a, record.b, record.c))  # type: ignore[attr-defined]


def test_each_filter_call_starts_from_a_fresh_budget_and_reports_counts_only() -> None:
    outcomes = []
    flt = RedactSecretFilter(fake_scan_and_redact, operation_limits={"max_scans": 1}, on_outcome=outcomes.append)
    for _ in range(3):
        record = _record()
        flt.filter(record)
        assert record.msg == "hello"
    over = _record(msg="SECRET_TOKEN_1", stack_info="SECRET_TOKEN_2")
    flt.filter(over)
    assert over.msg == "<SECRET_1>" and over.stack_info == LIMIT_MARKER
    assert "SECRET_TOKEN" not in repr(outcomes)
    assert outcomes[-1].values.limited == 1


def test_a_record_logged_from_a_property_during_masking_has_its_own_budget() -> None:
    flt = RedactSecretFilter(fake_scan_and_redact, extra_fields=("payload",), operation_limits={"max_scans": 4})
    inner_record = _record()

    class Payload(dict):
        def __getitem__(self, key):
            flt.filter(inner_record)
            return "ok"

    record = _record(payload=Payload(k="v"))
    flt.filter(record)
    assert inner_record.msg == "hello"
    assert record.payload == {"k": "ok"}  # type: ignore[attr-defined]


def test_concurrent_filter_calls_are_isolated() -> None:
    flt = RedactSecretFilter(fake_scan_and_redact, extra_fields=("data",), operation_limits={"max_leaves": 20})
    results: dict[int, list[str]] = {}
    barrier = threading.Barrier(8)

    def worker(index: int) -> None:
        barrier.wait()
        outcomes = []
        for _ in range(50):
            record = _record(data=[f"SECRET_TOKEN_{index}"] * 30)
            flt.filter(record)
            outcomes.append(record.data.count(LIMIT_MARKER))  # type: ignore[attr-defined]
        results[index] = outcomes

    threads = [threading.Thread(target=worker, args=(i,)) for i in range(8)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    # 1 for the message leaf + 19 of the list inspected; the 11 left over are limited, every time, on every thread.
    assert all(count == 11 for outcomes in results.values() for count in outcomes)


class _Next:
    def __init__(self) -> None:
        self.ended: list = []

    def on_end(self, span) -> None:
        self.ended.append(span)


class _Item:
    def __init__(self, attributes: dict, name: str = "e") -> None:
        self._name = name
        self._attributes = attributes

    @property
    def name(self) -> str:
        return self._name

    @property
    def attributes(self) -> dict:
        return self._attributes


class _Span(_Item):
    def __init__(self, attributes: dict, events=(), links=(), name: str = "op") -> None:
        super().__init__(attributes, name)
        self.events = events
        self.links = links
        self.status = None


def test_a_span_shares_one_budget_across_name_attributes_events_and_links() -> None:
    events = [_Item({"k": "SECRET_TOKEN_1"}, name=f"SECRET_TOKEN_{i}") for i in range(30)]
    links = [_Item({"k": "SECRET_TOKEN_2"}) for _ in range(30)]
    nxt = _Next()
    span = _Span({"a": "SECRET_TOKEN_3"}, events, links)
    RedactingSpanProcessorWith(nxt, fake_scan_and_redact, operation_limits={"max_nodes": 20}).on_end(span)
    assert nxt.ended == [span]
    assert "SECRET_TOKEN" not in repr([span.attributes, [e.name for e in events], [e.attributes for e in events]])
    assert LIMIT_MARKER in repr([e.attributes for e in links])


def test_each_span_gets_a_fresh_budget_and_threads_stay_isolated() -> None:
    nxt = _Next()
    processor = RedactingSpanProcessorWith(nxt, fake_scan_and_redact, operation_limits={"max_leaves": 2})
    errors: list[str] = []
    barrier = threading.Barrier(6)

    def worker() -> None:
        barrier.wait()
        for _ in range(40):
            span = _Span({"k": "v"})
            processor.on_end(span)
            if span.attributes != {"k": "v"} or span.name != "op":
                errors.append("shared budget leaked across spans or threads")

    threads = [threading.Thread(target=worker) for _ in range(6)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert errors == []


def test_the_outcome_counter_keeps_its_meaning() -> None:
    counter = OutcomeCounter()
    from redact_secret_adapters._walk import walk

    walk(fake_scan_and_redact, ["a", "SECRET_TOKEN_1", "c"], policy=None, limits=None, counter=counter)
    assert (counter.scanned, counter.redacted, counter.limited) == (3, 1, 0)


def test_factory_accepts_operation_limits() -> None:
    pytest.importorskip("redact_secret")
    processor = create_redacting_span_processor(_Next(), operation_limits={"max_leaves": 1})
    span = _Span({"a": "x", "b": "y"})
    processor.on_end(span)
    assert LIMIT_MARKER in repr(span.attributes)
