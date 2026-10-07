"""The verified scan options (redact-secret-adapters#175): validation,
snapshot, what reaches the scanner, the version gate and the fixed, input-free
errors against fakes, and the options through the real core."""

from __future__ import annotations

import logging
from pathlib import Path

import pytest
from fake_scanner import FakeResult, fake_scan_and_redact

from redact_secret_adapters import (
    BLOCK_MARKER,
    ERROR_MARKER,
    CoreOptionsError,
    mask_leaf_outcome_with,
    mask_leaf_with,
    mask_log_value_with,
    mask_secrets_with,
    resolve_scan_config,
    verify_scan_options,
)
from redact_secret_adapters.logging_filter import RedactSecretFilter
from redact_secret_adapters.otel import RedactingSpanProcessorWith, redact_attributes_with
from redact_secret_adapters.scan_options import SCAN_OPTION_CORE_FLOORS, core_version_at_least

LIMITS = {"max_input_bytes": 64, "max_findings": 3}


def _formatter(finding, context) -> str:
    return "[x]"


class Recording:
    """Records every call, positional and keyword, and answers like the shared fake."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, dict]] = []

    def __call__(self, text, *args, **kwargs) -> FakeResult:
        self.calls.append((text, args, kwargs))
        return fake_scan_and_redact(text)


def test_with_none_of_the_options_the_scanner_is_called_as_it_always_was() -> None:
    scan = Recording()
    mask_leaf_with(scan, "plain")
    assert scan.calls == [("plain", (None,), {})]
    policy = object()
    mask_leaf_with(scan, "plain", policy=policy)
    assert scan.calls[1] == ("plain", (policy,), {})
    assert resolve_scan_config().requested == ()


def test_every_requested_option_reaches_every_scan_including_key_context_views() -> None:
    scan = Recording()
    mask_secrets_with(
        scan, {"api_key": "v", "list": ["a"]}, scan_limits=LIMITS, ruleset="r", placeholder_formatter=_formatter
    )
    assert [text for text, _, _ in scan.calls] == ["v", '{"api_key":"v"}', "a"]
    for _, args, kwargs in scan.calls:
        assert args == (None,)
        assert kwargs == {"limits": LIMITS, "ruleset": "r", "formatter": _formatter}


def test_names_and_a_fixed_requested_order() -> None:
    config = resolve_scan_config(None, LIMITS, "r", _formatter)
    assert config.requested == ("scan_limits", "ruleset", "placeholder_formatter")
    assert sorted(SCAN_OPTION_CORE_FLOORS) == ["action_policy", "placeholder_formatter", "ruleset", "scan_limits"]


def test_the_snapshot_is_taken_at_resolution() -> None:
    limits = {"max_input_bytes": 64, "max_findings": 3, "extra": "dropped"}
    ruleset = bytearray(b"ruleset-revision: 1\n")
    config = resolve_scan_config(None, limits, ruleset)
    limits["max_input_bytes"] = 1
    ruleset[:] = b"x" * len(ruleset)
    assert config.kwargs["limits"] == {"max_input_bytes": 64, "max_findings": 3}
    assert config.kwargs["ruleset"] == b"ruleset-revision: 1\n"
    assert isinstance(config.kwargs["ruleset"], bytes)


@pytest.mark.parametrize(
    "bad",
    [
        {"scan_limits": 5},
        {"scan_limits": {"max_input_bytes": 1}},
        {"scan_limits": {"max_input_bytes": -1, "max_findings": 1}},
        {"scan_limits": {"max_input_bytes": True, "max_findings": 1}},
        {"scan_limits": {"max_input_bytes": "SECRET_TOKEN_9", "max_findings": 1}},
        {"ruleset": 5},
        {"ruleset": object()},
        {"placeholder_formatter": "SECRET_TOKEN_9"},
    ],
)
def test_a_malformed_option_is_a_type_error_with_a_fixed_message(bad: dict) -> None:
    with pytest.raises(TypeError) as raised:
        resolve_scan_config(None, **bad)
    assert "SECRET_TOKEN_9" not in str(raised.value)


def test_a_malformed_option_raises_at_construction_before_any_scan() -> None:
    scan = Recording()
    with pytest.raises(TypeError):
        mask_secrets_with(scan, {"a": "x"}, ruleset=5)
    with pytest.raises(TypeError):
        mask_leaf_outcome_with(scan, "x", scan_limits={})
    with pytest.raises(TypeError):
        RedactSecretFilter(scan, ruleset=5)
    with pytest.raises(TypeError):
        RedactingSpanProcessorWith(_Next(), scan, placeholder_formatter="x")
    assert scan.calls == []


def test_scan_config_is_passed_unchanged() -> None:
    scan = Recording()
    policy = object()
    config = resolve_scan_config(policy, None, "r")
    mask_leaf_outcome_with(scan, "x", scan_config=config)
    assert scan.calls[0] == ("x", (policy,), {"ruleset": "r"})


_CONFLICTS = {
    "policy": object(),
    "action_policy": '{"version":1,"rules":[]}',
    "scan_limits": LIMITS,
    "ruleset": "r",
    "placeholder_formatter": _formatter,
}


@pytest.mark.parametrize("name", sorted(_CONFLICTS))
def test_scan_config_beside_a_loose_option_is_rejected_before_any_scan(name: str) -> None:
    scan = Recording()
    config = resolve_scan_config(None, None, "r")
    with pytest.raises(TypeError, match="scan_config already fixes the scan options"):
        mask_leaf_outcome_with(scan, "x", scan_config=config, **{name: _CONFLICTS[name]})
    assert scan.calls == []
    with pytest.raises(TypeError, match="scan_config already fixes the scan options"):
        RedactingSpanProcessorWith(_Next(), scan, scan_config=config, **{name: _CONFLICTS[name]})
    assert scan.calls == []


def test_a_scan_config_that_resolve_scan_config_did_not_build_is_rejected() -> None:
    scan = Recording()
    with pytest.raises(TypeError, match="returned by resolve_scan_config"):
        mask_leaf_outcome_with(scan, "x", scan_config={"policy": None})  # type: ignore[arg-type]
    assert scan.calls == []


def test_every_adapter_entry_point_passes_the_options() -> None:
    scan = Recording()
    mask_log_value_with(scan, ["a"], ruleset="r")
    flt = RedactSecretFilter(scan, scan_limits=LIMITS, extra_fields=("p",))
    flt.filter(logging.makeLogRecord({"msg": "m", "p": "v"}))
    attributes = {"k": "v"}
    redact_attributes_with(scan, attributes, placeholder_formatter=_formatter)
    assert all(kwargs for _, _, kwargs in scan.calls)
    assert {tuple(sorted(kwargs)) for _, _, kwargs in scan.calls} == {("ruleset",), ("limits",), ("formatter",)}


class _Next:
    def on_end(self, span) -> None:
        pass


def test_version_gate() -> None:
    floor = "0.1.0-beta.6"
    good = ["0.1.0-beta.6", "0.1.0-beta.12", "0.1.0b12", "0.1.0b6", "0.1.0", "0.2.0-alpha.1", "1.0.0"]
    assert all(core_version_at_least(v, floor) for v in good)
    bad = ["0.1.0-beta.5", "0.1.0b5", "0.1.0-alpha.9", "0.0.9", None, 7, "", "garbage"]
    assert not any(core_version_at_least(v, floor) for v in bad)
    assert core_version_at_least("0.1.0-rc.1", "0.1.0-beta.99")
    assert not core_version_at_least("0.1.0-beta.2", "0.1.0-beta.10")


class _Core:
    def __init__(self, version, scan) -> None:
        self.VERSION = version
        self.scan_and_redact = scan


def test_verify_is_a_no_op_without_options() -> None:
    def scan(text, policy=None, **kwargs):
        raise AssertionError("must not be called")

    verify_scan_options(_Core(None, scan), resolve_scan_config(object()))


@pytest.mark.parametrize("version", ["0.1.0-beta.5", None, "garbage"])
def test_an_old_or_versionless_core_is_unsupported_naming_only_the_options(version) -> None:
    config = resolve_scan_config(None, None, "SECRET_TOKEN_1", _formatter)
    with pytest.raises(CoreOptionsError) as raised:
        verify_scan_options(_Core(version, fake_scan_and_redact), config)
    assert raised.value.code == "CORE_OPTION_UNSUPPORTED"
    assert raised.value.options == ("ruleset", "placeholder_formatter")
    assert "SECRET_TOKEN_1" not in str(raised.value) + repr(raised.value.__dict__)


def test_a_core_that_rejects_the_options_is_rejected_with_only_an_allowlisted_code() -> None:
    config = resolve_scan_config(None, None, "SECRET_TOKEN_1")

    def rejecting(code):
        def scan(text, policy=None, **kwargs):
            error = RuntimeError("leaks SECRET_TOKEN_1")
            error.code = code  # type: ignore[attr-defined]
            raise error

        return scan

    with pytest.raises(CoreOptionsError) as known:
        verify_scan_options(_Core("0.1.0-beta.12", rejecting("INVALID_RULESET")), config)
    assert (known.value.code, known.value.core_code) == ("CORE_OPTION_REJECTED", "INVALID_RULESET")
    with pytest.raises(CoreOptionsError) as unknown:
        verify_scan_options(_Core("0.1.0-beta.12", rejecting("SECRET_TOKEN_1")), config)
    assert unknown.value.core_code is None
    assert "SECRET_TOKEN_1" not in str(unknown.value) + repr(unknown.value.__dict__)
    assert unknown.value.__cause__ is None


def test_the_probe_is_the_empty_text_with_the_snapshot_it_will_scan_with() -> None:
    scan = Recording()
    config = resolve_scan_config(None, LIMITS)
    verify_scan_options(_Core("0.1.0b6", scan), config)
    assert scan.calls == [("", (None,), {"limits": config.kwargs["limits"]})]


# --- through the real core -------------------------------------------------

redact_secret = pytest.importorskip("redact_secret")

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures"
RULESET = (
    "ruleset-revision: 1\ndetector: synthetic-example-token\nspecificity: contextual\n"
    'prefix: "SYNTH_"\nalphabet: alnum-dash\nrun: at-least 20\nvalidator: none\n'
)
BROKEN = "ruleset-revision: 1\nSYNTHETIC-BROKEN-RULESET-MARKER\n"
TOKEN = "SYNTH_EXAMPLE-TOKEN-000000000001"
AROUND = f"value {TOKEN} end"
GITHUB = "ghp_" + "x" * 36


def _live(**options):
    record = logging.makeLogRecord({"msg": "m", "payload": [AROUND]})
    RedactSecretFilter(extra_fields=("payload",), **options).filter(record)
    return record.payload  # type: ignore[attr-defined]


def test_the_fixture_ruleset_matches_the_typescript_one() -> None:
    text = (FIXTURES / "scan-options.ts").read_text("utf-8")
    assert "SYNTH_" in text and TOKEN in text


def test_policy_precedence_with_a_ruleset_in_the_live_filter() -> None:
    assert _live(ruleset=RULESET) == [AROUND]  # the core's default policy only warns on a ruleset finding
    assert _live(ruleset=RULESET, policy=lambda f, c: "redact") == ["value <SECRET_1> end"]
    assert _live(ruleset=RULESET, policy=lambda f, c: "block") == [BLOCK_MARKER]
    assert _live(ruleset=RULESET, policy=lambda f, c: "warn") == [AROUND]
    assert _live(policy=lambda f, c: "redact") == [AROUND]  # no ruleset, no detection


def test_ruleset_bytes_and_a_custom_formatter_in_the_live_filter() -> None:
    out = _live(
        ruleset=RULESET.encode(),
        policy=lambda f, c: "redact",
        placeholder_formatter=lambda f, c: f"[{f.type}#{c.placeholder_index}]",
    )
    assert out[0].startswith("value [") and out[0].endswith("#1] end") and TOKEN not in out[0]


def test_low_ceilings_are_the_cores_and_a_keyed_leaf_has_the_ceiling_minus_its_key() -> None:
    limits = {"max_input_bytes": 16, "max_findings": 4}
    out = mask_secrets_with(
        redact_secret.scan_and_redact,
        {"a": "0123456789", "list": ["0123456789", "x" * 40]},
        scan_limits=redact_secret.WholeInputLimits(**limits),
    )
    assert out == {"a": ERROR_MARKER, "list": ["0123456789", ERROR_MARKER]}


def test_a_scan_limits_mapping_is_converted_by_the_live_factories_and_snapshotted() -> None:
    limits = {"max_input_bytes": 40, "max_findings": 4}
    record = logging.makeLogRecord({"msg": "short"})
    flt = RedactSecretFilter(scan_limits=limits)
    limits["max_input_bytes"] = 1_000_000
    flt.filter(record)
    assert record.msg == "short"
    big = logging.makeLogRecord({"msg": "y" * 60})
    flt.filter(big)
    assert big.msg == ERROR_MARKER


def test_a_throwing_policy_or_formatter_fails_closed_without_the_message() -> None:
    def boom(*args):
        raise RuntimeError("SYNTHETIC-CALLBACK-LEAK " + TOKEN)

    assert _live(ruleset=RULESET, policy=boom) == [ERROR_MARKER]
    assert _live(ruleset=RULESET, policy=lambda f, c: "redact", placeholder_formatter=boom) == [ERROR_MARKER]


def test_a_rejected_ruleset_or_limits_is_a_fixed_error_at_construction() -> None:
    with pytest.raises(CoreOptionsError) as raised:
        RedactSecretFilter(ruleset=BROKEN)
    assert (raised.value.code, raised.value.core_code, raised.value.options) == (
        "CORE_OPTION_REJECTED",
        "INVALID_RULESET",
        ("ruleset",),
    )
    assert "SYNTHETIC-BROKEN" not in str(raised.value) + repr(raised.value.__dict__)
    with pytest.raises(CoreOptionsError) as limits:
        RedactSecretFilter(scan_limits={"max_input_bytes": 0, "max_findings": 0})
    assert limits.value.core_code == "INVALID_LIMITS"


def test_the_span_processor_factory_takes_the_options_too() -> None:
    pytest.importorskip("opentelemetry.sdk.trace")
    from redact_secret_adapters.otel import create_redacting_span_processor

    class Item:
        _name = "n"
        name = "n"
        events = ()
        links = ()
        status = None

        def __init__(self, attributes: dict) -> None:
            self._attributes = attributes
            self.attributes = attributes

    span = Item({"note": AROUND})
    create_redacting_span_processor(
        _Next(), ruleset=RULESET, policy=lambda f, c: "redact", scan_limits={"max_input_bytes": 4096, "max_findings": 4}
    ).on_end(span)
    assert span._attributes == {"note": "value <SECRET_1> end"}
    with pytest.raises(CoreOptionsError):
        create_redacting_span_processor(_Next(), ruleset=BROKEN)


def test_omitting_every_new_option_still_works_exactly_as_before() -> None:
    out = mask_secrets_with(redact_secret.scan_and_redact, {"list": [f"token {GITHUB}"]})
    assert out == {"list": ["token <SECRET_1>"]}
