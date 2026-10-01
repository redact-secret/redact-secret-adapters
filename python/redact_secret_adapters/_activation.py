"""The one live-core step every Python live factory runs
(redact-secret/redact-secret-adapters#176), mirroring
``packages/adapter/src/activation.ts``.

PII detection in ``redact_secret`` is opt-in, **process-wide and one-shot**:
``initialize(pii=[...])`` records a selection, the first selection wins, and a
later *different* one raises ``PiiActivationConflictError``. An empty selection
(``selectors=off``) is a different selection, not a neutral one. Three rules
settle who calls it first, and nothing here decides policy:

1. **No ``pii`` given.** The core is imported and ``initialize`` is never
   called, exactly as before: the application owns activation, and an adapter
   must neither lock the process to "off" nor override the application's
   choice.
2. **``pii`` given.** It is passed to ``initialize(pii=...)``, so the
   adapter-first order works and the selection is explicit in the caller's
   code instead of implied by import order. A conflict is not yet a failure:
   an application that already activated an equivalent selection is a correct
   setup.
3. **``pii`` given.** ``pii_activation()`` is read afterwards and the factory
   refuses unless the active identity reflects what was asked for, so an
   adapter-first caller who lost the race is told instead of running silently
   with PII off.

Everything this module raises on its own carries a fixed message and a fixed
code. No selector, no input and no core exception text is read into an error.
Initialization failures that are not about the PII selection are not caught.

Activating PII turns *detection* on; it does not change the confidence-gated
policy (``High`` redacts, ``Medium``/``Low`` warn and leave the text alone).
"""

from __future__ import annotations

from typing import Any, Callable, Optional, Sequence

__all__ = ["CoreActivationError", "activation_reflects", "resolve_live_scan_and_redact"]

_MESSAGES = {
    "PII_ACTIVATION_UNSUPPORTED": (
        "redact_secret_adapters: the installed redact_secret does not report a PII activation, "
        "so the pii option cannot be honored; upgrade the core or omit pii"
    ),
    "PII_ACTIVATION_UNAVAILABLE": (
        "redact_secret_adapters: the requested PII selection is not available in the installed redact_secret"
    ),
    "PII_ACTIVATION_NOT_ACTIVE": (
        "redact_secret_adapters: the PII activation active in this process does not reflect the requested selection"
    ),
}

# Core error classes meaning "this selection cannot be honored", looked up by
# name on the core module so a core that lacks one is still supported.
_UNAVAILABLE_ERRORS = ("PiiSelectorInvalidError", "PiiSelectorUnavailableError", "PiiSelectorUnsupportedError")


class CoreActivationError(Exception):
    """A refusal to run with a PII selection that is not actually active.

    ``code`` is one of ``PII_ACTIVATION_UNSUPPORTED``,
    ``PII_ACTIVATION_UNAVAILABLE`` or ``PII_ACTIVATION_NOT_ACTIVE`` and the
    message is fixed per code; neither carries a selector, an input, or the
    core's own error text."""

    def __init__(self, code: str) -> None:
        super().__init__(_MESSAGES[code])
        self.code = code


def _active_selectors(identity: str) -> Optional[list[str]]:
    """The selectors named by an activation identity such as
    ``credentials=full;selectors=pii:global;families=...``, or ``None`` when
    the string is not one. Only compared, never logged or returned."""
    for part in identity.split(";"):
        key, sep, value = part.partition("=")
        if not sep or key.strip() != "selectors":
            continue
        value = value.strip()
        if value in ("", "off"):
            return []
        return [selector.strip() for selector in value.split(",") if selector.strip()]
    return None


def activation_reflects(identity: Any, pii: Sequence[str]) -> bool:
    """Whether ``identity`` reflects the requested selection: an empty request
    must find PII off, a non-empty one must find every requested selector
    active. An identity that cannot be parsed reflects nothing."""
    if not isinstance(identity, str):
        return False
    active = _active_selectors(identity)
    if active is None:
        return False
    if not pii:
        return not active
    return all(selector in active for selector in pii)


def _validated(pii: Any) -> list[str]:
    # A bare string would silently become a list of characters.
    if not isinstance(pii, (list, tuple, set, frozenset)) or not all(isinstance(selector, str) for selector in pii):
        raise TypeError("redact_secret_adapters: pii must be a sequence of selector strings")
    # The core treats a repeated selector as a different selection.
    return list(dict.fromkeys(pii))


def _read_identity(core: Any) -> Any:
    try:
        return core.pii_activation()
    except Exception:
        return None


def activate_core(core: Any, pii: Sequence[str]) -> None:
    """Initializes ``core`` with ``pii`` and verifies it took; see the module
    docstring."""
    selection = _validated(pii)
    if not callable(getattr(core, "initialize", None)) or not callable(getattr(core, "pii_activation", None)):
        raise CoreActivationError("PII_ACTIVATION_UNSUPPORTED")
    conflict = getattr(core, "PiiActivationConflictError", None)
    unavailable = tuple(
        cls for cls in (getattr(core, name, None) for name in _UNAVAILABLE_ERRORS) if isinstance(cls, type)
    )
    rejected = False
    try:
        core.initialize(pii=selection)
    except Exception as error:
        if isinstance(conflict, type) and isinstance(error, conflict):
            pass  # decided by the verification below
        elif unavailable and isinstance(error, unavailable):
            rejected = True
        else:
            raise
    # Raised outside the handler, so no core exception is chained to it.
    if rejected:
        raise CoreActivationError("PII_ACTIVATION_UNAVAILABLE")
    if not activation_reflects(_read_identity(core), selection):
        raise CoreActivationError("PII_ACTIVATION_NOT_ACTIVE")


def resolve_live_scan_and_redact(pii: Optional[Sequence[str]]) -> Callable[..., Any]:
    """``redact_secret.scan_and_redact``, with ``pii`` activated and verified
    first when given. The only place the adapters import the real core; the
    selection is validated before the import so a bad argument never loads it."""
    selection = None if pii is None else _validated(pii)
    import redact_secret

    if selection is not None:
        activate_core(redact_secret, selection)
    return redact_secret.scan_and_redact
