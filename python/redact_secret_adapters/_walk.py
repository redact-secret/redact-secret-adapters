"""The one value-tree walker (L2) behind ``mask_secrets_with`` and
``mask_log_value_with``, mirroring ``packages/adapter/src/walk.ts`` and the
walk in ``mask-log-value.ts``.

Walked: ``str`` leaves; ``dict`` and its subclasses (``OrderedDict``,
``defaultdict``, ...), returned as a plain ``dict``; ``list`` and its
subclasses, returned as a plain ``list``; tuples, returned as a plain
``tuple``; and exceptions, returned as a ``{"type", "message", "stack",
"cause"}`` mapping. Everything else is returned unchanged.
"""

from __future__ import annotations

import traceback
from typing import Any, Callable, Optional

from .mask_leaf import CYCLE_MARKER, DEFAULT_LIMITS, ERROR_MARKER, LIMIT_MARKER, mask_leaf_with


class _Walk:
    __slots__ = ("scan_and_redact", "policy", "limits", "leaves", "seen")

    def __init__(self, scan_and_redact: Callable[..., Any], policy: Any, limits: Optional[dict[str, int]]) -> None:
        self.scan_and_redact = scan_and_redact
        self.policy = policy
        self.limits = {**DEFAULT_LIMITS, **(limits or {})}
        self.leaves = self.limits["max_total_leaves"]
        self.seen: set[int] = set()

    def string(self, value: str) -> str:
        if self.leaves <= 0:
            return LIMIT_MARKER
        self.leaves -= 1
        return mask_leaf_with(
            self.scan_and_redact, value, policy=self.policy, max_string_length=self.limits["max_string_length"]
        )

    def stack(self, exc: BaseException) -> str:
        try:
            formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        except Exception:
            return ERROR_MARKER
        return self.string(formatted)

    def exception(self, exc: BaseException, depth: int) -> dict[str, Any]:
        try:
            message = str(exc)
        except Exception:
            # A raising __str__ must not escape into logger.exception().
            message = None
        out: dict[str, Any] = {
            "type": type(exc).__name__,
            "message": ERROR_MARKER if message is None else self.string(message),
            "stack": self.stack(exc),
        }
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
            return LIMIT_MARKER
        if id(value) in self.seen:
            return CYCLE_MARKER
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
    scan_and_redact: Callable[..., Any], data: Any, *, policy: Optional[Any], limits: Optional[dict[str, int]]
) -> Any:
    return _Walk(scan_and_redact, policy, limits).value(data, 0)


def mask_exception_text_with(
    scan_and_redact: Callable[..., Any],
    exc: BaseException,
    *,
    policy: Optional[Any] = None,
    limits: Optional[dict[str, int]] = None,
) -> str:
    """The masked ``stack`` that walking ``exc`` would produce, without
    scanning the message or cause separately: the formatted traceback
    already contains both, and the logging filter keeps only this text."""
    state = _Walk(scan_and_redact, policy, limits)
    if state.limits["max_depth"] <= 0:
        return LIMIT_MARKER
    return state.stack(exc)
