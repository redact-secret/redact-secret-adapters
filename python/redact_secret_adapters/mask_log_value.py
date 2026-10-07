"""Recursively masks every string inside a value tree, including a
``BaseException``'s message and formatted traceback. The walk is shared
with ``mask_secrets_with``; see ``_walk.py`` for exactly which containers
are walked and what they come back as.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from ._walk import walk
from .scan_options import resolve_scan_config

__all__ = ["mask_log_value_with"]


def mask_log_value_with(
    scan_and_redact: Callable[..., Any],
    data: Any,
    *,
    policy: Optional[Any] = None,
    limits: Optional[dict[str, int]] = None,
    operation_limits: Optional[dict[str, int]] = None,
    scan_limits: Optional[Any] = None,
    ruleset: Optional[Any] = None,
    placeholder_formatter: Optional[Callable[..., Any]] = None,
    action_policy: Optional[Any] = None,
) -> Any:
    """Recursively masks every string (and every exception's message/stack)
    inside a dict/list/tuple/exception tree. ``scan_and_redact`` is called
    once per leaf string, so a ``<SECRET_1>``-style placeholder index
    restarts at each leaf.
    """
    if not callable(scan_and_redact):
        raise TypeError("mask_log_value_with: scan_and_redact must be callable")
    return walk(
        scan_and_redact,
        data,
        policy=policy,
        limits=limits,
        operation_limits=operation_limits,
        scan_config=resolve_scan_config(policy, scan_limits, ruleset, placeholder_formatter, action_policy),
    )
