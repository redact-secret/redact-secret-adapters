"""Real-host lifecycle qualification for stdlib ``logging`` (#11): filter
and formatter ordering, the ``QueueHandler``/``QueueListener`` hand-off,
concurrent emitters, and a failing handler. The scanner is the
deterministic fake; the host is a real ``logging.Logger``.

Every record carries its own id and its own synthetic secret, so an output
line holding another record's id, a block marker it did not ask for, or any
``SECRET_TOKEN_`` text is cross-record leakage. Secrets are built at runtime
(see ``test_logging_filter._SECRET``): a formatted traceback echoes source
lines, and a literal token in a ``raise`` line would appear there.
"""

from __future__ import annotations

import ast
import contextlib
import io
import logging
import logging.handlers
import queue
import re
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor

from fake_scanner import fake_scan_and_redact

from redact_secret_adapters.logging_filter import RedactSecretFilter

_TOKEN = "SECRET_TOKEN" + "_"
_PLAINTEXT = re.compile(r"SECRET_TOKEN_\d|BLOCK_ME")
THREADS = 8
RECORDS_PER_THREAD = 150


def _logger(name: str, *handlers: logging.Handler) -> logging.Logger:
    logger = logging.getLogger(f"redact_secret_adapters.lifecycle.{name}")
    logger.handlers[:] = list(handlers)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


def _fail(detail: str) -> None:
    raise ValueError(detail)


class FilterFormatterOrderingTest(unittest.TestCase):
    def test_a_handler_filter_runs_before_every_formatter_field_it_covers(self) -> None:
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(levelname)s %(message)s user=%(user)s"))
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact, extra_fields=("user",)))
        logger = _logger("ordering", handler)

        secret = _TOKEN + "1"
        try:
            _fail("upstream said " + secret)
        except ValueError:
            logger.exception("token=%s", _TOKEN + "2", extra={"user": "alice " + _TOKEN + "3"})

        output = stream.getvalue()
        self.assertIn("ERROR token=<SECRET_1> user=alice <SECRET_1>", output)
        self.assertIn("ValueError: upstream said <SECRET_1>", output)
        self.assertNotRegex(output, _PLAINTEXT)

    def test_a_second_handler_reuses_the_masked_record_the_first_handlers_filter_produced(self) -> None:
        # Records are shared between handlers; the filter's mutation, and the
        # exc_text it caches, is what every later handler formats.
        first, second = io.StringIO(), io.StringIO()
        filtered = logging.StreamHandler(first)
        filtered.addFilter(RedactSecretFilter(fake_scan_and_redact))
        plain = logging.StreamHandler(second)
        logger = _logger("shared-record", filtered, plain)

        try:
            _fail("boom " + _TOKEN + "4")
        except ValueError:
            logger.exception("token=%s", _TOKEN + "5")

        for output in (first.getvalue(), second.getvalue()):
            self.assertIn("token=<SECRET_1>", output)
            self.assertNotRegex(output, _PLAINTEXT)

    def test_an_ancestor_loggers_filter_does_not_run_for_a_propagated_child_record(self) -> None:
        # Canary for the documented rule: attach the filter to the emitting
        # handler, not to an ancestor logger. If stdlib ever runs ancestor
        # logger filters for propagated records, this fails and the README
        # guidance can be revisited.
        stream = io.StringIO()
        parent = _logger("ancestor", logging.StreamHandler(stream))
        parent.addFilter(RedactSecretFilter(fake_scan_and_redact))
        try:
            child = logging.getLogger(f"{parent.name}.child")
            child.setLevel(logging.INFO)
            child.info("token=%s", _TOKEN + "6")
        finally:
            parent.filters.clear()
        self.assertIn(_TOKEN + "6", stream.getvalue())


