"""The single primitive every adapter builds on: mask one leaf string with
an injected ``scan_and_redact``, and never let a core failure or a
``block`` finding put text on the wire.

Mirrors ``packages/adapter/src/mask-leaf.ts`` line for line so the two
languages make the same decision given the same finding.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Any, Callable, Optional

from .key_context import KeyContextFailure, scan_leaf_in_key_context
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
#
# max_nodes caps every visit, containers included, so a shared-reference
# graph (walked once per path) cannot multiply the work past it. It is four
# times max_total_leaves, so a string-heavy value still meets the leaf budget
# first. Same default as ``maxNodes`` in ``mask-leaf.ts``.
DEFAULT_LIMITS: dict[str, int] = {
    "max_depth": 8,
    "max_array_length": 1000,
    "max_object_keys": 200,
    "max_string_length": 200_000,
    "max_total_leaves": 5000,
    "max_nodes": 20_000,
}


def resolve_limit(value: Any, fallback: int) -> Any:
    """``value`` if it is a usable bound, else ``fallback``, like
    ``resolveLimit`` in ``mask-leaf.ts``. ``None``, ``NaN``, a negative
    number, a ``bool``, or a non-number would otherwise raise out of a
    walk, disable a bound (``len(text) > nan`` is never true), or turn a
    slice bound negative (``[:-1]`` keeps almost everything)."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return fallback
    if value != value or value < 0:  # NaN is the one value unequal to itself
        return fallback
    return value


def resolve_limits(overrides: Optional[Any]) -> dict[str, Any]:
    """Per-key :func:`resolve_limit` over ``DEFAULT_LIMITS``; like
    ``resolveLimits`` in ``walk.ts``, anything that is not a mapping is no
    overrides at all, and unknown keys are ignored."""
    source = overrides if isinstance(overrides, Mapping) else {}
    return {key: resolve_limit(source.get(key), default) for key, default in DEFAULT_LIMITS.items()}


def mask_leaf_with(
    scan_and_redact: Callable[..., Any],
    text: str,
    *,
    policy: Optional[Any] = None,
    max_string_length: Optional[int] = None,
    key: Optional[str] = None,
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
    return mask_leaf_outcome_with(
        scan_and_redact, text, policy=policy, max_string_length=max_string_length, key=key
    ).text


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
    key: Optional[str] = None,
) -> MaskedLeaf:
    """:func:`mask_leaf_with`, plus what happened, for a host adapter that
    reports outcome counters. Nothing derived from the leaf's text is in the
    result besides the masked text itself.

    ``key`` is the mapping key (or attribute name) the leaf sits directly
    under, when the host supplies one: context for detection only (see
    ``key_context.py``), never rewritten, scanned on its own, or returned.

    The masking decisions are the same, with one deliberate difference from
    ``0.1.0``: counting the findings needs ``len(result.findings)``, so a
    malformed core result whose ``findings`` has no length -- a generator --
    now fails closed to ``ERROR_MARKER`` where it used to return the masked
    text. That is the direction a malformed result should fail in.
    """
    if not isinstance(text, str):
        raise TypeError("mask_leaf_with: text must be a str")

    limit = resolve_limit(max_string_length, DEFAULT_LIMITS["max_string_length"])
    if len(text) > limit:
        return MaskedLeaf(LIMIT_MARKER, "limited")
    keyed = key if isinstance(key, str) else None
    if keyed is not None and len(keyed) > limit:
        return MaskedLeaf(LIMIT_MARKER, "limited")

    def scan(candidate: str) -> tuple[str, Any]:
        try:
            result = scan_and_redact(candidate, policy)
            # Reading the result is inside the guard too: a malformed result
            # must not raise into the host or pass the input through.
            len(result.findings)  # no length (a generator) is a malformed result
            findings = list(result.findings)
            masked = result.text
        except Exception:
            raise KeyContextFailure("error") from None
        if not isinstance(masked, str):
            raise KeyContextFailure("error")
        return masked, findings

    try:
        masked, findings = scan_leaf_in_key_context(scan, text, keyed)
    except KeyContextFailure as failure:
        if failure.kind == "policy":
            return MaskedLeaf(BLOCK_MARKER, "blocked")
        return MaskedLeaf(ERROR_MARKER, "failed")
    count = len(findings)
    if any(getattr(finding, "action", None) == "block" for finding in findings):
        return MaskedLeaf(BLOCK_MARKER, "blocked", count)
    # A ``warn`` finding leaves the text alone, so a scan can report findings
    # and still be ``unchanged``. That is why the two are counted apart.
    return MaskedLeaf(masked, "redacted" if masked != text else "unchanged", count)


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
