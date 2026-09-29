"""Where ``RedactSecretFilter`` has to be attached, and what is unprotected
when it is not (redact-secret/redact-secret-adapters#48).

A ``logging.Filter`` runs only where it is attached. That makes placement,
not the filter itself, the security decision in an application with more than
one handler, with propagating child loggers, or with a
``QueueHandler``/``QueueListener`` pair. Each positive test here is the
documented supported setup; each ``*_is_unprotected`` test is a synthetic
**negative control** that asserts plaintext really does escape the wrong
placement, so the README's guidance cannot quietly stop being true.

The scanner is the deterministic fake and every secret is built at runtime,
so no literal token text exists in this file.
"""

from __future__ import annotations

import io
import logging
import logging.handlers
import queue
import re
import unittest

from fake_scanner import fake_scan_and_redact

from redact_secret_adapters.logging_filter import RedactSecretFilter

_TOKEN = "SECRET_TOKEN" + "_"
_PLAINTEXT = re.compile(r"SECRET_TOKEN_\d|BLOCK_ME")


def _stream_handler(fmt: str = "%(message)s") -> tuple[logging.Handler, io.StringIO]:
    stream = io.StringIO()
    handler = logging.StreamHandler(stream)
    handler.setFormatter(logging.Formatter(fmt))
    return handler, stream


def _fail(detail: str) -> None:
    # Raising from a helper keeps the secret out of the source line a
    # formatted traceback echoes back.
    raise ValueError(detail)


def _logger(name: str, *handlers: logging.Handler) -> logging.Logger:
    logger = logging.getLogger(f"redact_secret_adapters.placement.{name}")
    logger.handlers[:] = list(handlers)
    logger.filters.clear()
    logger.setLevel(logging.INFO)
    logger.propagate = False
    return logger


class MultipleHandlersTest(unittest.TestCase):
    def test_a_filter_on_every_emitting_handler_protects_every_destination(self) -> None:
        # The supported multi-handler setup: one filter instance per handler.
        console, console_out = _stream_handler()
        audit, audit_out = _stream_handler("%(levelname)s %(message)s")
        for handler in (console, audit):
            handler.addFilter(RedactSecretFilter(fake_scan_and_redact))
        logger = _logger("every-handler", console, audit)

        logger.info("token=%s", _TOKEN + "1")

        self.assertEqual(console_out.getvalue(), "token=<SECRET_1>\n")
        self.assertEqual(audit_out.getvalue(), "INFO token=<SECRET_1>\n")

    def test_one_filter_instance_shared_by_two_handlers_protects_both(self) -> None:
        # The filter holds no per-record state, so one instance can be shared.
        console, console_out = _stream_handler()
        audit, audit_out = _stream_handler()
        shared = RedactSecretFilter(fake_scan_and_redact)
        console.addFilter(shared)
        audit.addFilter(shared)
        logger = _logger("shared-filter", console, audit)

        logger.info("token=%s", _TOKEN + "2")

        self.assertEqual(console_out.getvalue(), "token=<SECRET_1>\n")
        self.assertEqual(audit_out.getvalue(), "token=<SECRET_1>\n")

    def test_masking_an_already_masked_record_twice_changes_nothing(self) -> None:
        # Two filtered handlers means two filter passes over one record. The
        # second sees text the first already masked and must leave it alone.
        first, first_out = _stream_handler()
        second, second_out = _stream_handler()
        for handler in (first, second):
            handler.addFilter(RedactSecretFilter(fake_scan_and_redact))
        logger = _logger("idempotent", first, second)

        logger.info("token=%s and %s", _TOKEN + "3", "plain")

        self.assertEqual(first_out.getvalue(), second_out.getvalue())
        self.assertEqual(first_out.getvalue(), "token=<SECRET_1> and plain\n")

    def test_an_earlier_unfiltered_handler_is_unprotected(self) -> None:
        # Negative control. Handlers run in order and the filter only runs on
        # its own handler, so a destination before it sees plaintext. This is
        # the ordering the README warns about.
        early, early_out = _stream_handler()
        late, late_out = _stream_handler()
        late.addFilter(RedactSecretFilter(fake_scan_and_redact))
        logger = _logger("unfiltered-first", early, late)

        secret = _TOKEN + "4"
        logger.info("token=%s", secret)

        self.assertIn(secret, early_out.getvalue())
        self.assertEqual(late_out.getvalue(), "token=<SECRET_1>\n")

    def test_a_handler_after_a_filtered_one_sees_the_masked_record(self) -> None:
        # The other ordering is safe, and is why a filter on the *first*
        # handler is not a substitute for filtering each one: it happens to
        # work, and stops working the moment handler order changes.
        early, early_out = _stream_handler()
        early.addFilter(RedactSecretFilter(fake_scan_and_redact))
        late, late_out = _stream_handler()
        logger = _logger("filtered-first", early, late)

        logger.info("token=%s", _TOKEN + "5")

        self.assertEqual(early_out.getvalue(), "token=<SECRET_1>\n")
        self.assertEqual(late_out.getvalue(), "token=<SECRET_1>\n")


