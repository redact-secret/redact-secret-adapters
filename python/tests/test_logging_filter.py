"""Tests for RedactSecretFilter and mask_log_value_with. They need nothing
beyond the standard library and pytest -- not even the built redact_secret
extension: a fake scanner stands in for the core, and a real
``logging.Logger`` with the filter attached is the host.
"""

from __future__ import annotations

import contextlib
import io
import json
import logging
import unittest
from pathlib import Path

from fake_scanner import RecordingScanner, fake_scan_and_redact

from redact_secret_adapters.logging_filter import RedactSecretFilter
from redact_secret_adapters.mask_leaf import BLOCK_MARKER, ERROR_MARKER, LIMIT_MARKER
from redact_secret_adapters.mask_log_value import mask_log_value_with

FIXTURES_PATH = Path(__file__).resolve().parents[2] / "fixtures" / "logging-redaction-cases.json"

# Built from two literals so the full token never appears contiguously in
# this file's source: `fake_scan_and_redact` redacts only the first match
# per call (matching the real core's per-call behavior, not its ability to
# find every occurrence in one string), and `traceback.format_exception`
# echoes each frame's raw source line -- a literal secret in the `raise`
# call or any of its callers would appear a second, unredacted time there.
_SECRET = "SECRET_TOKEN" + "_1"


class SharedFixtureTest(unittest.TestCase):
    """The same fixture file `pino-hook.test.mjs` reads, proving JS and
    Python agree on message strings, merging/extra fields, nesting,
    arrays, and Unicode."""

    def test_shared_cases(self) -> None:
        cases = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))["cases"]
        for case in cases:
            with self.subTest(name=case["name"]):
                result = mask_log_value_with(fake_scan_and_redact, case["input"])
                self.assertEqual(result, case["expected"])


class MaskLogValueWithTest(unittest.TestCase):
    def test_exception_whose_str_raises_gets_an_error_marker_message(self) -> None:
        masked = mask_log_value_with(fake_scan_and_redact, _RaisingStrError(_SECRET))
        self.assertEqual(masked["type"], "_RaisingStrError")
        self.assertEqual(masked["message"], ERROR_MARKER)
        self.assertNotIn(_SECRET, json.dumps(masked))

    def test_exception_own_attributes_are_walked(self) -> None:
        error = ValueError("request failed")
        error.status = 401
        error.headers = {"authorization": "Bearer " + _SECRET}
        error.__notes__ = ["retry with " + _SECRET]  # what add_note() sets on 3.11+
        masked = mask_log_value_with(fake_scan_and_redact, error)
        self.assertEqual(masked["message"], "request failed")
        self.assertEqual(masked["status"], 401)
        self.assertEqual(masked["headers"], {"authorization": "Bearer <SECRET_1>"})
        self.assertEqual(masked["__notes__"], ["retry with <SECRET_1>"])
        self.assertNotIn(_SECRET, json.dumps(masked))

    def test_exception_cause_is_walked(self) -> None:
        try:
            try:
                _raise_with_secret(_SECRET)
            except ValueError as inner:
                raise RuntimeError("wrapper") from inner
        except RuntimeError as outer:
            masked = mask_log_value_with(fake_scan_and_redact, outer)
        self.assertEqual(masked["cause"]["type"], "ValueError")
        self.assertEqual(masked["cause"]["message"], "db write failed: <SECRET_1>")


class ListHandler(logging.Handler):
    """Captures fully formatted (`Formatter.format`-ed) lines, so a test
    can assert on exactly what would have reached a real destination."""

    def __init__(self) -> None:
        super().__init__()
        self.lines: list[str] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(self.format(record))


def _raise_with_secret(secret: str) -> None:
    # `fake_scan_and_redact` (like every fixture fake in this repo)
    # redacts only the first match per call, matching the real core's
    # per-call behavior but not its ability to find every occurrence in
    # one string; that's irrelevant here as long as the secret literal
    # appears exactly once in the rendered traceback. Building the
    # message from a variable, instead of a literal in the `raise` line,
    # keeps it out of the traceback's source-context line, which would
    # otherwise print the raw literal from this file a second time.
    raise ValueError("db write failed: " + secret)


class _RaisingStrError(ValueError):
    def __str__(self) -> str:
        raise RuntimeError("__str__ failed")


