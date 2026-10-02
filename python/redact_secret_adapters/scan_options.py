"""The verified core scan options the logging and tracing adapters pass
through (redact-secret-adapters#175), the Python twin of
``packages/adapter/src/scan-options.ts``: whole-input limits, a declarative
ruleset and a placeholder formatter, beside the ``policy`` always passed.

The core owns every one of them. This module detects nothing and decides no
policy: it validates the *shape* of what a caller asked for, takes a
**snapshot** of it, and hands exactly that to ``scan_and_redact`` on every
scan, so the adapter's own limits (traversal, aggregate budget) stay separate
from what the core is asked to enforce.

Names. ``limits`` is already the adapter's *walk* limits, so the core's
whole-input limits are ``scan_limits``: a mapping with ``max_input_bytes`` and
``max_findings`` (or an object with those attributes, such as
``redact_secret.WholeInputLimits``). The live factories convert a mapping to
``redact_secret.WholeInputLimits``; a function given an injected
``scan_and_redact`` passes a mapping on as a ``dict``, so pass a
``WholeInputLimits`` there when the scanner is the real core. ``ruleset`` and
``placeholder_formatter`` (the core's ``formatter``) keep the core's meaning.

Policy precedence. There is exactly one policy and the adapter never combines
two: the caller's ``policy``, when given, **replaces** the core's built-in
policy for every finding, including those a ``ruleset`` detector adds; omit it
and the core's policy decides. A ``block`` finding replacing the whole leaf and
a ``warn`` leaving the text alone apply on top of whatever action the policy
returned, and never change it. A ruleset adds detections, never an action.

Snapshot. A ``scan_limits`` mapping is copied and a ``bytes``/``bytearray``
ruleset is copied to immutable ``bytes``, so mutating the caller's object
afterwards changes nothing. A ``policy`` and a ``placeholder_formatter`` are
callbacks and are held by reference.

Availability. Whole-input scans only; every option is available from the
declared core floor (``SCAN_OPTION_CORE_FLOORS``). The live factories check the
installed core's ``VERSION`` against it and probe the options with one scan
of the empty text, so an unsupported core or a ruleset that does not parse is a fixed,
input-free :class:`CoreOptionsError` at construction, never a silently ignored
option.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

__all__ = [
    "SCAN_OPTION_CORE_FLOORS",
    "CoreOptionsError",
    "ScanConfig",
    "core_version_at_least",
    "resolve_scan_config",
    "verify_scan_options",
]

# The oldest ``redact-secret`` each option has been verified against: the
# declared floor of ``dependencies`` in ``pyproject.toml``.
SCAN_OPTION_CORE_FLOORS: dict[str, str] = {
    "scan_limits": "0.1.0-beta.6",
    "ruleset": "0.1.0-beta.6",
    "placeholder_formatter": "0.1.0-beta.6",
}


@dataclass(frozen=True)
class ScanConfig:
    """A validated snapshot of a caller's scan options: exactly the arguments
    passed to ``scan_and_redact`` after the text, built once. ``kwargs`` holds
    only the options that were requested (``formatter``, ``limits``,
    ``ruleset``), so a scanner that takes ``(text, policy)`` keeps working when
    none was."""

    policy: Any = None
    kwargs: Mapping[str, Any] = field(default_factory=dict)
    requested: tuple[str, ...] = ()


_EMPTY = ScanConfig()


def _is_count(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _read(source: Any, name: str) -> Any:
    return source.get(name) if isinstance(source, Mapping) else getattr(source, name, None)


def resolve_scan_config(
    policy: Optional[Any] = None,
    scan_limits: Optional[Any] = None,
    ruleset: Optional[Any] = None,
    placeholder_formatter: Optional[Callable[..., Any]] = None,
    *,
    limits_type: Optional[Callable[..., Any]] = None,
) -> ScanConfig:
    """Validates and snapshots the options. Raises ``TypeError`` with a fixed
    message for a malformed one: a programming error, not an input. With none
    of the three options given the result passes only ``policy``, as the
    adapters always have. ``limits_type`` builds the core's own limits object
    from the two numbers (the live factories pass ``redact_secret.WholeInputLimits``)."""
    if scan_limits is None and ruleset is None and placeholder_formatter is None:
        return _EMPTY if policy is None else ScanConfig(policy=policy)
    kwargs: dict[str, Any] = {}
    requested: list[str] = []
    if scan_limits is not None:
        max_input_bytes = _read(scan_limits, "max_input_bytes")
        max_findings = _read(scan_limits, "max_findings")
        if not _is_count(max_input_bytes) or not _is_count(max_findings):
            raise TypeError("scan_limits must have max_input_bytes and max_findings, two non-negative integers")
        if limits_type is not None:
            try:
                kwargs["limits"] = limits_type(max_input_bytes=max_input_bytes, max_findings=max_findings)
            except Exception as error:
                # The core refuses these numbers (zero, say) when it builds its
                # own limits object: a rejected option, reported like the probe's.
                code = getattr(error, "code", None)
                raise CoreOptionsError(
                    "CORE_OPTION_REJECTED", ("scan_limits",), code if code in _FORWARDED_CORE_CODES else None
                ) from None
        elif isinstance(scan_limits, Mapping):
            kwargs["limits"] = {"max_input_bytes": max_input_bytes, "max_findings": max_findings}
        else:
            # The core's own immutable limits object: nothing to snapshot.
            kwargs["limits"] = scan_limits
        requested.append("scan_limits")
    if ruleset is not None:
        if isinstance(ruleset, str):
            kwargs["ruleset"] = ruleset
        elif isinstance(ruleset, (bytes, bytearray)):
            kwargs["ruleset"] = bytes(ruleset)
        else:
            raise TypeError("ruleset must be a str, bytes or bytearray")
        requested.append("ruleset")
    if placeholder_formatter is not None:
        if not callable(placeholder_formatter):
            raise TypeError("placeholder_formatter must be callable")
        kwargs["formatter"] = placeholder_formatter
        requested.append("placeholder_formatter")
    return ScanConfig(policy=policy, kwargs=kwargs, requested=tuple(requested))


class CoreOptionsError(Exception):
    """A refusal to run with a scan option the installed core cannot be shown
    to honor. ``code`` is ``"CORE_OPTION_UNSUPPORTED"`` or
    ``"CORE_OPTION_REJECTED"``; ``core_code`` is one of the core's own registry
    codes or ``None``; ``options`` names the options being verified. The
    message is fixed: it never carries an option value, a ruleset, an input, or
    the core's own error text."""

    _MESSAGES = {
        "CORE_OPTION_UNSUPPORTED": (
            "verify_scan_options: the installed redact_secret is older than the version a requested scan option "
            "was verified against, or does not report its version; upgrade the core or omit the option"
        ),
        "CORE_OPTION_REJECTED": (
            "verify_scan_options: the core rejected a requested scan option "
            "(a ruleset that does not parse, invalid limits, a failing callback); see core_code"
        ),
    }

    def __init__(self, code: str, options: tuple[str, ...], core_code: Optional[str] = None) -> None:
        super().__init__(self._MESSAGES[code])
        self.code = code
        self.options = options
        self.core_code = core_code


