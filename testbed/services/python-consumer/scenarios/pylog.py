"""Python logging qualification through the final handler output (#194, epic #190).

Every assertion reads what a handler wrote. on_outcome counts are a secondary fact, never the
reason a scenario passes. Placement recipes follow examples/placement-python (#183),
configurations follow examples/policy-python (#181).

Candidate mode includes the unreleased aggregate budget (operation_limits) and explicit PII
activation (pii=); the published pin does not. Those lanes call require_feature(): required (a
failed check) in candidate mode, an explicit "unsupported" result in published mode.
"""

import json
import logging
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _pylog_lib import (  # noqa: E402
    BLOCK_MARKER,
    EMAIL,
    ERROR_MARKER,
    LIMIT_MARKER,
    PASSWORD,
    PEM,
    TOKEN,
    JsonFormatter,
    Sink,
    features,
    filter_cls,
    keep,
    make_handler,
    make_logger,
    require_feature,
    run_profile,
    verdict,
)


def json_lines(text):
    try:
        return [json.loads(line) for line in text.splitlines() if line]
    except ValueError:
        return None


def raise_and_log(logger, message="failed %s"):
    try:
        raise ValueError(f"bad {TOKEN}")
    except ValueError:
        logger.exception(message, TOKEN, extra={"ctx": {"api_key": TOKEN, "n": 3}})


def every_handler_filtered(ctx, rec):
    flt = filter_cls()
    console, console_out = make_handler(flt())
    audit, audit_out = make_handler(flt(), JsonFormatter())
    logger = make_logger(console, audit)
    logger.warning("deploy with token %s", TOKEN)
    logger.info("%(t)s and %(u)s", {"t": TOKEN, "u": "fine"})
    logger.info("plain")
    keep(ctx, "pylog.every-handler-filtered", console_out.getvalue() + audit_out.getvalue())
    rec.check("console handler: verdict is PROTECTED", verdict(console_out.getvalue()) == "PROTECTED")
    rec.check("audit handler: verdict is PROTECTED", verdict(audit_out.getvalue()) == "PROTECTED")
    rows = json_lines(audit_out.getvalue())
    rec.check("audit handler keeps its JSON shape", rows is not None and len(rows) == 3)
    rec.check("interpolated message masked, text kept", "deploy with token " in console_out.getvalue())
    rec.check("dict-style args masked, untouched value kept", rows is not None and rows[1]["msg"].endswith(" and fine"))
    rec.check("unrelated record unchanged", rows is not None and rows[2]["msg"] == "plain")


def exceptions_and_extras(ctx, rec):
    flt = filter_cls()
    handler, out = make_handler(flt(extra_fields=["ctx"]), JsonFormatter())
    logger = make_logger(handler)
    raise_and_log(logger)
    keep(ctx, "pylog.exceptions-and-extras", out.getvalue())
    [row] = json_lines(out.getvalue()) or [{}]
    rec.check("verdict is PROTECTED", verdict(out.getvalue()) == "PROTECTED")
    rec.check("the traceback keeps its shape", str(row.get("exc", "")).startswith("Traceback (most recent call last)"))
    rec.check("the exception message is masked", "ValueError: bad <SECRET_" in str(row.get("exc", "")))
    rec.check("the listed extra is walked and masked", row.get("ctx", {}).get("api_key", "").startswith("<SECRET_"))
    rec.check("a number in the extra is kept", row.get("ctx", {}).get("n") == 3)
    rec.check("cached exc_text is scanned too", _cached_exc_text_masked(flt))


def _cached_exc_text_masked(flt):
    handler, out = make_handler(flt(), logging.Formatter("%(message)s"))
    logger = make_logger(handler)
    record = logger.makeRecord(logger.name, logging.ERROR, __file__, 0, "cached", (), None)
    record.exc_text = f"Traceback ... ValueError: bad {TOKEN}"
    logger.handle(record)
    return TOKEN not in out.getvalue() and "<SECRET_" in out.getvalue()


