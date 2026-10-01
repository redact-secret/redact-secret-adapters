"""The one value-tree walker (L2) behind ``mask_secrets_with`` and
``mask_log_value_with``, mirroring ``packages/adapter/src/walk.ts`` and the
walk in ``mask-log-value.ts``.

Walked: ``str`` leaves; ``dict`` and its subclasses (``OrderedDict``,
``defaultdict``, ...), returned as a plain ``dict``; ``list`` and its
subclasses, returned as a plain ``list``; tuples, returned as a plain
``tuple``; and exceptions, returned as a ``{"type", "message", "stack",
"cause"}`` mapping plus one key per attribute in the exception's
``__dict__``. ``int``, ``float``, ``bool`` and ``None`` are returned
unchanged until ``max_nodes`` is spent; past it, every value is
``LIMIT_MARKER``.

Anything else -- a ``set``, ``bytes``, a dataclass, a ``datetime``, any
other instance -- fails closed to ``ERROR_MARKER``: the walker cannot know
what a host serializer would print for it (``%(ctx)s``, a JSON formatter's
``default=str``), so it never passes one through unscanned. This is where
the Python walker differs from the TS one, which serializes an instance the
way ``JSON.stringify`` would; Python has no single serialization to mirror.

Never raises for any input value: a container whose read raises (a
``__getitem__``, ``keys()`` or slice that raises) becomes ``ERROR_MARKER``,
for that key or element alone when only reading it raised.
"""

from __future__ import annotations

import math
import traceback
from typing import Any, Callable, Optional

from .budget import OperationBudget
from .mask_leaf import (
    CYCLE_MARKER,
    ERROR_MARKER,
    LIMIT_MARKER,
    count_leaf,
    mask_leaf_outcome_with,
    resolve_limits,
)
from .outcome import OutcomeCounter
from .scan_options import ScanConfig, resolve_scan_config

# Passed through unchanged, like numbers, booleans and null in the TS walker.
# ``bool`` is a subclass of ``int``.
_PRIMITIVES = (int, float, type(None))


def _slice_bound(limit: Any) -> Optional[int]:
    """A resolved limit as a slice bound: ``inf`` is no bound, and a
    fraction truncates, like ``Array.prototype.slice`` in the TS walker."""
    return None if math.isinf(limit) else int(limit)


