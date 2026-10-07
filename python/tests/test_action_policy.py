"""The declarative ``action_policy`` (redact-secret-adapters#217): the input
forms, the snapshot, the callback conflict, what reaches every scan, the
version gate and the fixed, input-free errors against fakes, and the option
through the real core (applied from the verified floor, rejected explicitly
below it). The adapter never parses or evaluates a policy: every decision in
the live tests is the core's."""

from __future__ import annotations

import json
import logging

import pytest
from fake_scanner import FakeResult, fake_scan_and_redact

from redact_secret_adapters import (
    BLOCK_MARKER,
    CoreOptionsError,
    mask_leaf_outcome_with,
    mask_log_value_with,
    mask_secrets_with,
    resolve_scan_config,
    verify_scan_options,
)
from redact_secret_adapters.logging_filter import RedactSecretFilter
from redact_secret_adapters.otel import redact_attributes_with
from redact_secret_adapters.scan_options import SCAN_OPTION_CORE_FLOORS, core_version_at_least

DOCUMENT = {
    "actionPolicyRevision": 1,
    "base": "default",
    "rules": [{"id": "r", "match": {"type": ["t"]}, "action": "warn"}],
}
JSON_TEXT = json.dumps(DOCUMENT, separators=(",", ":"))
MARKER = "SYNTHETIC-BROKEN-POLICY-MARKER"
MALFORMED = '{"actionPolicyRevision":2,"%s":true}' % MARKER


class Recording:
    def __init__(self) -> None:
        self.calls: list[tuple[str, tuple, dict]] = []

    def __call__(self, text, *args, **kwargs) -> FakeResult:
        self.calls.append((text, args, kwargs))
        return fake_scan_and_redact(text)


def test_the_verified_floor_is_the_first_published_release_that_has_it() -> None:
    assert SCAN_OPTION_CORE_FLOORS["action_policy"] == "0.1.0-beta.14"
    assert SCAN_OPTION_CORE_FLOORS["scan_limits"] == "0.1.0-beta.6"
    assert core_version_at_least("0.1.0b14", SCAN_OPTION_CORE_FLOORS["action_policy"])
    assert not core_version_at_least("0.1.0b13", SCAN_OPTION_CORE_FLOORS["action_policy"])


def test_a_dict_is_serialized_once_text_is_kept_and_bytes_are_copied() -> None:
    assert resolve_scan_config(action_policy=DOCUMENT).kwargs["action_policy"] == JSON_TEXT
    assert resolve_scan_config(action_policy=JSON_TEXT).kwargs["action_policy"] == JSON_TEXT
    raw = bytearray(JSON_TEXT.encode())
    config = resolve_scan_config(action_policy=raw)
    raw[:] = b"\0" * len(raw)
    assert config.kwargs["action_policy"] == JSON_TEXT.encode()
    assert isinstance(config.kwargs["action_policy"], bytes)
    assert resolve_scan_config(action_policy=JSON_TEXT.encode()).kwargs["action_policy"] == JSON_TEXT.encode()


def test_it_is_requested_by_name_first_and_the_adapter_does_not_read_the_document() -> None:
    config = resolve_scan_config(None, {"max_input_bytes": 8, "max_findings": 1}, None, None, "not even json")
    assert config.requested == ("action_policy", "scan_limits")
    assert config.kwargs["action_policy"] == "not even json"
    assert resolve_scan_config().requested == ()


def test_a_snapshot_mutating_the_callers_dict_afterwards_changes_nothing() -> None:
    document = json.loads(JSON_TEXT)
    config = resolve_scan_config(action_policy=document)
    document["rules"][0]["action"] = "block"
    document["rules"].append({"id": "x", "match": {"type": ["u"]}, "action": "block"})
    assert config.kwargs["action_policy"] == JSON_TEXT


def test_a_value_that_cannot_be_a_document_is_a_type_error_with_a_fixed_message() -> None:
    cyclic: dict = {"marker": "SYNTHETIC-VALUE-MARKER"}
    cyclic["self"] = cyclic
    for bad in (42, True, [DOCUMENT], cyclic, {"k": object()}, {1, 2}):
        with pytest.raises(TypeError, match=r"^action_policy must be") as raised:
            resolve_scan_config(action_policy=bad)
        assert "SYNTHETIC-VALUE-MARKER" not in str(raised.value)


