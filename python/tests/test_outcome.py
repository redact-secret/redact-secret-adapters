"""The outcome contract on the Python side
(redact-secret/redact-secret-adapters#45): one summary per ``logging`` record
and per span, the same six numbers with the same meanings as the TypeScript
side, and nothing derived from the input reaching an observer.

The scanner is the deterministic fake: ``SECRET_TOKEN_n`` is redacted,
``BLOCK_ME`` blocks, ``WARN_ME`` gives a finding that changes no text,
``BOOM`` raises. Secrets are built at runtime, never written literally.
"""

from __future__ import annotations

import io
import logging
import re
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from dataclasses import asdict

from fake_scanner import fake_scan_and_redact

from redact_secret_adapters.logging_filter import RedactSecretFilter
from redact_secret_adapters.mask_leaf import count_leaf, mask_leaf_outcome_with, mask_leaf_with
from redact_secret_adapters.outcome import LogRecordOutcome, OutcomeCounter, ValueCounts, notify

_TOKEN = "SECRET_TOKEN" + "_"
_PLAINTEXT = re.compile(r"SECRET_TOKEN_\d|BLOCK_ME")


def _fail(detail: str) -> None:
    raise ValueError(detail)


def _observed_logger(name: str, **filter_kwargs):
    outcomes: list[LogRecordOutcome] = []
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.addFilter(RedactSecretFilter(fake_scan_and_redact, on_outcome=outcomes.append, **filter_kwargs))
    logger = logging.getLogger(f"redact_secret_adapters.outcome.{name}")
    logger.handlers[:] = [handler]
    logger.filters.clear()
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    return logger, outcomes, stream


class LeafOutcomeTest(unittest.TestCase):
    def test_mask_leaf_with_still_returns_only_the_masked_string(self) -> None:
        for text in ("plain", _TOKEN + "1", "BLOCK_ME", "BOOM", "WARN_ME"):
            self.assertEqual(
                mask_leaf_with(fake_scan_and_redact, text),
                mask_leaf_outcome_with(fake_scan_and_redact, text).text,
            )

    def test_each_leaf_outcome_is_named(self) -> None:
        cases = {
            "plain": ("unchanged", 0),
            _TOKEN + "1": ("redacted", 1),
            "BLOCK_ME": ("blocked", 1),
            "BOOM": ("failed", 0),
            # A warn finding changes no text: a finding, but not a redaction.
            "WARN_ME": ("unchanged", 1),
        }
        for text, (outcome, findings) in cases.items():
            leaf = mask_leaf_outcome_with(fake_scan_and_redact, text)
            self.assertEqual((leaf.outcome, leaf.findings), (outcome, findings), text)

    def test_a_leaf_over_the_length_bound_is_limited_and_never_scanned(self) -> None:
        counter = OutcomeCounter()
        leaf = mask_leaf_outcome_with(fake_scan_and_redact, "x" * 20, max_string_length=5)
        count_leaf(counter, leaf)
        self.assertEqual(leaf.outcome, "limited")
        self.assertEqual((counter.limited, counter.scanned), (1, 0))

    def test_a_snapshot_cannot_be_written_back_into_the_live_counter(self) -> None:
        counter = OutcomeCounter()
        snapshot = counter.snapshot()
        counter.scanned = 7
        self.assertEqual(snapshot.scanned, 0)
        with self.assertRaises(Exception):
            snapshot.scanned = 3  # type: ignore[misc]

    def test_a_counter_holds_six_numbers_and_nothing_else(self) -> None:
        counter = OutcomeCounter()
        count_leaf(counter, mask_leaf_outcome_with(fake_scan_and_redact, _TOKEN + "2"))
        self.assertEqual(
            sorted(asdict(counter)),
            ["blocked", "failed", "findings", "limited", "redacted", "scanned"],
        )
        for value in asdict(counter).values():
            self.assertIsInstance(value, int)
            self.assertGreaterEqual(value, 0)

    def test_add_accumulates_several_passes_into_one_unit(self) -> None:
        total, pass_one = OutcomeCounter(), OutcomeCounter()
        count_leaf(pass_one, mask_leaf_outcome_with(fake_scan_and_redact, _TOKEN + "3"))
        total.add(pass_one)
        total.add(pass_one)
        self.assertEqual((total.scanned, total.redacted), (2, 2))


