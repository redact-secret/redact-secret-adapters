"""``resolve_limit``, shared by ``mask_leaf`` and ``budget`` (which ``mask_leaf`` imports)."""

from __future__ import annotations

from typing import Any

__all__ = ["resolve_limit"]


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