class PropagationTest(unittest.TestCase):
    def test_a_filter_on_an_ancestors_handler_covers_a_propagated_child_record(self) -> None:
        # The supported setup for propagation: the filter sits on the handler
        # that emits, wherever in the hierarchy that handler is attached.
        handler, out = _stream_handler()
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact))
        parent = _logger("propagation", handler)
        child = logging.getLogger(f"{parent.name}.child")
        child.handlers[:] = []
        child.setLevel(logging.INFO)
        child.propagate = True

        child.info("token=%s", _TOKEN + "6")

        self.assertEqual(out.getvalue(), "token=<SECRET_1>\n")

    def test_a_filter_on_an_ancestor_logger_is_unprotected_for_a_propagated_record(self) -> None:
        # Negative control: ``Logger.filter`` runs in ``Logger.handle`` for
        # the logger the call was made on, never for an ancestor a record
        # propagates to. A filter attached to the parent *logger* is not a
        # boundary for its children.
        handler, out = _stream_handler()
        parent = _logger("ancestor-logger", handler)
        parent.addFilter(RedactSecretFilter(fake_scan_and_redact))
        child = logging.getLogger(f"{parent.name}.child")
        child.handlers[:] = []
        child.setLevel(logging.INFO)
        child.propagate = True

        secret = _TOKEN + "7"
        try:
            child.info("token=%s", secret)
        finally:
            parent.filters.clear()

        self.assertIn(secret, out.getvalue())

    def test_a_child_with_its_own_unfiltered_handler_is_unprotected(self) -> None:
        # Negative control: a filter on the parent's handler says nothing
        # about a handler the child carries itself.
        parent_handler, parent_out = _stream_handler()
        parent_handler.addFilter(RedactSecretFilter(fake_scan_and_redact))
        parent = _logger("child-handler", parent_handler)
        child_handler, child_out = _stream_handler()
        child = logging.getLogger(f"{parent.name}.child")
        child.handlers[:] = [child_handler]
        child.setLevel(logging.INFO)
        child.propagate = True

        secret = _TOKEN + "8"
        child.info("token=%s", secret)

        self.assertIn(secret, child_out.getvalue())
        self.assertEqual(parent_out.getvalue(), "token=<SECRET_1>\n")


class QueuePlacementTest(unittest.TestCase):
    def test_a_filtered_queue_handler_puts_only_masked_records_on_the_queue(self) -> None:
        # The supported setup for a queue: the filter goes on the
        # ``QueueHandler``, the handler that runs in the emitting thread, so
        # what crosses the queue is already masked.
        records: queue.Queue = queue.Queue()
        handler = logging.handlers.QueueHandler(records)
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact))
        logger = _logger("queue-handler", handler)

        logger.info("token=%s", _TOKEN + "9")

        queued = records.get_nowait()
        self.assertEqual(queued.getMessage(), "token=<SECRET_1>")
        self.assertIsNone(queued.args)

    def test_a_filter_only_on_the_listener_sink_leaves_plaintext_on_the_queue(self) -> None:
        # Negative control. The listener's own handlers do protect the final
        # destination, but the record sat on the queue in the clear first --
        # and a ``QueueHandler`` subclass that serializes elsewhere (a socket,
        # a multiprocessing queue) would have sent it there unmasked.
        records: queue.Queue = queue.Queue()
        sink, out = _stream_handler()
        sink.addFilter(RedactSecretFilter(fake_scan_and_redact))
        listener = logging.handlers.QueueListener(records, sink)
        logger = _logger("listener-only", logging.handlers.QueueHandler(records))

        secret = _TOKEN + "10"
        logger.info("token=%s", secret)

        queued = records.queue[0]
        self.assertIn(secret, queued.getMessage())

        # `stop()` drains what is already queued before the thread exits, so
        # the final destination is still protected -- only the queue was not.
        listener.start()
        listener.stop()
        self.assertEqual(out.getvalue(), "token=<SECRET_1>\n")


class HostBehaviorTest(unittest.TestCase):
    def test_formatter_extra_fields_and_exception_logging_survive_the_placement(self) -> None:
        # Nothing about attaching the filter to several handlers changes the
        # host's own configuration: each handler keeps its own formatter, and
        # a named extra and an exception still render.
        console, console_out = _stream_handler("%(levelname)s %(message)s user=%(user)s")
        audit, audit_out = _stream_handler("%(message)s|%(exc_text)s")
        for handler in (console, audit):
            handler.addFilter(RedactSecretFilter(fake_scan_and_redact, extra_fields=("user",)))
        logger = _logger("host-behavior", console, audit)

        try:
            _fail("upstream said " + _TOKEN + "11")
        except ValueError:
            logger.exception("token=%s", _TOKEN + "12", extra={"user": "alice " + _TOKEN + "13"})

        self.assertIn("ERROR token=<SECRET_1> user=alice <SECRET_1>", console_out.getvalue())
        self.assertIn("ValueError: upstream said <SECRET_1>", audit_out.getvalue())
        for output in (console_out.getvalue(), audit_out.getvalue()):
            self.assertNotRegex(output, _PLAINTEXT)

    def test_a_record_with_no_secret_is_formatted_exactly_as_without_the_filter(self) -> None:
        plain, plain_out = _stream_handler("%(levelname)s %(name)s %(message)s")
        filtered, filtered_out = _stream_handler("%(levelname)s %(name)s %(message)s")
        filtered.addFilter(RedactSecretFilter(fake_scan_and_redact))
        logger = _logger("unchanged", plain, filtered)

        logger.warning("user %s logged in from %s", "alice", "10.0.0.1")

        self.assertEqual(filtered_out.getvalue(), plain_out.getvalue())


if __name__ == "__main__":
    unittest.main()