class QueueHandoffTest(unittest.TestCase):
    def test_a_filtered_queue_handler_hands_the_listener_thread_only_redacted_records(self) -> None:
        records: queue.Queue = queue.Queue()
        stream = io.StringIO()
        sink = logging.StreamHandler(stream)
        sink.setFormatter(logging.Formatter("%(message)s | %(exc_text)s"))
        listener = logging.handlers.QueueListener(records, sink)
        handler = logging.handlers.QueueHandler(records)
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact))
        logger = _logger("queue", handler)

        listener.start()
        try:
            for index in range(50):
                logger.info("record %d token=%s", index, _TOKEN + str(index))
            try:
                _fail("queued " + _TOKEN + "99")
            except ValueError:
                logger.exception("failed %s", "BLOCK_ME")
        finally:
            listener.stop()

        output = stream.getvalue()
        self.assertEqual(output.count("token=<SECRET_1>"), 50)
        self.assertIn("[REDACTED:BLOCKED]", output)
        self.assertNotRegex(output, _PLAINTEXT)


class ConcurrentEmittersTest(unittest.TestCase):
    def test_threads_sharing_one_filtered_handler_never_leak_across_records(self) -> None:
        stream = io.StringIO()
        handler = logging.StreamHandler(stream)
        handler.setFormatter(logging.Formatter("%(message)s|%(ctx)s"))
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact, extra_fields=("ctx",)))
        logger = _logger("threads", handler)
        start = threading.Barrier(THREADS)

        def emit(thread: int) -> None:
            start.wait()
            for index in range(RECORDS_PER_THREAD):
                record_id = f"{thread}-{index}"
                blocked = (thread * RECORDS_PER_THREAD + index) % 7 == 0
                context = {"id": record_id, "auth": "Bearer " + _TOKEN + f"{thread}{index}"}
                if blocked:
                    context["guard"] = "BLOCK_ME"
                logger.info("record %s token=%s", record_id, _TOKEN + str(index), extra={"ctx": context})

        with ThreadPoolExecutor(max_workers=THREADS) as pool:
            list(pool.map(emit, range(THREADS)))

        output = stream.getvalue()
        self.assertNotRegex(output, _PLAINTEXT)
        lines = output.splitlines()
        self.assertEqual(len(lines), THREADS * RECORDS_PER_THREAD)
        seen = set()
        for line in lines:
            match = re.fullmatch(r"record (\d+)-(\d+) token=<SECRET_1>\|(\{.*\})", line)
            self.assertIsNotNone(match, line)
            thread, index = int(match.group(1)), int(match.group(2))
            record_id = f"{thread}-{index}"
            seen.add(record_id)
            context = ast.literal_eval(match.group(3))
            expected = {"id": record_id, "auth": "Bearer <SECRET_1>"}
            if (thread * RECORDS_PER_THREAD + index) % 7 == 0:
                expected["guard"] = "[REDACTED:BLOCKED]"
            self.assertEqual(context, expected)
        self.assertEqual(len(seen), THREADS * RECORDS_PER_THREAD)


class FailingHandlerTest(unittest.TestCase):
    def test_a_handler_that_fails_to_emit_reports_only_the_redacted_record(self) -> None:
        class BrokenHandler(logging.Handler):
            def emit(self, record: logging.LogRecord) -> None:
                try:
                    raise OSError("disk full while writing " + record.getMessage())
                except OSError:
                    self.handleError(record)

        handler = BrokenHandler()
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact))
        logger = _logger("broken", handler)

        stderr = io.StringIO()
        previous = logging.raiseExceptions
        logging.raiseExceptions = True
        try:
            with contextlib.redirect_stderr(stderr):
                logger.info("token=%s", _TOKEN + "1")
        finally:
            logging.raiseExceptions = previous

        report = stderr.getvalue()
        # handleError prints the traceback plus the record's msg and args.
        self.assertIn("--- Logging error ---", report)
        self.assertIn("token=<SECRET_1>", report)
        self.assertNotRegex(report, _PLAINTEXT)


if __name__ == "__main__":
    unittest.main()
