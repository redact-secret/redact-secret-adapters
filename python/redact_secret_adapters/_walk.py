"""The one value-tree walker (L2) behind ``mask_secrets_with`` and
``mask_log_value_with``, mirroring ``packages/adapter/src/walk.ts`` and the
walk in ``mask-log-value.ts``.

Walked: ``str`` leaves; ``dict`` and its subclasses (``OrderedDict``,
``defaultdict``, ...), returned as a plain ``dict``; ``list`` and its
subclasses, returned as a plain ``list``; tuples, returned as a plain
``tuple``; and exceptions, returned as a ``{"type", "message", "stack",
"cause"}`` mapping plus one key per attribute in the exception's
``__dict__``. Everything else is returned unchanged.
"""

from __future__ import annotations

import traceback
from typing import Any, Callable, Optional

from .mask_leaf import (
    CYCLE_MARKER,
    DEFAULT_LIMITS,
    ERROR_MARKER,
    LIMIT_MARKER,
    count_leaf,
    mask_leaf_outcome_with,
)
from .outcome import OutcomeCounter


class _Walk:
    __slots__ = ("scan_and_redact", "policy", "limits", "leaves", "seen", "counter")

    def __init__(
        self,
        scan_and_redact: Callable[..., Any],
        policy: Any,
        limits: Optional[dict[str, int]],
        counter: Optional[OutcomeCounter] = None,
    ) -> None:
        self.scan_and_redact = scan_and_redact
        self.policy = policy
        self.limits = {**DEFAULT_LIMITS, **(limits or {})}
        self.leaves = self.limits["max_total_leaves"]
        self.seen: set[int] = set()
        # Caller-owned; see ``outcome.py``. ``None`` means nothing is counted.
        self.counter = counter

    def marker(self, marker: str) -> str:
        """Counts a marker produced for a whole value rather than a scanned
        leaf: a container past ``max_depth``, a cycle, an unreadable value.
        ``CYCLE_MARKER`` joins ``failed`` -- both are values the walk could
        not represent."""
        if self.counter is not None:
            if marker == LIMIT_MARKER:
                self.counter.limited += 1
            else:
                self.counter.failed += 1
        return marker

    def string(self, value: str) -> str:
        if self.leaves <= 0:
            if self.counter is not None:
                self.counter.limited += 1
            return LIMIT_MARKER
        self.leaves -= 1
        leaf = mask_leaf_outcome_with(
            self.scan_and_redact, value, policy=self.policy, max_string_length=self.limits["max_string_length"]
        )
        count_leaf(self.counter, leaf)
        return leaf.text

    def stack(self, exc: BaseException) -> str:
        try:
            formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        except Exception:
            return self.marker(ERROR_MARKER)
        return self.string(formatted)

    def exception(self, exc: BaseException, depth: int) -> dict[str, Any]:
        try:
            message = str(exc)
        except Exception:
            # A raising __str__ must not escape into logger.exception().
            message = None
        out: dict[str, Any] = {
            "type": type(exc).__name__,
            "message": self.marker(ERROR_MARKER) if message is None else self.string(message),
            "stack": self.stack(exc),
        }
        # The exception's own attributes (``exc.status = ...``, ``__notes__``),
        # like the TS walker's own enumerable properties of an Error.
        own = getattr(exc, "__dict__", None) or {}
        for key in list(own)[: self.limits["max_object_keys"]]:
            if key not in out:
                out[key] = self.value(own[key], depth + 1)
        if exc.__cause__ is not None:
            out["cause"] = self.value(exc.__cause__, depth + 1)
        return out

    def value(self, value: Any, depth: int) -> Any:
        if isinstance(value, str):
            return self.string(value)
        if not isinstance(value, (BaseException, list, tuple, dict)):
            # Numbers, booleans, None, and other objects (sets, dataclasses,
            # datetimes, ...) are returned unchanged.
            return value

        if depth >= self.limits["max_depth"]:
            return self.marker(LIMIT_MARKER)
        if id(value) in self.seen:
            return self.marker(CYCLE_MARKER)
        self.seen.add(id(value))
        try:
            if isinstance(value, BaseException):
                return self.exception(value, depth)
            if isinstance(value, dict):
                # Keys beyond the limit are dropped, never passed through unmasked.
                keys = list(value.keys())[: self.limits["max_object_keys"]]
                return {key: self.value(value[key], depth + 1) for key in keys}
            # Elements beyond the limit are dropped, never passed through unmasked.
            masked = [self.value(item, depth + 1) for item in value[: self.limits["max_array_length"]]]
            return tuple(masked) if isinstance(value, tuple) else masked
        finally:
            self.seen.discard(id(value))


def walk(
    scan_and_redact: Callable[..., Any],
    data: Any,
    *,
    policy: Optional[Any],
    limits: Optional[dict[str, int]],
    counter: Optional[OutcomeCounter] = None,
) -> Any:
    return _Walk(scan_and_redact, policy, limits, counter).value(data, 0)


def mask_exception_text_with(
    scan_and_redact: Callable[..., Any],
    exc: BaseException,
    *,
    policy: Optional[Any] = None,
    limits: Optional[dict[str, int]] = None,
    counter: Optional[OutcomeCounter] = None,
) -> str:
    """The masked ``stack`` that walking ``exc`` would produce, without
    scanning the message or cause separately: the formatted traceback
    already contains both, and the logging filter keeps only this text."""
    state = _Walk(scan_and_redact, policy, limits, counter)
    if state.limits["max_depth"] <= 0:
        return state.marker(LIMIT_MARKER)
    return state.stack(exc)
