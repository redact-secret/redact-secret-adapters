"""A SpanProcessor (OpenTelemetry Python,
https://github.com/open-telemetry/opentelemetry-python/blob/main/opentelemetry-sdk/src/opentelemetry/sdk/trace/__init__.py)
that redacts every string and string-sequence attribute -- including
OpenInference and GenAI semantic-convention attributes -- on a span and
its events before handing the span to the next processor. It does not
allowlist those attribute names: every string-shaped attribute value is
scanned, which covers any semantic convention without hardcoding it and
without a dependency on either convention's attribute list.

``ReadableSpan.attributes`` returns a read-only ``MappingProxyType`` in
every declared SDK version -- there is no public mutation API before
export. This reaches into the private ``_attributes`` field instead (and
each event's ``_attributes``), which is the accepted workaround for OTel
Python redaction processors absent a public API. If a future SDK version
removes or renames that field, ``tests/test_otel_host.py``'s exporter
assertion fails loudly instead of silently letting plaintext through --
it does not assume the field is `None`-safe by construction.

The ``_attributes`` field is a ``BoundedAttributes`` -- a ``MutableMapping``
that raises ``TypeError`` from ``__setitem__`` once its own ``_immutable``
flag is set. Every SDK version in the declared range sets that flag
unconditionally for event attributes (an event, once recorded, is meant to
be immutable) and, from opentelemetry-sdk 1.43 onward, for span attributes
too as of ``Span.end()`` -- in both cases *before* any processor hook runs,
so there is no callback timing that reaches attributes while they are still
mutable through ``__setitem__``. This writes through the backing
``_dict`` instead, which ``BoundedAttributes.__deepcopy__`` itself uses for
the same reason ("bypass the immutability guard in __setitem__"): it is the
SDK's own accepted way to mutate a frozen bag, not a version-specific
workaround, so it doesn't need gating by which SDK version is installed.

This module does not import ``opentelemetry`` at all: ``SpanProcessor``'s
``on_start``/``on_end``/``shutdown``/``force_flush`` are plain (non-
abstract) methods, so Python's duck typing means a class implementing the
same four methods -- plus the private ``_on_ending`` hook the SDK calls on
every processor -- needs no base class, no import, and no dependency --
matching ``packages/adapter-otel/src/span-processor.ts``. Install the
``otel`` extra to get the SDK this module is meant to be used with:

    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from redact_secret_adapters.otel import create_redacting_span_processor

    provider = TracerProvider()
    provider.add_span_processor(create_redacting_span_processor(BatchSpanProcessor(otlp_exporter)))
"""

from __future__ import annotations

from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover - type checking only, no runtime dependency
    from opentelemetry.context import Context
    from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor

from .mask_leaf import ERROR_MARKER, mask_leaf_with

__all__ = ["RedactingSpanProcessorWith", "create_redacting_span_processor", "redact_attributes_with"]


def _mask_attribute_value(scan_and_redact, value, *, policy, max_string_length):
    try:
        if isinstance(value, str):
            return mask_leaf_with(scan_and_redact, value, policy=policy, max_string_length=max_string_length)
        if isinstance(value, (list, tuple)) and any(isinstance(item, str) for item in value):
            # The SDK accepts None inside a sequence, so mask each str
            # element and keep everything else in place.
            masked = [
                mask_leaf_with(scan_and_redact, item, policy=policy, max_string_length=max_string_length)
                if isinstance(item, str)
                else item
                for item in value
            ]
            return tuple(masked) if isinstance(value, tuple) else masked
    except Exception:
        return ERROR_MARKER
    # Numbers, booleans, and homogeneous number/boolean sequences are the
    # only other attribute value shapes OpenTelemetry allows; none of them
    # can carry a secret as free text, so they pass through unchanged.
    return value


def redact_attributes_with(
    scan_and_redact: Callable[..., Any],
    attributes: Optional[dict],
    *,
    policy: Optional[Any] = None,
    limits: Optional[dict] = None,
) -> None:
    """Mutates `attributes` in place. A no-op for `None`.

    `attributes` is a plain dict in the duck-typed tests and a real SDK
    `BoundedAttributes` against a live SpanProcessor; the latter is a
    `MutableMapping` whose `__setitem__` raises once it's marked immutable
    (every event's attributes, and every span's once `Span.end()` has run).
    Writing through its backing `_dict` -- present only on that real type --
    bypasses that guard instead of tripping it."""
    if attributes is None:
        return
    max_string_length = (limits or {}).get("max_string_length")
    target = getattr(attributes, "_dict", attributes)
    for key in list(target.keys()):
        target[key] = _mask_attribute_value(
            scan_and_redact, target[key], policy=policy, max_string_length=max_string_length
        )


class RedactingSpanProcessorWith:
    """Wraps `next_processor` (any object shaped like a `SpanProcessor`)
    and redacts every span's and event's string attributes before
    delegating to it. `scan_and_redact` is injected so this class is
    testable without the built native extension or a real OpenTelemetry
    dependency."""

    def __init__(
        self,
        next_processor: "SpanProcessor",
        scan_and_redact: Callable[..., Any],
        *,
        policy: Optional[Any] = None,
        limits: Optional[dict] = None,
    ) -> None:
        if not callable(getattr(next_processor, "on_end", None)):
            raise TypeError("RedactingSpanProcessorWith: next_processor must be a SpanProcessor")
        if not callable(scan_and_redact):
            raise TypeError("RedactingSpanProcessorWith: scan_and_redact must be callable")
        self._next = next_processor
        self._scan_and_redact = scan_and_redact
        self._policy = policy
        self._limits = limits

    def on_start(self, span: "Span", parent_context: Optional["Context"] = None) -> None:
        self._next.on_start(span, parent_context)

    def _on_ending(self, span: "Span") -> None:
        # Not part of the duck-typed surface the original example assumed:
        # opentelemetry-sdk 1.40 and above call this private hook on every
        # registered processor, unconditionally, so a class without it
        # raises AttributeError out of `Span.end()` on those versions --
        # found by tests/test_otel_host.py, the first test to use a real
        # SDK. Versions below 1.40 never call it at all, so this is a no-op
        # there, not a version check.
        on_ending = getattr(self._next, "_on_ending", None)
        if callable(on_ending):
            on_ending(span)

    def on_end(self, span: "ReadableSpan") -> None:
        redact_attributes_with(
            self._scan_and_redact, getattr(span, "_attributes", None), policy=self._policy, limits=self._limits
        )
        for event in getattr(span, "events", ()) or ():
            redact_attributes_with(
                self._scan_and_redact, getattr(event, "_attributes", None), policy=self._policy, limits=self._limits
            )
        self._next.on_end(span)

    def shutdown(self) -> None:
        self._next.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        return self._next.force_flush(timeout_millis)


def create_redacting_span_processor(
    next_processor: "SpanProcessor", *, policy: Optional[Any] = None, limits: Optional[dict] = None
) -> RedactingSpanProcessorWith:
    """The live wrapper: wraps `next_processor` with the real
    `redact_secret.scan_and_redact`. There is no init step for the Python
    bindings (the native extension loads on `import redact_secret`), unlike
    the JS package's `await initialize()`."""
    import redact_secret

    return RedactingSpanProcessorWith(next_processor, redact_secret.scan_and_redact, policy=policy, limits=limits)