# The core codes a scan option can raise: the only thing read from an error.
_FORWARDED_CORE_CODES = frozenset(
    {
        "INVALID_RULESET",
        "INVALID_LIMITS",
        "INVALID_OPTIONS",
        "INVALID_PLACEHOLDER",
        "PLACEHOLDER_FAILURE",
        "POLICY_FAILURE",
        "INVALID_POLICY_ACTION",
    }
)

# The core reports its shared product version in SemVer form (``0.1.0-beta.12``),
# the same string as the npm package; PEP 440 (``0.1.0b12``) is accepted too.
_VERSION = re.compile(r"^(\d+)\.(\d+)\.(\d+)(?:-?(alpha|a|beta|b|rc)\.?(\d*))?$")
_PHASE = {"alpha": 0, "a": 0, "beta": 1, "b": 1, "rc": 2}


def _parse_version(text: Any) -> Optional[tuple[int, int, int, int, int]]:
    if not isinstance(text, str):
        return None
    match = _VERSION.match(text.strip())
    if match is None:
        return None
    major, minor, patch, phase, number = match.groups()
    # A release outranks its prereleases (a < b < rc < release).
    return (int(major), int(minor), int(patch), _PHASE[phase] if phase else 3, int(number) if number else 0)


def core_version_at_least(version: Any, floor: str) -> bool:
    """Whether ``version`` (``0.1.0-beta.12`` or ``0.1.0b12``) is at least ``floor``. An
    unparsable version is not."""
    have, want = _parse_version(version), _parse_version(floor)
    return have is not None and want is not None and have >= want


# The empty text: it has no finding, so no policy or formatter callback runs on
# it, and it is shorter than any whole-input byte ceiling the core accepts, so the
# probe fails only because an option is itself rejected.
_PROBE_TEXT = ""


def verify_scan_options(core: Any, config: ScanConfig) -> None:
    """The live factories' check that the installed core honors the requested
    options, run once at construction: its ``VERSION`` must be at least each
    requested option's floor, and one scan of the empty text with the options applied
    must succeed. A no-op when none of the three options was requested.
    Raises :class:`CoreOptionsError`; nothing it raises carries an option
    value, a ruleset or the core's own message."""
    if not config.requested:
        return
    unsupported = tuple(
        name
        for name in config.requested
        if not core_version_at_least(getattr(core, "VERSION", None), SCAN_OPTION_CORE_FLOORS[name])
    )
    if unsupported:
        raise CoreOptionsError("CORE_OPTION_UNSUPPORTED", unsupported)
    try:
        core.scan_and_redact(_PROBE_TEXT, config.policy, **config.kwargs)
    except Exception as error:
        code = getattr(error, "code", None)
        raise CoreOptionsError(
            "CORE_OPTION_REJECTED", config.requested, code if code in _FORWARDED_CORE_CODES else None
        ) from None
