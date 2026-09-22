"""Structural tests for RedactingSpanProcessorWith -- no opentelemetry-sdk or
redact_secret needed: a fake scanner and plain duck-typed stand-ins for the
SDK's Span/ReadableSpan/SpanProcessor types. ``test_otel_host.py`` is the
real-host counterpart.
"""

from __future__ import annotations

import json
import unittest
import warnings
from types import MappingProxyType

from fake_scanner import fake_scan_and_redact

from redact_secret_adapters.otel import RedactingSpanProcessorWith, redact_attributes_with


class FakeEvent:
    def __init__(self, attributes: dict, name: str = "event") -> None:
        self._name = name
        self._attributes = attributes


class FakeLink:
    def __init__(self, attributes: dict) -> None:
        self._attributes = attributes


class FakeStatus:
    def __init__(self, status_code: str = "UNSET", description=None) -> None:
        self.status_code = status_code
        self.description = description


class FakeSpan:
    """Stands in for `ReadableSpan`: everything the processor writes lives
    on a private field, matching the real SDK's read-only accessors."""

    def __init__(self, attributes: dict, events=(), *, name: str = "span", status=None, links=()) -> None:
        self._name = name
        self._attributes = attributes
        self._status = status if status is not None else FakeStatus()
        self._events = list(events)
        self._links = list(links)

    @property
    def events(self) -> tuple:
        return tuple(self._events)

    @property
    def links(self) -> tuple:
        return tuple(self._links)


class FakeNextProcessor:
    def __init__(self) -> None:
        self.started: list[tuple] = []
        self.exported: list[FakeSpan] = []
        self.shutdown_calls = 0
        self.flush_timeouts: list[int] = []

    def on_start(self, span, parent_context=None) -> None:
        self.started.append((span, parent_context))

    def on_end(self, span) -> None:
        self.exported.append(span)

    def shutdown(self) -> None:
        self.shutdown_calls += 1

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        self.flush_timeouts.append(timeout_millis)
        return False  # distinguishable from the fallback's True


