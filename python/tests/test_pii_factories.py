"""Explicit PII activation on the live Python factories
(redact-secret/redact-secret-adapters#176).

``RedactSecretFilter(pii=...)`` and ``create_redacting_span_processor(...,
pii=...)`` share one implementation (``_activation.py``), so every ordering is
run through both. The selection cell is one-shot per process, so each real-core
case runs in its own interpreter; the injected-scanner and parser cases run
in-process against fakes and need no native extension.
"""

from __future__ import annotations

import sys
import textwrap
import unittest

from fake_scanner import fake_scan_and_redact
from test_pii_activation import _PII_SAMPLE, _pii_api_available, _run

from redact_secret_adapters import CoreActivationError
from redact_secret_adapters._activation import activate_core, activation_reflects
from redact_secret_adapters.logging_filter import RedactSecretFilter
from redact_secret_adapters.otel import RedactingSpanProcessorWith

_FACTORIES = {
    "logging": "lambda **kw: RedactSecretFilter(**kw)",
    "otel": "lambda **kw: create_redacting_span_processor(Sink(), **kw)",
}

_PRELUDE = """
import logging
import redact_secret as rs
from redact_secret_adapters import CoreActivationError
from redact_secret_adapters.logging_filter import RedactSecretFilter
from redact_secret_adapters.otel import create_redacting_span_processor

class Sink:
    def on_end(self, span):
        pass

def attempt(make, **kw):
    try:
        make(**kw)
        return "OK"
    except CoreActivationError as error:
        return error.code + "|" + str(error)
"""


def _probe(factory: str, body: str) -> list[str]:
    return _run(_PRELUDE + f"make = {_FACTORIES[factory]}\n" + textwrap.dedent(body)).splitlines()


