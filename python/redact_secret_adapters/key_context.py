"""The shared key-context scan primitive (redact-secret-adapters#172), the
Python twin of ``packages/adapter/src/key-context.ts``.

Some credentials are only recognisable by the field name they sit under
(``{"api_key": "..."}``). The core owns that decision: this module detects
nothing, holds no key pattern or name list, and decides no policy. It builds
the leaf's *key-context view* ``{"<key>":"<leaf>"}`` (key and leaf verbatim,
never escaped, so every offset the core reports is an exact offset into the
view), asks the injected scan for a second opinion, and maps what comes back
onto the leaf.
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Sequence

__all__ = ["KeyContextFailure", "key_context_prefix", "key_context_view", "scan_leaf_in_key_context"]

_PREFIX_OPEN = '{"'
_PREFIX_CLOSE = '":"'
SUFFIX = '"}'


class KeyContextFailure(Exception):
    """Raised by a ``scan`` callable, or by :func:`scan_leaf_in_key_context`
    itself, to end a leaf's scan. ``kind`` is ``"policy"`` when the view
    reported a redacting or blocking finding outside the leaf (the key cannot
    be rewritten), ``"core_error"`` when the core's view answer broke its own
    contract, or whatever string a caller's ``scan`` raised it with
    (``"limit"``, ``"error"``). It carries no input and no message."""

    def __init__(self, kind: str) -> None:
        super().__init__(kind)
        self.kind = kind


def key_context_prefix(key: str) -> str:
    """``{"<key>":"``"""
    return f"{_PREFIX_OPEN}{key}{_PREFIX_CLOSE}"


def key_context_view(key: str, text: str) -> str:
    """``{"<key>":"<leaf>"}``, with the key and the leaf verbatim."""
    return key_context_prefix(key) + text + SUFFIX


def _redacts_or_blocks(finding: Any) -> bool:
    return getattr(finding, "action", None) in ("redact", "block")


def scan_leaf_in_key_context(
    scan: Callable[[str], tuple[str, Sequence[Any]]],
    text: str,
    key: Optional[str],
) -> tuple[str, Sequence[Any]]:
    """Scans one string leaf, key-aware. ``scan(text)`` is the caller's
    whole-input scan of one string, returning ``(text, findings)`` and raising
    :class:`KeyContextFailure` for a failure it wants reported as it is.

    The leaf is scanned alone. When that redacts or blocks nothing and the
    leaf sits directly under a string key, it is scanned again in its view.
    A view finding inside the leaf's span is kept; a redacting or blocking one
    outside it raises ``KeyContextFailure("policy")``, since the key cannot be
    rewritten. The view's result replaces the leaf-alone one, whole, when it
    redacts or blocks, or when the leaf alone reported nothing. Two results
    are never merged. A finding outside the leaf that is neither redact nor
    block is dropped: it describes text that is not the leaf.
    """
    alone_text, alone_findings = scan(text)
    if key is None or any(_redacts_or_blocks(f) for f in alone_findings):
        return alone_text, alone_findings
    prefix = key_context_prefix(key)
    view_text, view_findings = scan(prefix + text + SUFFIX)
    leaf_end = len(prefix) + len(text)
    inside = []
    for finding in view_findings:
        start, end = finding.start, finding.end
        if start >= len(prefix) and end <= leaf_end:
            inside.append(finding)
        elif _redacts_or_blocks(finding):
            raise KeyContextFailure("policy")
    if not any(_redacts_or_blocks(f) for f in inside) and len(alone_findings) > 0:
        return alone_text, alone_findings
    # Nothing outside the leaf was rewritten, so the view's text is the
    # prefix, the sanitized leaf, and the suffix; anything else is a core
    # that broke its own contract.
    if not view_text.startswith(prefix) or not view_text.endswith(SUFFIX) or len(view_text) < len(prefix) + len(SUFFIX):
        raise KeyContextFailure("core_error")
    return view_text[len(prefix) : len(view_text) - len(SUFFIX)], inside
