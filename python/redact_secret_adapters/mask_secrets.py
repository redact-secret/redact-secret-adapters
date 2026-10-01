"""``mask_secrets_with``: a generic masking callback, shaped exactly like
Langfuse Python's legacy ``mask`` hook signature
(``def masking_function(*, data: Any, **kwargs: Any) -> Any``), so
``mask_secrets`` (below) is a drop-in ``Langfuse(mask=mask_secrets)``.
``mask_secrets_with`` never touches ``redact_secret`` -- ``scan_and_redact``
is injected -- so it is testable without the built native extension,
mirroring ``packages/adapter/src/mask-secrets.ts``.
"""

from __future__ import annotations

from typing import Any, Callable, Optional

from ._walk import walk

__all__ = ["mask_secrets", "mask_secrets_with"]


def mask_secrets_with(
    scan_and_redact: Callable[..., Any],
    data: Any,
    *,
    policy: Optional[Any] = None,
    limits: Optional[dict[str, int]] = None,
    operation_limits: Optional[dict[str, int]] = None,
) -> Any:
    """Recursively masks every string inside a dict/list/tuple tree (the
    same walk as ``mask_log_value_with``, exceptions included; see
    ``_walk.py``).

    ``scan_and_redact`` is called once per leaf string, so a
    ``<SECRET_1>``-style placeholder index restarts at each leaf --
    identical to calling ``scan_and_redact`` directly on that one string.
    """
    if not callable(scan_and_redact):
        raise TypeError("mask_secrets_with: scan_and_redact must be callable")
    return walk(scan_and_redact, data, policy=policy, limits=limits, operation_limits=operation_limits)


def mask_secrets(*, data: Any, **_kwargs: Any) -> Any:
    """The live wrapper, matching Langfuse Python's legacy ``mask`` hook
    (https://langfuse.com/docs/observability/features/masking), which
    receives the actual attribute value and must return the masked value:

        from langfuse import Langfuse
        from redact_secret_adapters.mask_secrets import mask_secrets

        langfuse = Langfuse(mask=mask_secrets)

    ``redact_secret`` is imported here, on first use, and nowhere else in
    this module.

    **PII activation is a placement decision.** Credential detection needs
    no init step -- the native extension loads on ``import redact_secret``,
    unlike the JS package's mandatory ``await initialize()``. But PII
    detection is opt-in, process-wide and one-shot, and turning it on is an
    explicit call:

        import redact_secret

        redact_secret.initialize(pii=["pii:global"])  # before the first scan
        langfuse = Langfuse(mask=mask_secrets)

    Python's binding raises no conflict for a late call -- ``initialize``
    locks nothing that ``active_pii_selection()`` reads, so there is no
    error to catch. What there is instead is a **silent window**: every
    value masked before that call is scanned with PII off and reports
    nothing at all, with no warning. This wrapper cannot close the window,
    because it never sees when the process decided to enable PII; the
    application does. ``python/tests/test_pii_activation.py`` pins the
    window as a known limitation rather than hiding it.

    Activating PII is also not the same as masking every PII value: under
    the core's default policy ``High``-confidence PII redacts while
    ``Medium`` and ``Low`` resolve to ``warn``, and a ``warn`` finding
    leaves the text alone (see ``mask_leaf.py``). Pass your own ``policy``
    if you need those masked.
    """
    import redact_secret

    return mask_secrets_with(redact_secret.scan_and_redact, data)
