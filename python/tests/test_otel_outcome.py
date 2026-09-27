"""One outcome per span on the Python side
(redact-secret/redact-secret-adapters#45): per-span counts, ``dropped`` as
this processor's own decision and never a claim about the exporter, and an
observer that can neither leak input nor change what is exported.

Plain duck-typed stand-ins for the SDK's types, as in ``test_otel.py``;
``test_otel_host.py`` is the real-host counterpart.
"""

from __future__ import annotations

import threading
import unittest
import warnings
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict
from types import MappingProxyType

from fake_scanner import fake_scan_and_redact
from test_otel import FakeEvent, FakeNextProcessor, FakeSpan

from redact_secret_adapters.otel import RedactingSpanProcessorWith
from redact_secret_adapters.outcome import SpanOutcome, ValueCounts

_TOKEN = "SECRET_TOKEN" + "_"


class RaisingNextProcessor(FakeNextProcessor):
    def on_end(self, span) -> None:
        raise RuntimeError("exporter unavailable")


def _observed(next_processor=None, **options):
    outcomes: list[SpanOutcome] = []
    next_processor = next_processor if next_processor is not None else FakeNextProcessor()
    processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact, on_outcome=outcomes.append, **options)
    return processor, outcomes, next_processor


class SpanOutcomeTest(unittest.TestCase):
    def test_a_span_with_no_secret_reports_one_outcome(self) -> None:
        processor, outcomes, next_processor = _observed()
        processor.on_end(FakeSpan(attributes={"http.route": "/users", "http.status_code": 200}))

        self.assertEqual(len(next_processor.exported), 1)
        self.assertEqual(len(outcomes), 1)
        self.assertEqual(outcomes[0].host, "otel")
        self.assertEqual(outcomes[0].unit, "span")
        self.assertFalse(outcomes[0].dropped)
        # The span name and the one string attribute; the number is not a leaf.
        self.assertEqual(outcomes[0].values, ValueCounts(scanned=2))

    def test_counts_are_per_span_not_a_running_total(self) -> None:
        processor, outcomes, _ = _observed()
        processor.on_end(FakeSpan(attributes={"llm.input": "call " + _TOKEN + "1 now"}))
        processor.on_end(FakeSpan(attributes={"llm.input": "nothing here"}))

        self.assertEqual(len(outcomes), 2)
        self.assertEqual(outcomes[0].values.redacted, 1)
        self.assertEqual(outcomes[1].values.redacted, 0)

    def test_every_string_in_a_sequence_attribute_is_its_own_leaf(self) -> None:
        processor, outcomes, _ = _observed()
        processor.on_end(FakeSpan(attributes={"gen_ai.prompt": [_TOKEN + "2", "plain", None]}))

        # The span name plus the two strings; the None hole is not a leaf.
        self.assertEqual(outcomes[0].values.scanned, 3)
        self.assertEqual(outcomes[0].values.redacted, 1)

    def test_events_and_links_count_on_the_span_that_carried_them(self) -> None:
        processor, outcomes, _ = _observed()
        processor.on_end(
            FakeSpan(
                attributes={"a": "plain"},
                events=[FakeEvent({"tool.args": "value " + _TOKEN + "3 done"})],
            )
        )

        self.assertEqual(len(outcomes), 1)
        self.assertEqual(outcomes[0].values.redacted, 1)

    def test_a_block_counts_as_blocked_and_a_scanner_error_as_failed(self) -> None:
        processor, outcomes, _ = _observed()
        processor.on_end(FakeSpan(attributes={"a": "BLOCK_ME"}))
        processor.on_end(FakeSpan(attributes={"a": "BOOM"}))

        self.assertEqual(outcomes[0].values.blocked, 1)
        self.assertEqual(outcomes[1].values.failed, 1)

    def test_a_limit_counts_as_limited_and_never_as_scanned(self) -> None:
        processor, outcomes, _ = _observed(limits={"max_string_length": 3})
        processor.on_end(FakeSpan(attributes={"a": "a long attribute value"}, name="n"))

        self.assertGreater(outcomes[0].values.limited, 0)

    def test_a_span_this_processor_did_not_forward_reports_dropped(self) -> None:
        processor, outcomes, next_processor = _observed()
        # An immutable attribute mapping: the masked write cannot take, so the
        # span is dropped rather than exported unredacted.
        span = FakeSpan(attributes=MappingProxyType({"a": _TOKEN + "4"}))
        with warnings.catch_warnings():
            warnings.simplefilter("ignore", RuntimeWarning)
            processor.on_end(span)

        self.assertEqual(next_processor.exported, [])
        self.assertEqual(len(outcomes), 1)
        self.assertTrue(outcomes[0].dropped)

    def test_dropped_is_false_for_a_forwarded_span_even_when_the_next_processor_raises(self) -> None:
        # ``dropped`` is this processor's own decision. Whether the next
        # processor or an exporter kept the span is never learned here.
        processor, outcomes, _ = _observed(RaisingNextProcessor())
        with self.assertRaises(RuntimeError):
            processor.on_end(FakeSpan(attributes={"a": _TOKEN + "5"}))

        self.assertEqual(len(outcomes), 1)
        self.assertFalse(outcomes[0].dropped)
        self.assertEqual(outcomes[0].values.redacted, 1)

    def test_an_observer_that_raises_changes_neither_the_export_nor_the_next_span(self) -> None:
        def boom(_outcome: SpanOutcome) -> None:
            raise RuntimeError("observer failed")

        next_processor = FakeNextProcessor()
        processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact, on_outcome=boom)
        processor.on_end(FakeSpan(attributes={"a": _TOKEN + "6"}))
        processor.on_end(FakeSpan(attributes={"a": "plain"}))

        self.assertEqual(len(next_processor.exported), 2)
        self.assertEqual(next_processor.exported[0]._attributes["a"], "<SECRET_1>")

    def test_an_observer_that_ends_another_span_does_not_recurse(self) -> None:
        outcomes: list[SpanOutcome] = []
        processor: RedactingSpanProcessorWith

        def observe(outcome: SpanOutcome) -> None:
            outcomes.append(outcome)
            processor.on_end(FakeSpan(attributes={"a": "nested"}))

        processor = RedactingSpanProcessorWith(FakeNextProcessor(), fake_scan_and_redact, on_outcome=observe)
        processor.on_end(FakeSpan(attributes={"a": _TOKEN + "7"}))

        self.assertEqual(len(outcomes), 1)

    def test_an_outcome_carries_no_attribute_name_value_or_marker(self) -> None:
        processor, outcomes, _ = _observed()
        processor.on_end(FakeSpan(attributes={"api_key": _TOKEN + "8"}, name="BLOCK_ME"))

        serialized = repr([asdict(outcome) for outcome in outcomes])
        for text in (_TOKEN + "8", "BLOCK_ME", "api_key", "<SECRET_1>", "REDACTED"):
            self.assertNotIn(text, serialized)
        self.assertEqual(sorted(asdict(outcomes[0])), ["dropped", "host", "unit", "values"])

    def test_spans_ending_on_several_threads_each_report_their_own(self) -> None:
        outcomes: list[SpanOutcome] = []
        lock = threading.Lock()

        def observe(outcome: SpanOutcome) -> None:
            with lock:
                outcomes.append(outcome)

        processor = RedactingSpanProcessorWith(FakeNextProcessor(), fake_scan_and_redact, on_outcome=observe)

        def end(index: int) -> None:
            for step in range(20):
                processor.on_end(FakeSpan(attributes={"a": _TOKEN + str(index * 100 + step)}, name="n"))

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(end, range(8)))

        self.assertEqual(len(outcomes), 8 * 20)
        self.assertTrue(all(outcome.values.redacted == 1 for outcome in outcomes))

    def test_without_on_outcome_nothing_is_reported_and_redaction_is_unchanged(self) -> None:
        next_processor = FakeNextProcessor()
        processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact)
        processor.on_end(FakeSpan(attributes={"a": _TOKEN + "9"}))
        self.assertEqual(next_processor.exported[0]._attributes["a"], "<SECRET_1>")

    def test_a_non_callable_on_outcome_raises(self) -> None:
        with self.assertRaises(TypeError):
            RedactingSpanProcessorWith(FakeNextProcessor(), fake_scan_and_redact, on_outcome="nope")


if __name__ == "__main__":
    unittest.main()