class LoggingOutcomeTest(unittest.TestCase):
    def test_a_record_with_no_secret_reports_one_outcome(self) -> None:
        logger, outcomes, _ = _observed_logger("clean")
        logger.info("user %s logged in", "alice")

        self.assertEqual(len(outcomes), 1)
        self.assertEqual(outcomes[0].host, "logging")
        self.assertEqual(outcomes[0].unit, "log-record")
        self.assertEqual(outcomes[0].level, logging.INFO)
        self.assertEqual(outcomes[0].values, ValueCounts(scanned=1))

    def test_one_record_is_one_outcome_whatever_its_level(self) -> None:
        logger, outcomes, _ = _observed_logger("levels")
        logger.debug("one")
        logger.warning("two")
        logger.critical("three")

        self.assertEqual([outcome.level for outcome in outcomes], [logging.DEBUG, logging.WARNING, logging.CRITICAL])

    def test_the_message_and_its_args_are_one_counted_leaf(self) -> None:
        # The filter formats before scanning, so a secret split across the
        # format string and an argument is one leaf, not two.
        logger, outcomes, stream = _observed_logger("message")
        logger.info("api_key=%s", _TOKEN + "4")

        self.assertNotRegex(stream.getvalue(), _PLAINTEXT)
        self.assertEqual(outcomes[0].values, ValueCounts(scanned=1, findings=1, redacted=1))

    def test_a_block_is_counted_as_blocked_not_redacted(self) -> None:
        logger, outcomes, stream = _observed_logger("block")
        logger.info("%s", "BLOCK_ME")

        self.assertIn("[REDACTED:BLOCKED]", stream.getvalue())
        self.assertEqual((outcomes[0].values.blocked, outcomes[0].values.redacted), (1, 0))

    def test_an_unformattable_message_is_counted_as_failed(self) -> None:
        logger, outcomes, stream = _observed_logger("unformattable")
        logger.info("%d", "not a number")

        self.assertIn("[REDACTED:ERROR]", stream.getvalue())
        self.assertEqual(outcomes[0].values.failed, 1)
        self.assertEqual(outcomes[0].values.scanned, 0)

    def test_an_exception_and_a_named_extra_are_counted_on_the_same_record(self) -> None:
        logger, outcomes, stream = _observed_logger("exception", extra_fields=("user",))
        try:
            _fail("upstream said " + _TOKEN + "5")
        except ValueError:
            logger.exception("token=%s", _TOKEN + "6", extra={"user": "alice " + _TOKEN + "7"})

        self.assertNotRegex(stream.getvalue(), _PLAINTEXT)
        self.assertEqual(len(outcomes), 1)
        # The message, the traceback text, and the one string extra.
        self.assertEqual(outcomes[0].values.scanned, 3)
        self.assertEqual(outcomes[0].values.redacted, 3)

    def test_a_limit_counts_as_limited_and_never_as_scanned(self) -> None:
        logger, outcomes, _ = _observed_logger("limits", limits={"max_string_length": 4})
        logger.info("a long message")

        self.assertEqual((outcomes[0].values.limited, outcomes[0].values.scanned), (1, 0))

    def test_two_filtered_handlers_report_once_each_because_each_is_its_own_pass(self) -> None:
        # A record through two filtered handlers is two units of work. Each
        # reports its own, so a host summing them sees the work it paid for,
        # and the second pass finds nothing left to redact.
        outcomes: list[LogRecordOutcome] = []
        first, second = io.StringIO(), io.StringIO()
        handlers = [logging.StreamHandler(first), logging.StreamHandler(second)]
        redact = RedactSecretFilter(fake_scan_and_redact, on_outcome=outcomes.append)
        for handler in handlers:
            handler.addFilter(redact)
        logger = logging.getLogger("redact_secret_adapters.outcome.two-handlers")
        logger.handlers[:] = handlers
        logger.filters.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = False

        logger.info("token=%s", _TOKEN + "8")

        self.assertEqual(len(outcomes), 2)
        self.assertEqual(outcomes[0].values.redacted, 1)
        self.assertEqual(outcomes[1].values.redacted, 0)

    def test_an_observer_that_raises_changes_neither_the_output_nor_the_next_record(self) -> None:
        def boom(_outcome: LogRecordOutcome) -> None:
            raise RuntimeError("observer failed")

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact, on_outcome=boom))
        logger = logging.getLogger("redact_secret_adapters.outcome.raising")
        logger.handlers[:] = [handler]
        logger.filters.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = False

        logger.info("token=%s", _TOKEN + "9")
        logger.info("second")

        output = stream.getvalue()
        self.assertNotRegex(output, _PLAINTEXT)
        self.assertIn("token=<SECRET_1>", output)
        self.assertIn("second", output)

    def test_an_observer_that_logs_through_the_same_logger_does_not_recurse(self) -> None:
        outcomes: list[LogRecordOutcome] = []
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        logger = logging.getLogger("redact_secret_adapters.outcome.recursion")

        def observe(outcome: LogRecordOutcome) -> None:
            outcomes.append(outcome)
            logger.warning("observer says hello")

        handler.addFilter(RedactSecretFilter(fake_scan_and_redact, on_outcome=observe))
        logger.handlers[:] = [handler]
        logger.filters.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = False

        logger.info("first")

        # One outcome for the original record; the nested one is not reported.
        self.assertEqual(len(outcomes), 1)
        self.assertIn("observer says hello", stream.getvalue())

    def test_an_outcome_carries_no_value_attribute_name_or_marker(self) -> None:
        logger, outcomes, _ = _observed_logger("no-leak", extra_fields=("api_key",))
        logger.info("%s", "BLOCK_ME", extra={"api_key": _TOKEN + "10"})

        serialized = repr([asdict(outcome) for outcome in outcomes])
        for text in (_TOKEN + "10", "BLOCK_ME", "api_key", "<SECRET_1>", "REDACTED"):
            self.assertNotIn(text, serialized)
        self.assertEqual(sorted(asdict(outcomes[0])), ["host", "level", "unit", "values"])

    def test_threads_sharing_one_filter_each_get_their_own_outcome(self) -> None:
        # The re-entrancy guard is thread-local, so one thread reporting never
        # suppresses another's outcome.
        outcomes: list[LogRecordOutcome] = []
        lock = threading.Lock()

        def observe(outcome: LogRecordOutcome) -> None:
            with lock:
                outcomes.append(outcome)

        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact, on_outcome=observe))
        logger = logging.getLogger("redact_secret_adapters.outcome.threads")
        logger.handlers[:] = [handler]
        logger.filters.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = False

        def emit(index: int) -> None:
            for step in range(20):
                logger.info("token=%s", _TOKEN + str(index * 100 + step))

        with ThreadPoolExecutor(max_workers=8) as pool:
            list(pool.map(emit, range(8)))

        self.assertEqual(len(outcomes), 8 * 20)
        self.assertTrue(all(outcome.values.redacted == 1 for outcome in outcomes))
        self.assertNotRegex(stream.getvalue(), _PLAINTEXT)

    def test_without_on_outcome_nothing_is_reported_and_masking_is_unchanged(self) -> None:
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact))
        logger = logging.getLogger("redact_secret_adapters.outcome.off")
        logger.handlers[:] = [handler]
        logger.filters.clear()
        logger.setLevel(logging.INFO)
        logger.propagate = False

        logger.info("token=%s", _TOKEN + "11")
        self.assertIn("token=<SECRET_1>", stream.getvalue())

    def test_a_non_callable_on_outcome_raises(self) -> None:
        with self.assertRaises(TypeError):
            RedactSecretFilter(fake_scan_and_redact, on_outcome="nope")  # type: ignore[arg-type]


class NotifyTest(unittest.TestCase):
    def test_notify_swallows_an_observers_exception(self) -> None:
        def boom(_outcome: object) -> None:
            raise RuntimeError("observer failed")

        notify(boom, ValueCounts())
        notify(None, ValueCounts())

        seen: list[object] = []
        notify(seen.append, ValueCounts(scanned=1))
        self.assertEqual(seen, [ValueCounts(scanned=1)])


if __name__ == "__main__":
    unittest.main()
