"""The one outcome contract every host adapter reports through
(redact-secret/redact-secret-adapters#45), mirroring
``packages/adapter/src/outcome.ts`` so the same numbers mean the same thing in
both languages.

It is input-free **by construction**: a counter holds six non-negative
integers and nothing else. There is no field for a value, a masked value, a
record attribute, a key, an offset, a detector id, or an exception message, so
there is nothing to accidentally forward. A host increments its own metrics
from these numbers; nothing here creates a logger, an exporter, or a network
client.

The six numbers count **values** (string leaves), not credentials and not host
events:

``scanned``
    Leaves handed to the core. A leaf refused by a bound before the core saw
    it is not one of these.
``findings``
    Findings the core reported, summed over those leaves. **Not** a count of
    distinct credentials: one credential repeated in five leaves is five
    findings, and one leaf may carry several.
``redacted``
    Leaves whose text the core changed. Lower than ``findings`` whenever a
    finding's action leaves text alone (a ``warn``).
``blocked``
    Leaves replaced whole by ``BLOCK_MARKER``.
``limited``
    Values replaced by ``LIMIT_MARKER``: past a walk budget or longer than
    ``max_string_length``. Never scanned, never passed through.
``failed``
    Values the adapter could not scan or represent and replaced with
    ``ERROR_MARKER``, plus the ``CYCLE_MARKER`` case.

A host's own delivery outcome is a separate, named field on that host's
outcome type, because only that adapter knows it. None of them means
"delivered": no adapter here learns whether a handler or an exporter
succeeded, and none of them claims to.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

__all__ = [
    "LogRecordOutcome",
    "OutcomeCounter",
    "SpanOutcome",
    "ValueCounts",
    "notify",
]


@dataclass
class OutcomeCounter:
    """A mutable accumulator. Create one per logical host unit (one log
    record, one span)."""

    scanned: int = 0
    findings: int = 0
    redacted: int = 0
    blocked: int = 0
    limited: int = 0
    failed: int = 0

    def add(self, other: "OutcomeCounter") -> None:
        """Adds ``other`` in, for a unit masked in more than one pass."""
        self.scanned += other.scanned
        self.findings += other.findings
        self.redacted += other.redacted
        self.blocked += other.blocked
        self.limited += other.limited
        self.failed += other.failed

    def snapshot(self) -> "ValueCounts":
        """An immutable copy, safe to hand to an observer that may keep it."""
        return ValueCounts(
            scanned=self.scanned,
            findings=self.findings,
            redacted=self.redacted,
            blocked=self.blocked,
            limited=self.limited,
            failed=self.failed,
        )


@dataclass(frozen=True)
class ValueCounts:
    """A frozen snapshot of an :class:`OutcomeCounter`."""

    scanned: int = 0
    findings: int = 0
    redacted: int = 0
    blocked: int = 0
    limited: int = 0
    failed: int = 0


@dataclass(frozen=True)
class LogRecordOutcome:
    """One summary per ``logging`` record, the unit a host counts in.

    ``level`` is the record's numeric level -- bounded and enumerated, not
    input. ``logger`` is deliberately absent: a logger name is
    application-defined and can be unbounded in cardinality.
    """

    level: int
    values: ValueCounts
    host: str = "logging"
    unit: str = "log-record"


@dataclass(frozen=True)
class SpanOutcome:
    """One summary per OpenTelemetry span.

    ``dropped`` is ``True`` when **this processor** did not hand the span to
    the next one, because a masked value would not write back. It does not
    mean the span was sampled out, and ``False`` does not mean the span was
    exported: whether the next processor kept it and whether an exporter
    succeeded are things this adapter never learns and does not report.
    """

    values: ValueCounts
    dropped: bool = False
    host: str = "otel"
    unit: str = "span"


def notify(observer: Optional[Callable[[Any], None]], outcome: Any) -> None:
    """Calls ``observer`` with ``outcome``, swallowing anything it raises.

    Observation must never turn a protected result into an unprotected one, so
    the caller has already finished masking before this runs, and an exception
    here is neither read nor re-raised. Re-entrancy is guarded by the caller:
    an observer that logs through the logger it is observing would otherwise
    recurse.
    """
    if observer is None:
        return
    try:
        observer(outcome)
    except Exception:
        # Observational only. Never read, never re-raised.
        pass
