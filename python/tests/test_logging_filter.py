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

from fake_scanner import fake_scan_and_redact

from redact_secret_adapters.logging_filter import RedactSecretFilter
from redact_secret_adapters.mask_leaf import BLOCK_MARKER, ERROR_MARKER
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
        logger.info("request received", extra={"request_id": "req-1", "auth_header": "Bearer SECRET_TOKEN_1"})

        captured = []
        handler.addFilter(lambda record: captured.append(record) or True)
        logger.info("second call", extra={"request_id": "req-2", "auth_header": "Bearer SECRET_TOKEN_1"})
        self.assertEqual(captured[0].auth_header, "Bearer <SECRET_1>")
        self.assertEqual(captured[0].request_id, "req-2")

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
        calls: list[str] = []

        def counting_scanner(text, policy=None):
            calls.append(text)
            return fake_scan_and_redact(text, policy)

        handler = ListHandler()
        handler.addFilter(RedactSecretFilter(counting_scanner))
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
        self.assertEqual(len(calls), 2)
        self.assertIn("The above exception was the direct cause", record.exc_text)
        self.assertIn("<SECRET_1>", record.exc_text)
        self.assertNotIn(_SECRET, record.exc_text)

    def test_rejects_a_non_callable_scan_and_redact(self) -> None:
        with self.assertRaises(TypeError):
            RedactSecretFilter(None)


if __name__ == "__main__":
    unittest.main()
