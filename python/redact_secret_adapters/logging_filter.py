"""Redact messages, exceptions, stack text, and configured string extras.

The filter formats ``msg`` with ``args`` before scanning, then clears the
arguments so downstream formatters cannot reconstruct the original message.
It replaces ``exc_info`` with sanitized traceback text and also scans cached
``exc_text`` when the exception tuple is absent.

Attach the filter to each emitting handler. Ancestor logger filters do not
run for propagated child records; mutations to a record are shared by its
handlers. Custom formatters must not add unscanned fields afterward.

**If you want PII, enable it before the first record.** Credential detection
needs no init step -- the native extension loads on ``import redact_secret``,
unlike the JS package's mandatory ``await initialize()``. PII detection is
opt-in, process-wide and one-shot, and the application turns it on with
``redact_secret.initialize(pii=[...])``::

    import logging
    import redact_secret
    from redact_secret_adapters.logging_filter import RedactSecretFilter

    redact_secret.initialize(pii=["pii:global"])  # first, before any logging

    handler = logging.StreamHandler()
    handler.addFilter(RedactSecretFilter())
    logging.getLogger().addHandler(handler)

The order matters and is easy to get wrong, because handlers are usually
attached at import time and a module imported earlier can log before the
line that enables PII has run. Python's binding raises no conflict for a late
call -- it locks nothing that ``active_pii_selection()`` reads -- so there is
no error to catch, only a **silent window** in which records are scanned with
PII off and report nothing. This filter cannot close it: it never learns when
the process decided to enable PII. ``python/tests/test_pii_activation.py``
pins the window as a known limitation rather than hiding it.

Activating PII is also not the same as masking every PII value. Under the
core's default policy PII types are confidence-gated: ``High`` redacts, while
``Medium`` and ``Low`` resolve to ``warn``, and a ``warn`` finding leaves the
text alone (see ``mask_leaf.py``), so lower-confidence PII still reaches the
handler as plaintext. Pass your own ``policy`` mapping those findings to
``redact`` if you need them masked. The outcome counters make it observable:
such a record counts ``scanned`` with a non-zero ``findings`` and no
``redacted``.
"""

from __future__ import annotations

import logging
import threading
import warnings
from typing import Any, Callable, Optional, Sequence

from ._walk import mask_exception_text_with, walk
from .budget import OperationBudget
from .mask_leaf import ERROR_MARKER, LIMIT_MARKER, count_leaf, mask_leaf_outcome_with
from .outcome import LogRecordOutcome, OutcomeCounter, notify

__all__ = ["RedactSecretFilter"]


# Default for ``scan_and_redact``: not ``None``, so an explicit
# ``RedactSecretFilter(None)`` raises instead of selecting the live scanner.
_LIVE: Any = object()