def propagation(ctx, rec):
    flt = filter_cls()
    handler, out = make_handler(flt())
    parent = make_logger(handler)
    child = logging.getLogger(f"{parent.name}.child")
    grandchild = logging.getLogger(f"{parent.name}.child.grand")
    child.warning("deploy with token %s", TOKEN)
    grandchild.warning("again %s", TOKEN)
    keep(ctx, "pylog.propagation", out.getvalue())
    rec.check("both propagated records reached the filtered handler", len(out.getvalue().splitlines()) == 2)
    rec.check("verdict is PROTECTED", verdict(out.getvalue()) == "PROTECTED")
    rec.check("logger names kept in the output", f"{parent.name}.child.grand" in out.getvalue())


def negative_controls(ctx, rec):
    flt = filter_cls()
    # 1: a handler without the filter.
    bare, bare_out = make_handler()
    make_logger(bare).warning("deploy with token %s", TOKEN)
    keep(ctx, "pylog.negative-controls.no-filter", bare_out.getvalue())
    rec.check("no filter: verifier reports LEAKED", verdict(bare_out.getvalue()) == "LEAKED")

    # 2: the filter on the parent LOGGER does not run for a propagated child record.
    parent_handler, parent_out = make_handler()
    parent = make_logger(parent_handler)
    parent.addFilter(flt())
    logging.getLogger(f"{parent.name}.child").warning("deploy with token %s", TOKEN)
    keep(ctx, "pylog.negative-controls.ancestor-logger-filter", parent_out.getvalue())
    rec.check("ancestor logger filter: verifier reports LEAKED", verdict(parent_out.getvalue()) == "LEAKED")

    # 3: handlers run in order; an unfiltered handler placed first writes plaintext.
    first, first_out = make_handler()
    second, _ = make_handler(flt())
    make_logger(first, second).warning("deploy with token %s", TOKEN)
    keep(ctx, "pylog.negative-controls.unfiltered-first", first_out.getvalue())
    rec.check("unfiltered handler ahead of a filtered one: LEAKED", verdict(first_out.getvalue()) == "LEAKED")

    # 4: an extra field the filter was not told about reaches a structured handler.
    unlisted, unlisted_out = make_handler(flt(), JsonFormatter())
    make_logger(unlisted).info("event", extra={"ctx": {"api_key": TOKEN}})
    keep(ctx, "pylog.negative-controls.unlisted-extra", unlisted_out.getvalue())
    rec.check("extra field not listed in extra_fields: LEAKED", verdict(unlisted_out.getvalue()) == "LEAKED")

    # 5: a pipeline that drops everything proves nothing.
    rec.check("empty output is UNVERIFIED, not PROTECTED", verdict("") == "UNVERIFIED")
    rec.check("output with no marker is UNVERIFIED", verdict("INFO x hello\n") == "UNVERIFIED")

    # 6: the same verifier calls the properly protected path PROTECTED.
    ok, ok_out = make_handler(flt())
    make_logger(ok).warning("deploy with token %s", TOKEN)
    rec.check("filtered handler is PROTECTED under the same verifier", verdict(ok_out.getvalue()) == "PROTECTED")


def policy_warn(ctx, rec):
    outcomes = []
    handler, out = make_handler(filter_cls()(on_outcome=outcomes.append))
    make_logger(handler).info("password=%s", PASSWORD)
    keep(ctx, "pylog.policy-warn", out.getvalue())
    rec.check("the warn value is in the handler text (expected, documented)", PASSWORD in out.getvalue())
    rec.compare(
        "warn value in the handler output", "unchanged (warn)", "unchanged (warn)" if PASSWORD in out.getvalue() else "changed", "warn"
    )
    rec.check("verifier reports it as LEAKED, expected for a warn", verdict(out.getvalue(), [PASSWORD]) == "LEAKED")
    v = outcomes[0].values
    rec.check("the finding was reported, nothing redacted", v.findings > 0 and v.redacted == 0)
    rec.check("nothing blocked or failed", v.blocked == 0 and v.failed == 0)
    rec.evidence["expectation"] = "warn leaves text unchanged"


def policy_block(ctx, rec):
    outcomes = []
    handler, out = make_handler(filter_cls()(on_outcome=outcomes.append))
    make_logger(handler).info("key %s", PEM)
    keep(ctx, "pylog.policy-block", out.getvalue())
    rec.check(
        "key material absent", "SYNTHETICREVOKEDNOTAREALKEY" not in out.getvalue() and "BEGIN RSA" not in out.getvalue()
    )
    rec.check("fixed BLOCKED marker is the whole message", out.getvalue().strip().endswith(f" {BLOCK_MARKER}"))
    rec.check("one line, record shape kept", len(out.getvalue().splitlines()) == 1)
    rec.compare("private-key message", BLOCK_MARKER, out.getvalue().strip().rsplit(" ", 1)[-1], "block")
    rec.check("blocked value counted", outcomes[0].values.blocked > 0)