def make_logger(name: str, *, extra_fields: tuple[str, ...] = ()) -> tuple[logging.Logger, ListHandler]:
    logger = logging.getLogger(name)
    logger.setLevel(logging.DEBUG)
    logger.propagate = False
    for existing in list(logger.handlers):
        logger.removeHandler(existing)
    handler = ListHandler()
    handler.setFormatter(logging.Formatter("%(message)s"))
    handler.addFilter(RedactSecretFilter(fake_scan_and_redact, extra_fields=list(extra_fields)))
    logger.addHandler(handler)
    return logger, handler


class RedactSecretFilterTest(unittest.TestCase):
    def test_percent_style_args_are_redacted_and_no_plaintext_is_emitted(self) -> None:
        logger, handler = make_logger("logging-redaction.percent")
        logger.info("user %s presented token %s", "alice", "SECRET_TOKEN_1")
        self.assertEqual(handler.lines, ["user alice presented token <SECRET_1>"])

    def test_f_string_message_is_redacted(self) -> None:
        logger, handler = make_logger("logging-redaction.fstring")
        token = "SECRET_TOKEN_1"
        logger.info(f"token was {token}")
        self.assertEqual(handler.lines, ["token was <SECRET_1>"])

    def test_exc_info_traceback_is_redacted_and_exc_info_is_cleared(self) -> None:
        logger, handler = make_logger("logging-redaction.exc")
        try:
            _raise_with_secret(_SECRET)
        except ValueError:
            logger.exception("query failed")
        self.assertEqual(len(handler.lines), 1)
        self.assertIn("query failed", handler.lines[0])
        self.assertIn("<SECRET_1>", handler.lines[0])
        self.assertNotIn("SECRET_TOKEN_1", handler.lines[0])

        captured = []

        def capture(record: logging.LogRecord) -> bool:
            captured.append(record)
            return True

        logger2, handler2 = make_logger("logging-redaction.exc-info-cleared")
        # Added to the handler, after RedactSecretFilter, so it observes
        # the record post-redaction: Handler-level filters run in
        # addFilter order inside Handler.handle, which fires only after
        # Logger-level filtering has already passed the record through.
        handler2.addFilter(capture)
        try:
            _raise_with_secret(_SECRET)
        except ValueError:
            logger2.exception("query failed")
        self.assertIsNone(captured[0].exc_info)
        self.assertIn("<SECRET_1>", captured[0].exc_text)

    def test_cached_exception_text_without_exc_info_is_redacted(self) -> None:
        _, handler = make_logger("logging-redaction.cached-exception")
        record = logging.makeLogRecord({"msg": "query failed", "exc_text": "ValueError: " + _SECRET})
        handler.handle(record)
        self.assertIsNone(record.exc_info)
        self.assertEqual(handler.lines, ["query failed\nValueError: <SECRET_1>"])

    def test_cached_exception_text_with_an_empty_exc_info_tuple_is_redacted(self) -> None:
        handler = ListHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact))
        record = logging.makeLogRecord(
            {"msg": "query failed", "exc_info": (None, None, None), "exc_text": "ValueError: " + _SECRET}
        )
        handler.handle(record)
        self.assertIsNone(record.exc_info)
        self.assertEqual(handler.lines, ["query failed\nValueError: <SECRET_1>"])

    def test_exception_depth_limit_emits_marker(self) -> None:
        handler = ListHandler()
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact, limits={"max_depth": 0}))
        error = ValueError(_SECRET)
        record = logging.makeLogRecord({"msg": "query failed", "exc_info": (ValueError, error, None)})
        handler.handle(record)
        self.assertIsNone(record.exc_info)
        self.assertEqual(handler.lines, ["query failed\n[REDACTED:LIMIT_EXCEEDED]"])

    def test_configured_extra_string_field_is_redacted(self) -> None:
        logger, handler = make_logger("logging-redaction.extra", extra_fields=("request_id", "auth_header"))
        handler.setFormatter(logging.Formatter("%(message)s %(request_id)s %(auth_header)s"))
        logger.info("request received", extra={"request_id": "req-1", "auth_header": "Bearer SECRET_TOKEN_1"})
        self.assertEqual(handler.lines, ["request received req-1 Bearer <SECRET_1>"])

    def test_a_bare_string_extra_fields_names_one_field(self) -> None:
        handler = ListHandler()
        handler.setFormatter(logging.Formatter("%(message)s %(auth)s"))
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact, extra_fields="auth"))
        handler.handle(logging.makeLogRecord({"msg": "request", "auth": "Bearer SECRET_TOKEN_1"}))
        self.assertEqual(handler.lines, ["request Bearer <SECRET_1>"])

    def test_configured_dict_and_list_extras_are_walked_without_mutating_the_callers_object(self) -> None:
        logger, handler = make_logger("logging-redaction.extra-containers", extra_fields=("headers", "tags"))
        captured = []
        handler.addFilter(lambda record: captured.append(record) or True)
        headers = {"authorization": "Bearer SECRET_TOKEN_1", "nested": {"cookie": ("s=SECRET_TOKEN_2",)}}
        logger.info("request", extra={"headers": headers, "tags": ["ok", "SECRET_TOKEN_3 x"]})
        self.assertEqual(
            captured[0].headers, {"authorization": "Bearer <SECRET_1>", "nested": {"cookie": ("s=<SECRET_1>",)}}
        )
        self.assertEqual(captured[0].tags, ["ok", "<SECRET_1> x"])
        self.assertEqual(headers["authorization"], "Bearer SECRET_TOKEN_1")

    def test_unconfigured_extra_field_is_left_untouched(self) -> None:
        logger, handler = make_logger("logging-redaction.extra-unconfigured", extra_fields=())
        captured = []
        handler.addFilter(lambda record: captured.append(record) or True)
        logger.info("request received", extra={"auth_header": "Bearer SECRET_TOKEN_1"})
        self.assertEqual(captured[0].auth_header, "Bearer SECRET_TOKEN_1")

    def test_block_finding_replaces_the_whole_message(self) -> None:
        logger, handler = make_logger("logging-redaction.block")
        logger.info("prefix BLOCK_ME suffix")
        self.assertEqual(handler.lines, [BLOCK_MARKER])

    def test_core_failure_fails_closed(self) -> None:
        logger, handler = make_logger("logging-redaction.error")
        logger.info("trigger BOOM here")
        self.assertEqual(handler.lines, [ERROR_MARKER])

    def test_malformed_percent_args_emit_the_error_marker_and_never_the_args(self) -> None:
        class RaisingStr:
            def __str__(self) -> str:
                raise RuntimeError("str failed")

        logger, handler = make_logger("logging-redaction.malformed-args")
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            logger.info("value", "SECRET_TOKEN_1")  # too many args
            logger.info("%d", "SECRET_TOKEN_1")  # wrong type
            logger.info("%s %s", "SECRET_TOKEN_1")  # too few args
            logger.info(RaisingStr())
        self.assertEqual(handler.lines, [ERROR_MARKER] * 4)
        self.assertNotIn("SECRET_TOKEN_1", stderr.getvalue())

    def test_exception_whose_str_raises_does_not_crash_logger_exception(self) -> None:
        logger, handler = make_logger("logging-redaction.raising-str")
        try:
            raise _RaisingStrError(_SECRET)
        except _RaisingStrError:
            logger.exception("query failed")  # must not raise
        self.assertEqual(len(handler.lines), 1)
        self.assertTrue(handler.lines[0].startswith("query failed\nTraceback"))
        self.assertNotIn(_SECRET, handler.lines[0])

    def test_exc_info_is_scanned_once_as_one_traceback(self) -> None:
        scanner = RecordingScanner()
        handler = ListHandler()
        handler.addFilter(RedactSecretFilter(scanner))
        try:
            try:
                _raise_with_secret(_SECRET)
            except ValueError as inner:
                raise RuntimeError("wrapper") from inner
        except RuntimeError as outer:
            record = logging.makeLogRecord({"msg": "query failed", "exc_info": (RuntimeError, outer, None)})
        handler.handle(record)
        # One scan for the message, one for the whole traceback -- which
        # already carries the cause chain.
        self.assertEqual(len(scanner.calls), 2)
        self.assertIn("The above exception was the direct cause", record.exc_text)
        self.assertIn("<SECRET_1>", record.exc_text)
        self.assertNotIn(_SECRET, record.exc_text)

    def test_shared_fixture_cases_through_the_filter(self) -> None:
        """The shared logging fixture again, through the filter's own paths:
        a string case as the log message, a structured case as a listed
        extra."""
        cases = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))["cases"]
        for case in cases:
            with self.subTest(name=case["name"]):
                logger, handler = make_logger("logging-redaction.fixture", extra_fields=("payload",))
                captured = []
                handler.addFilter(lambda record: captured.append(record) or True)
                if isinstance(case["input"], str):
                    logger.info(case["input"])
                    self.assertEqual(handler.lines, [case["expected"]])
                else:
                    logger.info("event", extra={"payload": case["input"]})
                    self.assertEqual(captured[0].payload, case["expected"])

    def test_dict_args_are_formatted_then_redacted(self) -> None:
        logger, handler = make_logger("logging-redaction.dict-args")
        logger.info("user %(user)s token %(token)s", {"user": "alice", "token": "SECRET_TOKEN_1"})
        self.assertEqual(handler.lines, ["user alice token <SECRET_1>"])

    def test_stack_info_is_redacted(self) -> None:
        _, handler = make_logger("logging-redaction.stack-info")
        record = logging.makeLogRecord(
            {"msg": "checkpoint", "stack_info": "Stack (most recent call last):\n  " + _SECRET}
        )
        handler.handle(record)
        self.assertEqual(handler.lines, ["checkpoint\nStack (most recent call last):\n  <SECRET_1>"])

        logger, handler = make_logger("logging-redaction.stack-info-real")
        logger.info("checkpoint %s", "SECRET_TOKEN_1", stack_info=True)
        self.assertTrue(handler.lines[0].startswith("checkpoint <SECRET_1>\nStack (most recent call last):"))

    def test_filter_attached_to_the_logger_redacts_for_every_handler(self) -> None:
        logger = logging.getLogger("logging-redaction.logger-level")
        logger.setLevel(logging.DEBUG)
        logger.propagate = False
        for existing in list(logger.handlers):
            logger.removeHandler(existing)
        for existing in list(logger.filters):
            logger.removeFilter(existing)
        handler = ListHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        logger.addHandler(handler)
        logger.addFilter(RedactSecretFilter(fake_scan_and_redact))
        logger.info("token %s", "SECRET_TOKEN_1")
        self.assertEqual(handler.lines, ["token <SECRET_1>"])

    def test_two_filtered_handlers_both_emit_the_redacted_line(self) -> None:
        logger, first = make_logger("logging-redaction.two-handlers")
        second = ListHandler()
        second.setFormatter(logging.Formatter("%(message)s"))
        second.addFilter(RedactSecretFilter(fake_scan_and_redact))
        logger.addHandler(second)
        logger.info("token %s", "SECRET_TOKEN_1")
        logger.info("prefix BLOCK_ME suffix")
        self.assertEqual(first.lines, ["token <SECRET_1>", BLOCK_MARKER])
        self.assertEqual(second.lines, ["token <SECRET_1>", BLOCK_MARKER])

    def test_max_string_length_limit_applies_to_the_message_and_exc_text(self) -> None:
        handler = ListHandler()
        handler.setFormatter(logging.Formatter("%(message)s"))
        handler.addFilter(RedactSecretFilter(fake_scan_and_redact, limits={"max_string_length": 12}))
        handler.handle(logging.makeLogRecord({"msg": "short"}))
        handler.handle(logging.makeLogRecord({"msg": "token %s", "args": ("SECRET_TOKEN_1",)}))
        handler.handle(logging.makeLogRecord({"msg": "short", "exc_text": "ValueError: " + _SECRET}))
        self.assertEqual(handler.lines, ["short", LIMIT_MARKER, "short\n" + LIMIT_MARKER])

    def test_policy_reaches_the_scanner_on_every_path(self) -> None:
        policy = object()
        scanner = RecordingScanner()
        handler = ListHandler()
        handler.addFilter(RedactSecretFilter(scanner, policy=policy, extra_fields=("payload",)))
        record = logging.makeLogRecord(
            {
                "msg": "query failed",
                "exc_info": (ValueError, ValueError("x"), None),
                "stack_info": "stack",
                "payload": {"k": "v"},
            }
        )
        handler.handle(record)
        self.assertEqual(len(scanner.calls), 4)
        self.assertTrue(all(called_policy is policy for _, called_policy in scanner.calls))

    def test_rejects_a_non_callable_scan_and_redact(self) -> None:
        with self.assertRaises(TypeError):
            RedactSecretFilter(None)


if __name__ == "__main__":
    unittest.main()