class RedactSecretFilter(logging.Filter):
    """Redacts a ``LogRecord`` in place and always returns ``True`` (never
    drops a record; a `block` finding replaces the affected text with a
    fixed marker instead, matching the JS `hooks.logMethod` integration's
    ``BLOCK_MARKER`` behavior).

    ``scan_and_redact`` is injected -- omit it for the live integration,
    which resolves ``redact_secret.scan_and_redact`` on construction, or
    pass a fake for tests (this module is testable without the built
    native extension). ``extra_fields`` names attributes set via a log
    call's ``extra={...}`` kwarg to also redact: a string is masked, and a
    dict/list/tuple/exception is walked like ``mask_log_value_with`` and
    replaced by its masked copy; a number, bool or ``None`` is kept, and any
    other object (a set, bytes, a dataclass, ...) fails closed to
    ``ERROR_MARKER`` (see ``_walk.py``). Unlisted attributes are left untouched,
    since this filter never assumes a wire format wide enough to know every
    possible extra field.
    """

    def __init__(
        self,
        scan_and_redact: Callable[..., Any] = _LIVE,
        *,
        name: str = "",
        policy: Optional[Any] = None,
        extra_fields: Sequence[str] = (),
        limits: Optional[dict[str, int]] = None,
        operation_limits: Optional[dict[str, int]] = None,
        on_outcome: Optional[Callable[[LogRecordOutcome], None]] = None,
    ) -> None:
        if name:
            # logging.Filter's name would drop records from other loggers,
            # and filter() has never honored it: skipping or dropping records
            # is not this filter's job. Kept only so 0.1.0 callers still work.
            warnings.warn(
                "RedactSecretFilter(name=...) is ignored and will be removed; "
                "attach the filter to the handlers or logger it should cover instead",
                DeprecationWarning,
                stacklevel=2,
            )
        super().__init__(name)
        if scan_and_redact is _LIVE:
            # The live wrapper: the only place this module touches the core.
            import redact_secret

            scan_and_redact = redact_secret.scan_and_redact
        if not callable(scan_and_redact):
            raise TypeError("RedactSecretFilter: scan_and_redact must be callable")
        self._scan_and_redact = scan_and_redact
        self._policy = policy
        # A bare string names one field; tuple("auth") would name four.
        self._extra_fields = (extra_fields,) if isinstance(extra_fields, str) else tuple(extra_fields)
        self._limits = limits
        # The aggregate budget of one ``filter()`` call (see ``budget.py``):
        # the message, the exception text, the stack and every extra field
        # share it, so many individually valid fields cannot multiply the
        # work. Each call gets a fresh one, so threads and records never share.
        self._operation_limits = operation_limits
        if on_outcome is not None and not callable(on_outcome):
            raise TypeError("RedactSecretFilter: on_outcome must be callable")
        self._on_outcome = on_outcome
        # A filter instance can be shared by handlers and used from threads, so
        # re-entrancy is the only state kept here, and only to stop an observer
        # that logs from recursing. It is thread-local, so one thread reporting
        # never suppresses another's outcome. Counting state is per
        # ``filter()`` call.
        self._state = threading.local()

    def _mask(self, text: str, counter: Optional[OutcomeCounter], budget: OperationBudget) -> str:
        if not budget.charge_node() or not budget.charge_leaf():
            if counter is not None:
                counter.limited += 1
            return LIMIT_MARKER
        max_len = (self._limits or {}).get("max_string_length")
        leaf = mask_leaf_outcome_with(
            self._scan_and_redact, text, policy=self._policy, max_string_length=max_len, budget=budget
        )
        count_leaf(counter, leaf)
        return leaf.text

    def filter(self, record: logging.LogRecord) -> bool:
        # One counter per ``filter()`` call: a record passing through two
        # filtered handlers is two units of work and reports twice, which is
        # what a per-handler count means. Nothing is shared between calls.
        counter = OutcomeCounter() if self._on_outcome is not None else None
        budget = OperationBudget(self._operation_limits)

        try:
            message = record.getMessage()
        except Exception:
            # A bad %-format (wrong arg count or type) or a raising __str__.
            # Left alone, the handler's handleError would print msg and args
            # to stderr in the clear; the message is unrecoverable, so mark it.
            record.msg = ERROR_MARKER
            if counter is not None:
                counter.failed += 1
        else:
            record.msg = self._mask(message, counter, budget)
        record.args = None

        exc_value = None
        if record.exc_info:
            if isinstance(record.exc_info, tuple) and len(record.exc_info) == 3:
                exc_value = record.exc_info[1]
            record.exc_info = None
        if isinstance(exc_value, BaseException):
            record.exc_text = mask_exception_text_with(
                self._scan_and_redact,
                exc_value,
                policy=self._policy,
                limits=self._limits,
                counter=counter,
                budget=budget,
            )
        elif record.exc_text:
            # Also reached with exc_info == (None, None, None): a cached
            # exc_text still renders and must be scanned.
            record.exc_text = self._mask(record.exc_text, counter, budget)

        if record.stack_info:
            record.stack_info = self._mask(record.stack_info, counter, budget)

        for field in self._extra_fields:
            if hasattr(record, field):
                # A new, masked container: the caller's own object is untouched.
                try:
                    masked = walk(
                        self._scan_and_redact,
                        getattr(record, field),
                        policy=self._policy,
                        limits=self._limits,
                        counter=counter,
                        key=field,
                        budget=budget,
                    )
                except Exception:
                    # walk() degrades per key and element and should never
                    # raise; if it does, the extra is lost, not the record.
                    masked = ERROR_MARKER
                    if counter is not None:
                        counter.failed += 1
                setattr(record, field, masked)

        if counter is not None:
            self._report(record, counter)
        return True

    def _report(self, record: logging.LogRecord, counter: OutcomeCounter) -> None:
        """Reports one outcome per record, after the record is fully masked so
        an observer cannot turn a protected record into an unprotected one."""
        if getattr(self._state, "reporting", False):
            # An observer that logs would otherwise re-enter this filter.
            return
        self._state.reporting = True
        try:
            notify(self._on_outcome, LogRecordOutcome(level=record.levelno, values=counter.snapshot()))
        finally:
            self._state.reporting = False
