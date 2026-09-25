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
    return walk(scan_and_redact, data, policy=policy, limits=limits)


def mask_secrets(*, data: Any, **_kwargs: Any) -> Any:
    """The live wrapper, matching Langfuse Python's legacy ``mask`` hook
    (https://langfuse.com/docs/observability/features/masking), which
    receives the actual attribute value and must return the masked value:

        from langfuse import Langfuse
        from redact_secret_adapters.mask_secrets import mask_secrets

        langfuse = Langfuse(mask=mask_secrets)

    ``redact_secret`` is imported here, on first use, and nowhere else in
    this module. There is no init step for the Python bindings, unlike the
    JS package's ``await initialize()``.
    """
    import redact_secret

    return mask_secrets_with(redact_secret.scan_and_redact, data)
