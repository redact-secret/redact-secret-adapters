"""The single primitive every adapter builds on: mask one leaf string with
an injected ``scan_and_redact``, and never let a core failure or a
``block`` finding put text on the wire.

Mirrors ``packages/adapter/src/mask-leaf.ts`` line for line so the two
languages make the same decision given the same finding.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Optional

from .outcome import OutcomeCounter

BLOCK_MARKER = "[REDACTED:BLOCKED]"
ERROR_MARKER = "[REDACTED:ERROR]"
LIMIT_MARKER = "[REDACTED:LIMIT_EXCEEDED]"
CYCLE_MARKER = "[REDACTED:CYCLE]"

# Bounds enforced by every walker, the logging filter, and the span
# processor. A field that exceeds max_string_length, or a value reached
# only after max_depth/max_array_length/max_object_keys/max_total_leaves is
# spent, never reaches the core: it becomes LIMIT_MARKER instead. Every log
# call pays the scan cost, so these bounds also cap per-call latency for a
# pathological extra mapping.
DEFAULT_LIMITS: dict[str, int] = {
    "max_depth": 8,
    "max_array_length": 1000,
    "max_object_keys": 200,
    "max_string_length": 200_000,
    "max_total_leaves": 5000,
}


def mask_leaf_with(
    scan_and_redact: Callable[..., Any],
    text: str,
    *,
    policy: Optional[Any] = None,
    max_string_length: Optional[int] = None,
) -> str:
    """Masks one leaf string.

    Any exception the core raises (``redact_secret.SecretScanError`` and
    its subclasses, or anything else a misbehaving ``policy`` raises)
    fails closed: the leaf becomes ``ERROR_MARKER``, never the original
    text and never the exception's own message. A ``block`` finding
    replaces the entire leaf with ``BLOCK_MARKER``: ``scan_and_redact``
    already substitutes ``block`` findings in place like ``redact`` ones,
    but an inline placeholder still leaves the rest of the string visible,
    which is not the documented host decision for a block-worthy secret.
    For a plain string log call the leaf *is* the message, and for a
    formatted field or an ``exc_text`` the leaf is that field's whole text.
    """
    return mask_leaf_outcome_with(scan_and_redact, text, policy=policy, max_string_length=max_string_length).text


@dataclass(frozen=True)
class MaskedLeaf:
    """One masked leaf, with the input-free record of what happened to it.

    ``outcome`` is one of ``unchanged``, ``redacted``, ``blocked``,
    ``limited``, ``failed``. ``findings`` is what the core reported for this
    one leaf -- zero when it was never scanned -- and is not a count of
    distinct credentials (see ``outcome.py``).
    """

    text: str
    outcome: str
    findings: int = 0


def mask_leaf_outcome_with(
    scan_and_redact: Callable[..., Any],
    text: str,
    *,
    policy: Optional[Any] = None,
    max_string_length: Optional[int] = None,
) -> MaskedLeaf:
    """:func:`mask_leaf_with`, plus what happened, for a host adapter that
    reports outcome counters. Nothing derived from the leaf's text is in the
    result besides the masked text itself.

    The masking decisions are the same, with one deliberate difference from
    ``0.1.0``: counting the findings needs ``len(result.findings)``, so a
    malformed core result whose ``findings`` has no length -- a generator --
    now fails closed to ``ERROR_MARKER`` where it used to return the masked
    text. That is the direction a malformed result should fail in.
    """
    if not isinstance(text, str):
        raise TypeError("mask_leaf_with: text must be a str")

    limit = max_string_length if max_string_length is not None else DEFAULT_LIMITS["max_string_length"]
    if len(text) > limit:
        return MaskedLeaf(LIMIT_MARKER, "limited")

    try:
        result = scan_and_redact(text, policy)
        # Reading the result is inside the guard too: a malformed result
        # must not raise into the host or pass the input through.
        findings = len(result.findings)
        if any(finding.action == "block" for finding in result.findings):
            return MaskedLeaf(BLOCK_MARKER, "blocked", findings)
        masked = result.text
    except Exception:
        return MaskedLeaf(ERROR_MARKER, "failed")
    if not isinstance(masked, str):
        return MaskedLeaf(ERROR_MARKER, "failed")
    # A ``warn`` finding leaves the text alone, so a scan can report findings
    # and still be ``unchanged``. That is why the two are counted apart.
    return MaskedLeaf(masked, "redacted" if masked != text else "unchanged", findings)


def count_leaf(counter: Optional[OutcomeCounter], leaf: MaskedLeaf) -> None:
    """Adds one leaf's outcome to ``counter``. A leaf the core never saw does
    not count as ``scanned``."""
    if counter is None:
        return
    if leaf.outcome != "limited":
        counter.scanned += 1
    counter.findings += leaf.findings
    if leaf.outcome == "redacted":
        counter.redacted += 1
    elif leaf.outcome == "blocked":
        counter.blocked += 1
    elif leaf.outcome == "limited":
        counter.limited += 1
    elif leaf.outcome == "failed":
        counter.failed += 1
