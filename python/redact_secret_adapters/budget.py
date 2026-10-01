"""The operation-owned aggregate budget (redact-secret-adapters#173), the
Python twin of ``packages/adapter/src/budget.ts``.

Per-string and per-walk bounds do not bound a whole host operation: a log
record is masked as a message, an exception text, a stack and several extra
fields, each its own walk, and a span has many attributes, events and links.
An *operation* is the unit a host counts in (one ``filter()`` call, one span
ending, one ``mask_secrets_with`` call); one :class:`OperationBudget` is
created for it and shared by every pass and field of it, so many individually
valid fields cannot multiply the total work.

What each counter counts. **Occurrences** are counted where a value is
*visited* (a shared reference reached by two paths counts twice, a memoized or
repeated scan counts again); **actual calls** are counted where work is *done*.

====================  ===================================================  ===========
Counter               Counts                                               Unit
====================  ===================================================  ===========
``max_nodes``         every value visited, containers and leaves alike     occurrences
``max_keys``          every mapping key or attribute name visited          occurrences
``max_leaves``        every string leaf handed to a scan                   occurrences
``max_scans``         every ``scan_and_redact`` call, key-context views    actual calls
                      included
``max_bytes``         the UTF-8 bytes of every text handed to              actual calls
                      ``scan_and_redact``, views included
``max_findings``      every finding the core reported, summed              occurrences
====================  ===================================================  ===========

Exhaustion is **sticky**: the first charge that does not fit marks the budget
exhausted, every later charge fails too, and a failed charge consumes nothing.
The marker-based adapters replace what could not be inspected with
``[REDACTED:LIMIT_EXCEEDED]``; nothing after the overrun is scanned or passed on.

It is a work counter, not a wall-clock interrupt. It is checked *between*
scans, synchronously: a ``scan_and_redact`` call, once started, runs to its own
completion under the core's whole-input limits, and a host callback (a policy,
a ``__getitem__``, a property) that never returns is not interrupted. A budget
is owned by one operation on one thread; two threads masking two operations
never share one.
"""

from __future__ import annotations

from typing import Any, Optional

from ._limit import resolve_limit

__all__ = ["DEFAULT_OPERATION_LIMITS", "OperationBudget", "resolve_operation_limits", "utf8_byte_length"]

# They sit far above any per-walk default so that an ordinary record or span is
# unaffected, and bound what an adversarial one can cost: at most 16 MiB of
# UTF-8 text in at most 50,000 scans. Same defaults as ``DEFAULT_OPERATION_LIMITS``
# in ``budget.ts``.
DEFAULT_OPERATION_LIMITS: dict[str, int] = {
    "max_bytes": 16 * 1024 * 1024,
    "max_nodes": 100_000,
    "max_keys": 100_000,
    "max_leaves": 25_000,
    "max_scans": 50_000,
    "max_findings": 100_000,
}


def resolve_operation_limits(overrides: Optional[Any]) -> dict[str, Any]:
    """Per-key :func:`~redact_secret_adapters.mask_leaf.resolve_limit` over
    ``DEFAULT_OPERATION_LIMITS``: ``None``, ``NaN``, a negative number, a
    ``bool`` or a non-number never disables a bound. Anything that is not a
    mapping is no overrides at all."""
    source = overrides if hasattr(overrides, "get") else {}
    return {key: resolve_limit(source.get(key), default) for key, default in DEFAULT_OPERATION_LIMITS.items()}


def utf8_byte_length(text: str) -> int:
    """The number of bytes ``text`` takes in UTF-8, counting a lone surrogate
    as the 3 bytes ``surrogatepass`` gives it."""
    if text.isascii():
        return len(text)
    return len(text.encode("utf-8", "surrogatepass"))


class OperationBudget:
    """What one host operation may spend. Create one per operation and share it
    across every pass of it. ``usage()`` is six non-negative integers and
    nothing derived from the input."""

    __slots__ = ("limits", "exhausted", "_bytes", "_nodes", "_keys", "_leaves", "_scans", "_findings")

    def __init__(self, overrides: Optional[Any] = None) -> None:
        self.limits = resolve_operation_limits(overrides)
        self.exhausted = False
        self._bytes = 0
        self._nodes = 0
        self._keys = 0
        self._leaves = 0
        self._scans = 0
        self._findings = 0

    def usage(self) -> dict[str, int]:
        return {
            "bytes": self._bytes,
            "nodes": self._nodes,
            "keys": self._keys,
            "leaves": self._leaves,
            "scans": self._scans,
            "findings": self._findings,
        }

    def _refuse(self) -> bool:
        self.exhausted = True
        return False

    def charge_node(self) -> bool:
        if self.exhausted or self._nodes + 1 > self.limits["max_nodes"]:
            return self._refuse()
        self._nodes += 1
        return True

    def charge_key(self) -> bool:
        if self.exhausted or self._keys + 1 > self.limits["max_keys"]:
            return self._refuse()
        self._keys += 1
        return True

    def charge_leaf(self) -> bool:
        if self.exhausted or self._leaves + 1 > self.limits["max_leaves"]:
            return self._refuse()
        self._leaves += 1
        return True

    def charge_scan(self, scan_bytes: int) -> bool:
        """One ``scan_and_redact`` call over ``scan_bytes`` UTF-8 bytes."""
        if (
            self.exhausted
            or self._scans + 1 > self.limits["max_scans"]
            or self._bytes + scan_bytes > self.limits["max_bytes"]
        ):
            return self._refuse()
        self._scans += 1
        self._bytes += scan_bytes
        return True

    def charge_findings(self, count: int) -> bool:
        if self.exhausted or self._findings + count > self.limits["max_findings"]:
            return self._refuse()
        self._findings += count
        return True