class _Walk:
    __slots__ = ("scan_and_redact", "config", "limits", "leaves", "nodes", "seen", "counter", "budget")

    def __init__(
        self,
        scan_and_redact: Callable[..., Any],
        policy: Any,
        limits: Optional[dict[str, int]],
        counter: Optional[OutcomeCounter] = None,
        budget: Optional[OperationBudget] = None,
        operation_limits: Optional[dict[str, int]] = None,
        scan_config: Optional[ScanConfig] = None,
    ) -> None:
        self.scan_and_redact = scan_and_redact
        # The validated, snapshotted scan options every leaf is scanned with.
        self.config = scan_config if scan_config is not None else resolve_scan_config(policy)
        self.limits = resolve_limits(limits)
        self.leaves = self.limits["max_total_leaves"]
        self.nodes = self.limits["max_nodes"]
        self.seen: set[int] = set()
        # Caller-owned; see ``outcome.py``. ``None`` means nothing is counted.
        self.counter = counter
        # The operation's aggregate budget (see ``budget.py``), shared by every
        # walk and mask of one host operation when the caller passes one in; a
        # walk of its own gets a fresh one.
        self.budget = budget if budget is not None else OperationBudget(operation_limits)

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

    def string(self, value: str, key: Any = None) -> str:
        if self.leaves <= 0 or not self.budget.charge_leaf():
            if self.counter is not None:
                self.counter.limited += 1
            return LIMIT_MARKER
        self.leaves -= 1
        leaf = mask_leaf_outcome_with(
            self.scan_and_redact,
            value,
            max_string_length=self.limits["max_string_length"],
            key=key if isinstance(key, str) else None,
            budget=self.budget,
            scan_config=self.config,
        )
        count_leaf(self.counter, leaf)
        return leaf.text

    def stack(self, exc: BaseException) -> str:
        try:
            formatted = "".join(traceback.format_exception(type(exc), exc, exc.__traceback__))
        except Exception:
            return self.marker(ERROR_MARKER)
        return self.string(formatted)

    def entry(self, container: Any, key: Any, depth: int) -> Any:
        """One key's or element's masked value. A read that raises becomes
        ``ERROR_MARKER`` for that entry alone, like the per-key guard in
        ``walk.ts``."""
        try:
            item = container[key]
        except Exception:
            return self.marker(ERROR_MARKER)
        return self.value(item, depth + 1, key)

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
        for key in list(own)[: _slice_bound(self.limits["max_object_keys"])]:
            if key not in out:
                if not self.budget.charge_key():
                    self.marker(LIMIT_MARKER)
                    break
                out[key] = self.entry(own, key, depth)
        if exc.__cause__ is not None:
            out["cause"] = self.value(exc.__cause__, depth + 1)
        return out

    def value(self, value: Any, depth: int, key: Any = None) -> Any:
        # Every visit counts, once per path: ``seen`` holds only the current
        # path, so a shared reference is walked again from each parent.
        if self.nodes <= 0 or not self.budget.charge_node():
            return self.marker(LIMIT_MARKER)
        self.nodes -= 1
        if isinstance(value, str):
            return self.string(value, key)
        if isinstance(value, _PRIMITIVES):
            return value
        if not isinstance(value, (BaseException, list, tuple, dict)):
            # Fail closed: an object the walker cannot see into (a set,
            # bytes, a dataclass, any other instance) is never passed
            # through to a serializer that would print it.
            return self.marker(ERROR_MARKER)

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
                keys = list(value.keys())[: _slice_bound(self.limits["max_object_keys"])]
                out: dict[Any, Any] = {}
                for key in keys:
                    # Past the operation's key budget the remaining keys are
                    # dropped, never passed through, as past ``max_object_keys``.
                    if not self.budget.charge_key():
                        self.marker(LIMIT_MARKER)
                        break
                    out[key] = self.entry(value, key, depth)
                return out
            # Elements beyond the limit are dropped, never passed through unmasked.
            items = value[: _slice_bound(self.limits["max_array_length"])]
            masked = [self.value(item, depth + 1) for item in items]
            return tuple(masked) if isinstance(value, tuple) else masked
        except Exception:
            # A container whose keys(), slice, or iteration raises cannot be
            # read, so it cannot be scanned.
            return self.marker(ERROR_MARKER)
        finally:
            self.seen.discard(id(value))


def walk(
    scan_and_redact: Callable[..., Any],
    data: Any,
    *,
    policy: Optional[Any],
    limits: Optional[dict[str, int]],
    counter: Optional[OutcomeCounter] = None,
    key: Optional[str] = None,
    budget: Optional[OperationBudget] = None,
    operation_limits: Optional[dict[str, int]] = None,
    scan_config: Optional[ScanConfig] = None,
) -> Any:
    """Masks every string reachable in ``data``. Never raises for any
    input value; see the module docstring for what each kind becomes.

    ``key`` is the name ``data`` sits directly under, when it is a plain
    string and the host knows one (a log record's ``extra`` field name):
    context for detection only (see ``key_context.py``)."""
    return _Walk(scan_and_redact, policy, limits, counter, budget, operation_limits, scan_config).value(data, 0, key)


def mask_exception_text_with(
    scan_and_redact: Callable[..., Any],
    exc: BaseException,
    *,
    policy: Optional[Any] = None,
    limits: Optional[dict[str, int]] = None,
    counter: Optional[OutcomeCounter] = None,
    budget: Optional[OperationBudget] = None,
    operation_limits: Optional[dict[str, int]] = None,
    scan_config: Optional[ScanConfig] = None,
) -> str:
    """The masked ``stack`` that walking ``exc`` would produce, without
    scanning the message or cause separately: the formatted traceback
    already contains both, and the logging filter keeps only this text."""
    state = _Walk(scan_and_redact, policy, limits, counter, budget, operation_limits, scan_config)
    if state.limits["max_depth"] <= 0:
        return state.marker(LIMIT_MARKER)
    return state.stack(exc)
