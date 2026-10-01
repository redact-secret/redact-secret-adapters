"""A SpanProcessor (OpenTelemetry Python,
https://github.com/open-telemetry/opentelemetry-python/blob/main/opentelemetry-sdk/src/opentelemetry/sdk/trace/__init__.py)
that redacts a span's name, status description, every string and
string-sequence attribute -- including OpenInference and GenAI
semantic-convention attributes -- every event's name and attributes, and
every link's attributes before handing the span to the next processor. It
does not allowlist those attribute names: every string-shaped attribute value is
scanned, which covers any semantic convention without hardcoding it and
without a dependency on either convention's attribute list.

The SDK has no public mutation API before export: ``ReadableSpan.name``,
``.status``, ``.attributes`` and the event/link accessors are read-only.
This writes the private fields behind them instead -- ``_name``,
``_status``, ``_attributes``, and each event's ``_name``/``_attributes``
and each link's ``_attributes`` -- and reads every write back through the
public accessor. If a field is missing while its public accessor has
content, or a write does not show through, the span is **dropped** (never
exported with plaintext) and a ``RuntimeWarning`` is issued once per
processor. ``tests/test_otel_host.py`` checks the writes against a real SDK
at both ends of the declared range.

An attribute bag is a ``BoundedAttributes``, whose ``__setitem__`` raises
once its ``_immutable`` flag is set: always for event and link attributes,
and for span attributes from ``Span.end()`` on in newer SDKs (1.16.0 still
leaves them mutable in ``on_end``). Writes go through its backing ``_dict``,
the same bypass ``BoundedAttributes.__deepcopy__`` uses, so no SDK version
check is needed.

This module does not import ``opentelemetry`` at all: ``SpanProcessor``'s
``on_start``/``on_end``/``shutdown``/``force_flush`` are plain (non-
abstract) methods, so Python's duck typing means a class implementing the
same four methods -- plus the private ``_on_ending`` hook the SDK calls on
every processor -- needs no base class, no import, and no dependency --
matching ``packages/adapter-otel-trace/src/span-processor.ts``. Install the
``otel`` extra to get the SDK this module is meant to be used with:

    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from redact_secret_adapters.otel import create_redacting_span_processor

    provider = TracerProvider()
    provider.add_span_processor(create_redacting_span_processor(BatchSpanProcessor(otlp_exporter)))
"""

from __future__ import annotations

import threading
import warnings
from typing import TYPE_CHECKING, Any, Callable, Optional

if TYPE_CHECKING:  # pragma: no cover - type checking only, no runtime dependency
    from opentelemetry.context import Context
    from opentelemetry.sdk.trace import ReadableSpan, Span, SpanProcessor

from .mask_leaf import ERROR_MARKER, count_leaf, mask_leaf_outcome_with
from .outcome import OutcomeCounter, SpanOutcome, ValueCounts, notify

__all__ = ["RedactingSpanProcessorWith", "create_redacting_span_processor", "redact_attributes_with"]