def policy_explicit(ctx, rec):
    def policy(finding, context):
        return "block" if finding.type == "private_key" else "redact"

    handler, out = make_handler(filter_cls()(policy=policy))
    logger = make_logger(handler)
    logger.info("password=%s", PASSWORD)
    logger.info("key %s", PEM)
    keep(ctx, "pylog.policy-explicit", out.getvalue())
    rec.check("the former warn value is masked", PASSWORD not in out.getvalue())
    rec.compare(
        "former warn value under an explicit policy", "masked", "plaintext" if PASSWORD in out.getvalue() else "masked", "policy"
    )
    rec.check("verdict is PROTECTED", verdict(out.getvalue()) == "PROTECTED")
    rec.check("block is still honoured under the explicit policy", BLOCK_MARKER in out.getvalue())


def limits_string(ctx, rec):
    outcomes = []
    handler, out = make_handler(filter_cls()(limits={"max_string_length": 60}, on_outcome=outcomes.append))
    logger = make_logger(handler)
    logger.info("%s%s", "y" * 80, TOKEN)
    logger.info("short %s", TOKEN)
    keep(ctx, "pylog.limits-string", out.getvalue())
    first, second = out.getvalue().splitlines()
    rec.check("oversized message replaced by the LIMIT marker", first.endswith(f" {LIMIT_MARKER}"))
    rec.check("no plaintext fallback", TOKEN not in out.getvalue() and "yyyy" not in out.getvalue())
    rec.check("a message within the limit is masked normally", "<SECRET_" in second)
    rec.check("limited value counted", outcomes[0].values.limited > 0)


def limits_record_budget(ctx, rec):
    if not require_feature(
        ctx,
        rec,
        "record-budget",
        features()["budget"],
        "the installed redact-secret-adapters has no operation_limits (#173)",
    ):
        return
    outcomes = []
    flt = filter_cls()(operation_limits={"max_scans": 1}, extra_fields=["ctx"], on_outcome=outcomes.append)
    handler, out = make_handler(flt, JsonFormatter())
    logger = make_logger(handler)
    logger.info("m %s", TOKEN, extra={"ctx": {"a": TOKEN, "b": TOKEN}})
    keep(ctx, "pylog.limits-record-budget", out.getvalue())
    [row] = json_lines(out.getvalue()) or [{}]
    rec.check("one JSON line written", bool(row))
    rec.check("no plaintext fallback", TOKEN not in out.getvalue())
    rec.check("fixed LIMIT marker present", LIMIT_MARKER in out.getvalue())
    rec.check("the unit was reported as limited", outcomes[0].values.limited > 0)
    again, again_out = make_handler(filter_cls()(operation_limits={"max_scans": 1000}))
    make_logger(again).info("deploy %s", TOKEN)
    rec.check("a record within budget is masked normally", verdict(again_out.getvalue()) == "PROTECTED")


def injected_scanner_failure(ctx, rec):
    def raises(*_a, **_k):
        raise RuntimeError(f"injected failure carrying {TOKEN}")

    faults = {"raises": raises, "returns none": lambda *_a, **_k: None, "returns no text": lambda *_a, **_k: object()}
    for name, fake in faults.items():
        outcomes = []
        handler, out = make_handler(
            filter_cls()(fake, extra_fields=["ctx"], on_outcome=outcomes.append), JsonFormatter()
        )
        logger = make_logger(handler)
        raise_and_log(logger)
        keep(ctx, f"pylog.injected-scanner-failure.{name}", out.getvalue())
        rows = json_lines(out.getvalue())
        rec.check(f"{name}: no plaintext fallback", TOKEN not in out.getvalue())
        rec.check(f"{name}: handler JSON shape kept", rows is not None and len(rows) == 1)
        rec.check(f"{name}: fixed ERROR marker used", ERROR_MARKER in out.getvalue())
        rec.check(f"{name}: failures counted", outcomes[0].values.failed > 0)