@unittest.skipUnless(_pii_api_available(), "the installed redact_secret has no PII activation API")
class LivePiiActivationTest(unittest.TestCase):
    def each_factory(self, body: str):
        for factory in _FACTORIES:
            with self.subTest(factory=factory):
                yield _probe(factory, body)

    def test_adapter_first_activates_before_the_first_event(self) -> None:
        for out in self.each_factory(
            f"""
            print(attempt(make, pii=["pii:global"]))
            print(rs.pii_activation())
            record = logging.makeLogRecord({{"msg": {_PII_SAMPLE!r}}})
            RedactSecretFilter().filter(record)
            print(record.getMessage())
            """
        ):
            self.assertEqual("OK", out[0])
            self.assertIn("selectors=pii:global", out[1])
            self.assertNotIn("DE89370400440532013000", out[2])

    def test_application_first_then_equivalent_selection_is_accepted(self) -> None:
        for out in self.each_factory(
            """
            rs.initialize(pii=["pii:global"])
            print(attempt(make, pii=["pii:global"]))
            """
        ):
            self.assertEqual(["OK"], out)

    def test_repeated_and_duplicated_equivalent_selections_are_accepted(self) -> None:
        for out in self.each_factory(
            """
            print(attempt(make, pii=["pii:global", "pii:global"]))
            print(attempt(make, pii=["pii:global"]))
            print(attempt(make, pii=("pii:global",)))
            """
        ):
            self.assertEqual(["OK", "OK", "OK"], out)

    def test_a_conflicting_selection_is_refused_with_a_fixed_input_free_error(self) -> None:
        for out in self.each_factory(
            """
            rs.initialize(pii=["pii:global"])
            print(attempt(make, pii=[]))
            """
        ):
            code, _, message = out[0].partition("|")
            self.assertEqual("PII_ACTIVATION_NOT_ACTIVE", code)
            self.assertNotIn("pii:global", message)

    def test_application_off_then_adapter_pii_is_refused_and_leaves_pii_off(self) -> None:
        for out in self.each_factory(
            """
            rs.initialize(pii=[])
            print(attempt(make, pii=["pii:global"]))
            print(rs.pii_activation())
            """
        ):
            self.assertTrue(out[0].startswith("PII_ACTIVATION_NOT_ACTIVE|"))
            self.assertIn("selectors=off", out[1])

    def test_an_unavailable_selector_is_a_fixed_error_without_the_selector_or_core_text(self) -> None:
        for out in self.each_factory(
            """
            print(attempt(make, pii=["SENTINEL-not-a-selector"]))
            """
        ):
            code, _, message = out[0].partition("|")
            self.assertEqual("PII_ACTIVATION_UNAVAILABLE", code)
            self.assertNotIn("SENTINEL", message)

    def test_the_error_is_not_chained_to_the_core_exception(self) -> None:
        for out in self.each_factory(
            """
            try:
                make(pii=["SENTINEL-not-a-selector"])
            except CoreActivationError as error:
                print(error.__cause__, error.__context__, error.__suppress_context__)
            """
        ):
            self.assertEqual(["None None False"], out)

    def test_unsupported_core_floor_is_refused_only_when_pii_is_given(self) -> None:
        for out in self.each_factory(
            """
            del rs.pii_activation
            del rs.initialize
            print(attempt(make, pii=["pii:global"]))
            print(attempt(make))
            """
        ):
            self.assertTrue(out[0].startswith("PII_ACTIVATION_UNSUPPORTED|"))
            self.assertEqual("OK", out[1])

    def test_a_malformed_selection_is_a_type_error_and_never_initializes(self) -> None:
        for out in self.each_factory(
            """
            for bad in ("pii:global", [1], {"a": 1}, 7):
                try:
                    make(pii=bad)
                except TypeError as error:
                    print("TypeError", "pii:global" in str(error))
            print(rs.pii_activation())
            """
        ):
            self.assertEqual(["TypeError False"] * 4, out[:4])
            self.assertIn("selectors=off", out[4])

    def test_failure_happens_at_construction_before_any_event(self) -> None:
        out = _probe(
            "logging",
            """
            rs.initialize(pii=[])
            try:
                RedactSecretFilter(pii=["pii:global"])
            except CoreActivationError:
                print("REFUSED")
            print("NOT_CONSTRUCTED")
            """,
        )
        self.assertEqual(["REFUSED", "NOT_CONSTRUCTED"], out)

    def test_omitting_pii_never_calls_initialize(self) -> None:
        for out in self.each_factory(
            """
            print(attempt(make))
            print(rs.pii_activation())
            rs.initialize(pii=["pii:global"])  # still possible: the filter did not lock "off"
            print(rs.pii_activation())
            """
        ):
            self.assertEqual("OK", out[0])
            self.assertIn("selectors=off", out[1])
            self.assertIn("selectors=pii:global", out[2])


class InjectedScannerTest(unittest.TestCase):
    def test_pii_with_an_injected_scanner_is_refused_without_touching_the_core(self) -> None:
        had_core = "redact_secret" in sys.modules
        with self.assertRaises(TypeError):
            RedactSecretFilter(fake_scan_and_redact, pii=["pii:global"])
        self.assertEqual(had_core, "redact_secret" in sys.modules)

    def test_injected_paths_do_not_import_the_real_core(self) -> None:
        out = _run(
            """
            import sys
            from redact_secret_adapters.logging_filter import RedactSecretFilter
            from redact_secret_adapters.otel import RedactingSpanProcessorWith

            class Sink:
                def on_end(self, span):
                    pass

            def fake(text, **kwargs):
                return text

            RedactSecretFilter(fake)
            RedactingSpanProcessorWith(Sink(), fake)
            print("redact_secret" in sys.modules)
            """
        )
        self.assertEqual("False", out)

    def test_activation_leaves_the_policy_alone(self) -> None:
        # Detection on/off is the core's; warn/allow/redact stays the caller's
        # `policy` (see PiiWarnGapTest). Nothing is synthesized here.
        redact = RedactSecretFilter(fake_scan_and_redact, policy="SENTINEL-policy")
        self.assertEqual("SENTINEL-policy", redact._policy)

    def test_the_span_processor_constructor_takes_no_pii(self) -> None:
        with self.assertRaises(TypeError):
            RedactingSpanProcessorWith(object(), fake_scan_and_redact, pii=["pii:global"])  # type: ignore[call-arg]