def _mask_attribute_value(scan_and_redact, value, *, policy, max_string_length, counter=None, key=None):
    # ``key`` is the attribute name a plain string sits directly under (#172).
    # A sequence element is not directly under it, so it is masked without
    # key context, as an array element is everywhere else.
    def mask(text, text_key=None):
        leaf = mask_leaf_outcome_with(
            scan_and_redact, text, policy=policy, max_string_length=max_string_length, key=text_key
        )
        count_leaf(counter, leaf)
        return leaf.text

    try:
        if isinstance(value, str):
            return mask(value, key)
        if isinstance(value, (list, tuple)) and any(isinstance(item, str) for item in value):
            # The SDK accepts None inside a sequence, so mask each str
            # element and keep everything else in place.
            masked = [mask(item) if isinstance(item, str) else item for item in value]
            return tuple(masked) if isinstance(value, tuple) else masked
    except Exception:
        if counter is not None:
            counter.failed += 1
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
    (event and link attributes always; span attributes once `Span.end()`
    has run, from opentelemetry-sdk 1.43). Writing through its backing `_dict` -- present only on that real type --
    bypasses that guard instead of tripping it."""
    max_string_length = (limits or {}).get("max_string_length")
    _redact_bag(
        attributes,
        lambda value, key=None: _mask_attribute_value(
            scan_and_redact, value, policy=policy, max_string_length=max_string_length, key=key
        ),
    )


def _redact_bag(attributes: Optional[dict], mask: Callable[..., Any]) -> None:
    """Mutates an attribute mapping in place through ``mask``. Shared by
    :func:`redact_attributes_with` and the processor, so the processor's own
    masker -- the one that feeds its per-span counter -- is what runs."""
    if attributes is None:
        return
    target = getattr(attributes, "_dict", attributes)
    for key in list(target.keys()):
        target[key] = mask(target[key], key)


class _Unredactable(Exception):
    """A span field this processor must write is missing or did not take
    the write. The message names the field, never its value."""


def _private(obj: Any, field: str, public: str) -> Any:
    """``obj.<field>``, or ``None`` when absent and the public accessor is
    empty too. Absent with a non-empty public accessor means the SDK moved
    the field, and the text behind it would be exported unscanned."""
    if hasattr(obj, field):
        return getattr(obj, field)
    if getattr(obj, public, None):
        raise _Unredactable(f"{type(obj).__name__}.{field}")
    return None


def _check_written(obj: Any, public: str, expected: Any) -> None:
    if hasattr(obj, public) and getattr(obj, public) != expected:
        raise _Unredactable(f"{type(obj).__name__}.{public}")


class RedactingSpanProcessorWith:
    """Wraps `next_processor` (any object shaped like a `SpanProcessor`;
    only `on_end` is required) and redacts each span's free text (see the
    module docstring) before delegating to it. `scan_and_redact` is injected so this class is
    testable without the built native extension or a real OpenTelemetry
    dependency."""

    def __init__(
        self,
        next_processor: "SpanProcessor",
        scan_and_redact: Callable[..., Any],
        *,
        policy: Optional[Any] = None,
        limits: Optional[dict] = None,
        on_outcome: Optional[Callable[[SpanOutcome], None]] = None,
    ) -> None:
        if not callable(getattr(next_processor, "on_end", None)):
            raise TypeError("RedactingSpanProcessorWith: next_processor must be a SpanProcessor")
        if not callable(scan_and_redact):
            raise TypeError("RedactingSpanProcessorWith: scan_and_redact must be callable")
        if on_outcome is not None and not callable(on_outcome):
            raise TypeError("RedactingSpanProcessorWith: on_outcome must be callable")
        self._next = next_processor
        self._scan_and_redact = scan_and_redact
        self._policy = policy
        self._limits = limits
        self._on_outcome = on_outcome
        # Thread-local, so one thread reporting never suppresses another's
        # outcome and an observer that traces cannot recurse. The per-span
        # counter lives on it too: spans end on whatever thread created them.
        self._state = threading.local()
        self._warned = False

    def on_start(self, span: "Span", parent_context: Optional["Context"] = None) -> None:
        # Only on_end is required of next_processor (see __init__).
        on_start = getattr(self._next, "on_start", None)
        if callable(on_start):
            on_start(span, parent_context)

    def _on_ending(self, span: "Span") -> None:
        # opentelemetry-sdk 1.40+ calls this private hook on every processor
        # (older versions never do); without it Span.end() raises.
        on_ending = getattr(self._next, "_on_ending", None)
        if callable(on_ending):
            on_ending(span)

    def _mask_text(self, value: Any, key: Optional[str] = None) -> Any:
        max_string_length = (self._limits or {}).get("max_string_length")
        return _mask_attribute_value(
            self._scan_and_redact,
            value,
            policy=self._policy,
            max_string_length=max_string_length,
            counter=getattr(self._state, "counter", None),
            key=key if isinstance(key, str) else None,
        )

    def _redact_name(self, obj: Any) -> None:
        name = _private(obj, "_name", "name")
        if name is None:
            return
        masked = self._mask_text(name)
        obj._name = masked
        _check_written(obj, "name", masked)

    def _redact_attributes_of(self, obj: Any) -> None:
        attributes = _private(obj, "_attributes", "attributes")
        if attributes is None:
            return
        _redact_bag(attributes, self._mask_text)
        public = getattr(obj, "attributes", None)
        if public is not None and dict(public) != dict(getattr(attributes, "_dict", attributes)):
            raise _Unredactable(f"{type(obj).__name__}.attributes")

    def _redact_status(self, span: Any) -> None:
        if not hasattr(span, "_status"):
            if getattr(getattr(span, "status", None), "description", None):
                raise _Unredactable(f"{type(span).__name__}._status")
            return
        status = span._status
        description = getattr(status, "description", None)
        if not isinstance(description, str) or not description:
            return
        masked = self._mask_text(description)
        if masked == description:
            return
        # Replaced, not mutated: the Status may be the caller's object.
        span._status = type(status)(status.status_code, masked)
        if getattr(getattr(span, "status", None), "description", masked) != masked:
            raise _Unredactable(f"{type(span).__name__}.status")

    def _redact_span(self, span: Any) -> None:
        self._redact_name(span)
        self._redact_attributes_of(span)
        self._redact_status(span)
        for event in getattr(span, "events", None) or ():
            self._redact_name(event)
            self._redact_attributes_of(event)
        for link in getattr(span, "links", None) or ():
            self._redact_attributes_of(link)

    def on_end(self, span: "ReadableSpan") -> None:
        # A fresh counter per span, so an outcome reports this span's values
        # and not a running total, and the previous one is restored: a
        # downstream processor may end a span synchronously inside
        # ``self._next.on_end`` below, which re-enters this method.
        counting = self._on_outcome is not None
        outer = getattr(self._state, "counter", None)
        if counting:
            self._state.counter = OutcomeCounter()
        dropped = False
        values = None
        try:
            self._redact_span(span)
        except Exception as error:
            # Fail closed: a span that cannot be redacted is not exported.
            dropped = True
            if not self._warned:
                self._warned = True
                reason = str(error) if isinstance(error, _Unredactable) else type(error).__name__
                warnings.warn(
                    f"redact_secret_adapters.otel: dropped a span that could not be redacted ({reason}); "
                    "the installed opentelemetry-sdk may have changed its private span fields",
                    RuntimeWarning,
                    stacklevel=2,
                )
        finally:
            # Snapshotted before delegating: this span's numbers are final
            # here, and _report runs after a nested on_end may have replaced
            # the thread-local counter.
            if counting:
                values = (getattr(self._state, "counter", None) or OutcomeCounter()).snapshot()
            self._state.counter = outer

        try:
            if not dropped:
                self._next.on_end(span)
        finally:
            if values is not None:
                self._report(values, dropped)

    def _report(self, values: ValueCounts, dropped: bool) -> None:
        """Reports one outcome per span, whether it was forwarded or dropped,
        and after the next processor has had it, so an observer cannot affect
        what is exported."""
        if getattr(self._state, "reporting", False):
            return
        self._state.reporting = True
        try:
            notify(self._on_outcome, SpanOutcome(values=values, dropped=dropped))
        finally:
            self._state.reporting = False

    def shutdown(self) -> None:
        self._next.shutdown()

    def force_flush(self, timeout_millis: int = 30000) -> bool:
        force_flush = getattr(self._next, "force_flush", None)
        return force_flush(timeout_millis) if callable(force_flush) else True


def create_redacting_span_processor(
    next_processor: "SpanProcessor",
    *,
    policy: Optional[Any] = None,
    limits: Optional[dict] = None,
    on_outcome: Optional[Callable[[SpanOutcome], None]] = None,
) -> RedactingSpanProcessorWith:
    """The live wrapper: wraps `next_processor` with the real
    `redact_secret.scan_and_redact`.

    Credential detection needs no init step -- the native extension loads on
    `import redact_secret`, unlike the JS package's mandatory
    `await initialize()`. **PII detection does**: it is opt-in, process-wide
    and one-shot, and the application turns it on with
    `redact_secret.initialize(pii=[...])` **before the first span ends**.

    Placement is easy to get wrong here, because a tracer provider is
    usually built at import time and can export a span before the line that
    enables PII has run. Python's binding raises no conflict for a late call,
    so there is no error to catch -- only a silent window in which spans are
    scanned with PII off and report nothing. Enable PII first, then build
    the provider. See `python/tests/test_pii_activation.py`, which pins the
    window as a known limitation.

    Activating PII is not the same as masking every PII value either: under
    the core's default policy `High`-confidence PII redacts while `Medium`
    and `Low` resolve to `warn`, and a `warn` finding leaves the text alone.
    Pass your own `policy` if you need those masked."""
    import redact_secret

    return RedactingSpanProcessorWith(
        next_processor, redact_secret.scan_and_redact, policy=policy, limits=limits, on_outcome=on_outcome
    )