def bad_format_args(ctx, rec):
    handler, out = make_handler(filter_cls()())
    logger = make_logger(handler)
    logger.info("count %d", TOKEN)  # wrong argument type
    logger.info("two %s %s", TOKEN)  # too few arguments
    keep(ctx, "pylog.bad-format-args", out.getvalue())
    lines = out.getvalue().splitlines()
    rec.check("both records reached the handler", len(lines) == 2)
    rec.check("fixed ERROR marker used", all(line.endswith(f" {ERROR_MARKER}") for line in lines))
    rec.check("no plaintext fallback", TOKEN not in out.getvalue())


def _profile(name):
    return run_profile(name)


def pii_default(ctx, rec):
    r = _profile("default")
    rec.check("the isolated process finished", r is not None)
    if r is None:
        return
    keep(ctx, "pylog.pii-default", r["line"])
    rec.check("credential masked", TOKEN not in r["line"])
    rec.check("PII stays (PII not activated)", EMAIL in r["line"])
    rec.check("warn value stays", PASSWORD in r["line"])
    rec.check("nothing blocked or failed", r["counts"]["blocked"] == 0 and r["counts"]["failed"] == 0)
    rec.evidence["findings"] = r["counts"]["findings"]


def pii_global(ctx, rec):
    base, r = _profile("default"), _profile("pii")
    rec.check("the isolated processes finished", r is not None and base is not None)
    if r is None or base is None:
        return
    keep(ctx, "pylog.pii-global", r["line"])
    rec.check("credential masked", TOKEN not in r["line"])
    rec.check("high-confidence PII masked", EMAIL not in r["line"])
    rec.check("warn value still plaintext under the default policy", PASSWORD in r["line"])
    rec.check("one more finding than with PII off", r["counts"]["findings"] > base["counts"]["findings"])


def pii_explicit_policy(ctx, rec):
    r = _profile("policy")
    rec.check("the isolated process finished", r is not None)
    if r is None:
        return
    keep(ctx, "pylog.pii-explicit-policy", r["line"])
    rec.check("verdict is PROTECTED", verdict(r["line"]) == "PROTECTED")
    rec.check("credential, email and warn value all masked", all(s not in r["line"] for s in (TOKEN, EMAIL, PASSWORD)))
    rec.check("nothing blocked or failed", r["counts"]["blocked"] == 0 and r["counts"]["failed"] == 0)


def pii_adapter_first(ctx, rec):
    if not require_feature(
        ctx,
        rec,
        "pii-argument",
        features()["pii"],
        "RedactSecretFilter(pii=...) is not in the installed adapter (#176)",
    ):
        return
    r = _profile("adapter-first")
    rec.check("the isolated process finished", r is not None)
    if r is None:
        return
    keep(ctx, "pylog.pii-adapter-first", r["line"])
    rec.check("credential masked", TOKEN not in r["line"])
    rec.check("PII masked from the first record (no silent window)", EMAIL not in r["line"])
    rec.check("warn value still plaintext under the default policy", PASSWORD in r["line"])


def pii_conflict(ctx, rec):
    if not require_feature(
        ctx,
        rec,
        "pii-argument",
        features()["pii"],
        "RedactSecretFilter(pii=...) is not in the installed adapter (#176)",
    ):
        return
    r = _profile("conflict")
    rec.check("the isolated process finished", r is not None)
    if r is None:
        return
    rec.check("the conflicting selection rejected", r["rejected"] is True)
    rec.check("rejected with CoreActivationError", r.get("type") == "CoreActivationError")
    rec.check("rejection carries a fixed code", isinstance(r.get("code"), str) and r["code"].isupper())
    rec.check("the message does not echo the selector", r["leaks_selector"] is False)
    rec.evidence["code"] = r.get("code")