def test_a_callback_policy_beside_an_action_policy_is_rejected_before_any_scan() -> None:
    scan = Recording()
    policy = lambda finding, context: "redact"  # noqa: E731
    with pytest.raises(TypeError, match="mutually exclusive"):
        resolve_scan_config(policy, action_policy=DOCUMENT)
    for call in (
        lambda: mask_secrets_with(scan, "x", policy=policy, action_policy=JSON_TEXT),
        lambda: mask_log_value_with(scan, "x", policy=policy, action_policy=JSON_TEXT),
        lambda: mask_leaf_outcome_with(scan, "x", policy=policy, action_policy=JSON_TEXT),
        lambda: RedactSecretFilter(scan, policy=policy, action_policy=JSON_TEXT),
        lambda: redact_attributes_with(scan, {"k": "v"}, policy=policy, action_policy=JSON_TEXT),
    ):
        with pytest.raises(TypeError, match="mutually exclusive"):
            call()
    assert scan.calls == []


def test_the_one_snapshot_reaches_every_scan_of_every_entry_point_key_context_views_included() -> None:
    scan = Recording()
    document = json.loads(JSON_TEXT)
    mask_secrets_with(scan, {"api_key": "v", "list": ["a"]}, action_policy=document)
    document["rules"].clear()
    mask_log_value_with(scan, ["a"], action_policy=JSON_TEXT)
    RedactSecretFilter(scan, action_policy=JSON_TEXT, extra_fields=("p",)).filter(
        logging.makeLogRecord({"msg": "m", "p": "v"})
    )
    redact_attributes_with(scan, {"k": "v"}, action_policy=JSON_TEXT)
    assert len(scan.calls) >= 6
    assert {(args, tuple(kwargs), kwargs["action_policy"]) for _, args, kwargs in scan.calls} == {
        ((None,), ("action_policy",), JSON_TEXT)
    }


class _Core:
    def __init__(self, version, scan) -> None:
        self.VERSION = version
        self.scan_and_redact = scan


@pytest.mark.parametrize("version", ["0.1.0b13", "0.1.0-beta.6", None, "garbage"])
def test_an_older_or_versionless_core_is_refused_by_name(version) -> None:
    config = resolve_scan_config(action_policy=DOCUMENT)
    with pytest.raises(CoreOptionsError) as raised:
        verify_scan_options(_Core(version, Recording()), config)
    assert (raised.value.code, raised.value.options) == ("CORE_OPTION_UNSUPPORTED", ("action_policy",))
    assert '"rules"' not in str(raised.value)
    verify_scan_options(_Core("0.1.0b14", Recording()), config)


def test_an_older_core_still_serves_every_legacy_option_and_only_the_action_policy_is_refused() -> None:
    old = _Core("0.1.0b6", Recording())
    verify_scan_options(
        old, resolve_scan_config(None, {"max_input_bytes": 64, "max_findings": 2}, "r", lambda f, c: "[x]")
    )
    mixed = resolve_scan_config(None, {"max_input_bytes": 64, "max_findings": 2}, None, None, DOCUMENT)
    with pytest.raises(CoreOptionsError) as raised:
        verify_scan_options(old, mixed)
    assert raised.value.options == ("action_policy",)


def test_a_core_that_refuses_the_document_is_rejected_with_invalid_action_policy_and_nothing_else() -> None:
    class Refusal(Exception):
        code = "INVALID_ACTION_POLICY"

    def refusing(text, *args, **kwargs):
        raise Refusal(f"rejected {MARKER}")

    with pytest.raises(CoreOptionsError) as raised:
        verify_scan_options(_Core("0.1.0b14", refusing), resolve_scan_config(action_policy=MALFORMED))
    error = raised.value
    assert (error.code, error.core_code, error.options) == (
        "CORE_OPTION_REJECTED",
        "INVALID_ACTION_POLICY",
        ("action_policy",),
    )
    assert MARKER not in str(error) + repr(error.__dict__)


def test_the_probe_is_the_empty_text_with_the_snapshot_it_will_scan_with() -> None:
    scan = Recording()
    config = resolve_scan_config(action_policy=DOCUMENT)
    verify_scan_options(_Core("0.1.0b14", scan), config)
    assert scan.calls == [("", (None,), {"action_policy": JSON_TEXT})]