class RedactingSpanProcessorWithTest(unittest.TestCase):
    def test_redacts_string_and_string_sequence_attributes_before_export(self) -> None:
        next_processor = FakeNextProcessor()
        processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact)
        span = FakeSpan(
            attributes={
                "llm.input_messages": "call SECRET_TOKEN_1 now",
                "llm.tags": ["ok", "BLOCK_ME here"],
                "retry.count": 3,
                "retry.ok": True,
            },
            events=[FakeEvent({"tool.args": "value SECRET_TOKEN_2 done"})],
        )

        processor.on_end(span)

        self.assertEqual(len(next_processor.exported), 1)
        exported = next_processor.exported[0]
        self.assertEqual(exported._attributes["llm.input_messages"], "call <SECRET_1> now")
        self.assertEqual(exported._attributes["llm.tags"], ["ok", "[REDACTED:BLOCKED]"])
        self.assertEqual(exported._attributes["retry.count"], 3)
        self.assertEqual(exported._attributes["retry.ok"], True)
        self.assertEqual(exported.events[0]._attributes["tool.args"], "value <SECRET_1> done")

        serialized = json.dumps(
            [
                {"attributes": s._attributes, "events": [e._attributes for e in s.events]}
                for s in next_processor.exported
            ]
        )
        self.assertNotIn("SECRET_TOKEN_1", serialized)
        self.assertNotIn("SECRET_TOKEN_2", serialized)
        self.assertNotIn("BLOCK_ME", serialized)

    def test_name_status_event_names_and_link_attributes_are_redacted(self) -> None:
        next_processor = FakeNextProcessor()
        processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact)
        caller_status = FakeStatus("ERROR", "failed with SECRET_TOKEN_1")
        span = FakeSpan(
            attributes={},
            name="GET SECRET_TOKEN_2",
            status=caller_status,
            events=[FakeEvent({}, name="retry SECRET_TOKEN_3")],
            links=[FakeLink({"peer": "SECRET_TOKEN_4 here", "tags": ("x", None)})],
        )

        processor.on_end(span)

        exported = next_processor.exported[0]
        self.assertEqual(exported._name, "GET <SECRET_1>")
        self.assertEqual(exported._status.status_code, "ERROR")
        self.assertEqual(exported._status.description, "failed with <SECRET_1>")
        self.assertEqual(caller_status.description, "failed with SECRET_TOKEN_1")  # replaced, not mutated
        self.assertEqual(exported.events[0]._name, "retry <SECRET_1>")
        self.assertEqual(exported.links[0]._attributes, {"peer": "<SECRET_1> here", "tags": ("x", None)})

    def test_a_renamed_private_field_drops_the_span_and_warns_once(self) -> None:
        class RenamedAttributesSpan(FakeSpan):
            def __init__(self) -> None:
                super().__init__({})
                del self._attributes
                self._attributes_v2 = {"k": "SECRET_TOKEN_1"}

            @property
            def attributes(self):
                return MappingProxyType(self._attributes_v2)

        next_processor = FakeNextProcessor()
        processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            processor.on_end(RenamedAttributesSpan())
            processor.on_end(RenamedAttributesSpan())
        self.assertEqual(next_processor.exported, [])
        self.assertEqual(len(caught), 1)
        self.assertIs(caught[0].category, RuntimeWarning)
        self.assertIn("RenamedAttributesSpan._attributes", str(caught[0].message))
        self.assertNotIn("SECRET_TOKEN_1", str(caught[0].message))

    def test_a_write_that_does_not_show_through_the_public_accessor_drops_the_span(self) -> None:
        class NameMovedSpan(FakeSpan):
            @property
            def name(self) -> str:
                return "GET SECRET_TOKEN_1"  # reads a field the processor does not know

        next_processor = FakeNextProcessor()
        processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact)
        with warnings.catch_warnings(record=True):
            warnings.simplefilter("always")
            processor.on_end(NameMovedSpan({}))
        self.assertEqual(next_processor.exported, [])

    def test_an_attribute_bag_that_rejects_writes_drops_the_span(self) -> None:
        next_processor = FakeNextProcessor()
        processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact)
        with warnings.catch_warnings(record=True) as caught:
            warnings.simplefilter("always")
            processor.on_end(FakeSpan(MappingProxyType({"k": "SECRET_TOKEN_1"})))
        self.assertEqual(next_processor.exported, [])
        self.assertIn("TypeError", str(caught[0].message))

    def test_core_failure_on_one_attribute_fails_closed(self) -> None:
        next_processor = FakeNextProcessor()
        processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact)
        span = FakeSpan(attributes={"boom": "trigger BOOM here"})

        processor.on_end(span)

        self.assertEqual(next_processor.exported[0]._attributes["boom"], "[REDACTED:ERROR]")
        self.assertNotIn("BOOM", json.dumps(next_processor.exported[0]._attributes))

    def test_string_sequences_containing_none_are_masked_with_none_kept_in_place(self) -> None:
        attributes = {
            "list": ["ok", None, "call SECRET_TOKEN_1 now"],
            "tuple": (None, "BLOCK_ME here"),
            "numbers": [1, None, 2],
        }
        redact_attributes_with(fake_scan_and_redact, attributes)
        self.assertEqual(attributes["list"], ["ok", None, "call <SECRET_1> now"])
        self.assertEqual(attributes["tuple"], (None, "[REDACTED:BLOCKED]"))
        self.assertEqual(attributes["numbers"], [1, None, 2])

    def test_a_malformed_scan_result_fails_closed_without_raising(self) -> None:
        attributes = {"a": "SECRET_TOKEN_1", "b": ["x", None]}
        redact_attributes_with(lambda text, policy=None: object(), attributes)
        self.assertEqual(attributes, {"a": "[REDACTED:ERROR]", "b": ["[REDACTED:ERROR]", None]})

    def test_on_start_shutdown_force_flush_delegate(self) -> None:
        next_processor = FakeNextProcessor()
        processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact)

        processor.on_start("span-1", "ctx-1")
        self.assertEqual(next_processor.started, [("span-1", "ctx-1")])
        processor.shutdown()
        self.assertEqual(next_processor.shutdown_calls, 1)
        self.assertIs(processor.force_flush(1234), False)
        self.assertEqual(next_processor.flush_timeouts, [1234])

    def test_a_next_processor_with_only_on_end_is_tolerated(self) -> None:
        class OnEndOnly:
            def __init__(self) -> None:
                self.exported: list = []

            def on_end(self, span) -> None:
                self.exported.append(span)

        next_processor = OnEndOnly()
        processor = RedactingSpanProcessorWith(next_processor, fake_scan_and_redact)
        processor.on_start("span-1", "ctx-1")  # must not raise
        self.assertIs(processor.force_flush(), True)
        span = FakeSpan({"k": "SECRET_TOKEN_1"})
        processor.on_end(span)
        self.assertEqual(next_processor.exported[0]._attributes, {"k": "<SECRET_1>"})

    def test_redact_attributes_with_is_a_noop_for_none(self) -> None:
        redact_attributes_with(fake_scan_and_redact, None)  # must not raise

    def test_rejects_next_processor_without_on_end_or_non_callable_scanner(self) -> None:
        with self.assertRaises(TypeError):
            RedactingSpanProcessorWith(object(), fake_scan_and_redact)
        with self.assertRaises(TypeError):
            RedactingSpanProcessorWith(FakeNextProcessor(), None)


if __name__ == "__main__":
    unittest.main()