def bounded_capture(ctx, rec):
    sink = Sink(8 * 1024)
    handler, _ = make_handler(filter_cls()(), sink=sink)
    logger = make_logger(handler)
    for i in range(400):
        logger.info("flood %s %d", TOKEN, i)
    text = sink.getvalue()
    rec.check("sink stayed under its byte cap", len(text) <= sink.max_bytes)
    rec.check("excess records were dropped, not buffered", sink.dropped > 0)
    rec.check("every retained line is whole", all(line.startswith("INFO ") for line in text.splitlines()))
    rec.check("retained output is clean", verdict(text) == "PROTECTED")

    # A fresh instance of the consumer's own bounded sink (captures.py), so shared captures stay intact.
    sink_type = type(ctx["captures"])
    limits = sys.modules[sink_type.__module__]
    caps = sink_type()
    for i in range(limits.MAX_ENTRIES + 50):
        caps.add(f"flood-{i}", "z" * limits.MAX_ENTRY_BYTES * 3)
    snap = caps.snapshot()
    rec.check("capture sink caps the entry count", len(snap) == limits.MAX_ENTRIES)
    rec.check("capture sink caps each entry", all(len(e["body"]) <= limits.MAX_ENTRY_BYTES for e in snap))
    rec.check("capture sink drops the oldest first", snap[0]["label"] == "flood-50")
    rec.evidence["dropped"] = sink.dropped


def _scenario(sid, title, classification, run):
    return {"id": sid, "title": title, "classification": classification, "run": run}


SCENARIOS = [
    _scenario(
        "pylog.every-handler-filtered",
        "Two filtered handlers with different formats: both destinations are clean and keep their shape",
        "qualification",
        every_handler_filtered,
    ),
    _scenario(
        "pylog.exceptions-and-extras",
        "Exceptions, cached exc_text and listed extra fields are clean in a structured handler",
        "qualification",
        exceptions_and_extras,
    ),
    _scenario(
        "pylog.propagation",
        "Propagated child records are clean through the parent's filtered handler",
        "qualification",
        propagation,
    ),
    _scenario(
        "pylog.negative-controls",
        "Unfiltered, ancestor-filtered, mis-ordered and unlisted-extra paths are LEAKED; empty output is UNVERIFIED",
        "negative-control",
        negative_controls,
    ),
    _scenario(
        "pylog.policy-warn",
        "Default policy: a warn finding (password-shaped value) stays plaintext in the handler, and is counted",
        "negative-control",
        policy_warn,
    ),
    _scenario(
        "pylog.policy-block",
        "A private-key block is replaced whole by the fixed BLOCKED marker; the record shape is kept",
        "qualification",
        policy_block,
    ),
    _scenario(
        "pylog.policy-explicit",
        "An explicit policy mapping every finding to redact masks the warn value in the handler",
        "qualification",
        policy_explicit,
    ),
    _scenario(
        "pylog.limits-string",
        "max_string_length: an oversized message is replaced by the fixed LIMIT marker, never passed through",
        "qualification",
        limits_string,
    ),
    _scenario(
        "pylog.limits-record-budget",
        "Aggregate record budget (candidate): an exhausted budget yields the fixed LIMIT marker, never plaintext",
        "qualification",
        limits_record_budget,
    ),
    _scenario(
        "pylog.injected-scanner-failure",
        "FAULT INJECTION: a scanner that raises or returns garbage yields the fixed ERROR marker, never plaintext",
        "failure-injection",
        injected_scanner_failure,
    ),
    _scenario(
        "pylog.bad-format-args",
        "Unformattable %-arguments become the fixed ERROR marker, not a plaintext handleError dump",
        "qualification",
        bad_format_args,
    ),
    _scenario(
        "pylog.pii-default",
        "Own process, PII off: the credential is masked, the email and the warn value remain in the handler",
        "negative-control",
        pii_default,
    ),
    _scenario(
        "pylog.pii-global",
        "Own process, pii:global activated by the application: the email is masked, the warn value remains",
        "qualification",
        pii_global,
    ),
    _scenario(
        "pylog.pii-explicit-policy",
        "Own process, pii:global with an explicit policy: every finding is masked",
        "qualification",
        pii_explicit_policy,
    ),
    _scenario(
        "pylog.pii-adapter-first",
        "Own process (candidate): RedactSecretFilter(pii=...) activates PII before the first record",
        "qualification",
        pii_adapter_first,
    ),
    _scenario(
        "pylog.pii-conflict",
        "Own process (candidate): a conflicting second PII selection raises a fixed-code CoreActivationError",
        "qualification",
        pii_conflict,
    ),
    _scenario(
        "pylog.bounded-capture",
        "Capture size is bounded: a flooded sink keeps whole lines under its cap; the shared capture sink caps entries",
        "qualification",
        bounded_capture,
    ),
]