# --- through the real core -------------------------------------------------

redact_secret = pytest.importorskip("redact_secret")

HAS = core_version_at_least(getattr(redact_secret, "VERSION", None), SCAN_OPTION_CORE_FLOORS["action_policy"])
needs_core = pytest.mark.skipif(not HAS, reason="the installed core is older than the actionPolicy floor")
below_floor = pytest.mark.skipif(HAS, reason="the installed core has actionPolicy")

TOKEN = "ghp_" + "x" * 36
TEXT = f"x {TOKEN} y"


def _rule(action: str) -> dict:
    return {
        "actionPolicyRevision": 1,
        "base": "default",
        "rules": [{"id": "synthetic-rule", "match": {"type": ["github_token"]}, "action": action}],
    }


def _direct(action_policy) -> str:
    result = redact_secret.scan_and_redact(TEXT, action_policy=action_policy)
    return BLOCK_MARKER if any(f.action == "block" for f in result.findings) else result.text


def _filtered(**options) -> str:
    record = logging.makeLogRecord({"msg": TEXT})
    RedactSecretFilter(**options).filter(record)
    return record.msg


@needs_core
@pytest.mark.parametrize(
    ("action", "expected"),
    [
        ("allow", TEXT),
        ("warn", TEXT),
        ("redact", "x <SECRET_1> y"),
        ("block", BLOCK_MARKER),
        ("default", "x <SECRET_1> y"),
    ],
)
def test_each_action_in_each_form_equals_the_cores_own_decision(action, expected) -> None:
    document = _rule(action)
    text = json.dumps(document)
    for form in (document, text, text.encode(), bytearray(text.encode())):
        assert _filtered(action_policy=form) == expected
        assert mask_secrets_with(redact_secret.scan_and_redact, [TEXT], action_policy=form) == [expected]
        assert _direct(form if not isinstance(form, bytearray) else bytes(form)) == expected


@needs_core
def test_an_unmatched_finding_keeps_the_default_action() -> None:
    other = {
        "actionPolicyRevision": 1,
        "base": "default",
        "rules": [{"id": "other-type", "match": {"type": ["jwt"]}, "action": "block"}],
    }
    assert _filtered(action_policy=other) == "x <SECRET_1> y"


@needs_core
def test_it_is_a_snapshot_taken_at_construction() -> None:
    document = _rule("warn")
    raw = bytearray(json.dumps(_rule("warn")).encode())
    from_dict = RedactSecretFilter(action_policy=document)
    from_bytes = RedactSecretFilter(action_policy=raw)
    document["rules"][0]["action"] = "block"
    raw[:] = b"\0" * len(raw)
    for flt in (from_dict, from_bytes):
        record = logging.makeLogRecord({"msg": TEXT})
        flt.filter(record)
        assert record.msg == TEXT


@needs_core
def test_a_malformed_policy_is_a_fixed_error_at_construction() -> None:
    with pytest.raises(CoreOptionsError) as raised:
        RedactSecretFilter(action_policy=MALFORMED)
    assert (raised.value.code, raised.value.core_code, raised.value.options) == (
        "CORE_OPTION_REJECTED",
        "INVALID_ACTION_POLICY",
        ("action_policy",),
    )
    assert MARKER not in str(raised.value) + repr(raised.value.__dict__)


@needs_core
def test_legacy_options_work_beside_it_and_pii_stays_off() -> None:
    record = logging.makeLogRecord({"msg": f"{TEXT} mail user@example.invalid"})
    RedactSecretFilter(
        action_policy=_rule("redact"),
        scan_limits={"max_input_bytes": 4096, "max_findings": 8},
        placeholder_formatter=lambda f, c: f"[{f.type}#{c.placeholder_index}]",
    ).filter(record)
    assert record.msg == "x [github_token#1] y mail user@example.invalid"


@below_floor
def test_below_the_floor_the_option_is_rejected_by_name_and_legacy_options_still_work() -> None:
    with pytest.raises(CoreOptionsError) as raised:
        RedactSecretFilter(action_policy=_rule("block"))
    assert (raised.value.code, raised.value.options) == ("CORE_OPTION_UNSUPPORTED", ("action_policy",))
    assert (
        _filtered(policy=lambda f, c: "block", scan_limits={"max_input_bytes": 4096, "max_findings": 8}) == BLOCK_MARKER
    )