class FakeCore:
    """A core stand-in recording what the adapter asked of it."""

    class PiiActivationConflictError(Exception):
        pass

    class PiiSelectorInvalidError(Exception):
        pass

    def __init__(self, identity: str = "credentials=full;selectors=off;families=;vocabulary=v", raises=None) -> None:
        self.identity = identity
        self.raises = raises
        self.calls: list = []

    def initialize(self, pii=...):
        self.calls.append(pii)
        if self.raises is not None:
            raise self.raises

    def pii_activation(self):
        return self.identity


class ActivateCoreTest(unittest.TestCase):
    def test_reflects_parses_the_selectors_field_only(self) -> None:
        on = "credentials=full;selectors=pii:global,pii:us;families=a,b;vocabulary=v"
        self.assertTrue(activation_reflects(on, ["pii:global"]))
        self.assertTrue(activation_reflects(on, ["pii:us", "pii:global"]))
        self.assertFalse(activation_reflects(on, ["pii:eu"]))
        self.assertFalse(activation_reflects(on, []))
        self.assertTrue(activation_reflects("selectors=off", []))
        self.assertTrue(activation_reflects("selectors=", []))
        self.assertFalse(activation_reflects("selectors=off", ["pii:global"]))

    def test_an_unparseable_identity_reflects_nothing(self) -> None:
        for identity in (None, 3, "", "garbage", "families=a"):
            self.assertFalse(activation_reflects(identity, []))
            self.assertFalse(activation_reflects(identity, ["pii:global"]))

    def test_the_selection_is_deduplicated_and_passed_by_keyword(self) -> None:
        core = FakeCore("selectors=pii:global")
        activate_core(core, ["pii:global", "pii:global"])
        self.assertEqual([["pii:global"]], core.calls)

    def test_a_conflict_is_decided_by_the_active_identity(self) -> None:
        core = FakeCore("selectors=pii:global", raises=FakeCore.PiiActivationConflictError("SENTINEL"))
        activate_core(core, ["pii:global"])
        with self.assertRaises(CoreActivationError) as caught:
            activate_core(FakeCore("selectors=off", raises=FakeCore.PiiActivationConflictError("SENTINEL")), ["x"])
        self.assertEqual("PII_ACTIVATION_NOT_ACTIVE", caught.exception.code)
        self.assertNotIn("SENTINEL", str(caught.exception))

    def test_an_unrelated_initialization_failure_is_not_suppressed(self) -> None:
        with self.assertRaises(MemoryError):
            activate_core(FakeCore(raises=MemoryError()), ["pii:global"])
        with self.assertRaises(RuntimeError):
            activate_core(FakeCore(raises=RuntimeError("boom")), ["pii:global"])

    def test_a_selector_rejection_is_a_fixed_error_with_no_chain(self) -> None:
        with self.assertRaises(CoreActivationError) as caught:
            activate_core(FakeCore(raises=FakeCore.PiiSelectorInvalidError("SENTINEL")), ["pii:global"])
        self.assertEqual("PII_ACTIVATION_UNAVAILABLE", caught.exception.code)
        self.assertIsNone(caught.exception.__context__)
        self.assertNotIn("SENTINEL", str(caught.exception))

    def test_a_throwing_activation_report_is_not_active(self) -> None:
        core = FakeCore()

        def boom():
            raise RuntimeError("SENTINEL")

        core.pii_activation = boom  # type: ignore[method-assign]
        with self.assertRaises(CoreActivationError) as caught:
            activate_core(core, ["pii:global"])
        self.assertEqual("PII_ACTIVATION_NOT_ACTIVE", caught.exception.code)

    def test_a_core_without_the_api_is_unsupported(self) -> None:
        with self.assertRaises(CoreActivationError) as caught:
            activate_core(object(), ["pii:global"])
        self.assertEqual("PII_ACTIVATION_UNSUPPORTED", caught.exception.code)


if __name__ == "__main__":
    unittest.main()
