"""PII activation in the Python adapters: the placement rule, and the window
it leaves open (redact-secret/redact-secret-adapters#51).

Credential detection needs no init step -- the native extension loads on
``import redact_secret``. **PII detection does.** It is opt-in, process-wide
and one-shot: ``redact_secret.initialize(pii=[...])`` records a selection, the
first selection wins, and a later *different* one raises
``PiiActivationConflictError``. An empty selection is a different selection,
not a neutral one.

Nothing in these adapters can call it for you. A ``logging.Filter`` is attached
at import time and a ``TracerProvider`` is usually built there too, so a module
imported earlier can emit records *before* the line that enables PII has run.
Those records are scanned with PII off and report nothing, with no error --
a **silent window**, which is a known limitation of the placement rule and not
something the adapters hide or work around.

Each activation test runs in its own interpreter, because the selection cell is
one-shot per process: two orderings cannot share one. The PII sample is a
published IBAN check-digit example, not anyone's account.
"""

from __future__ import annotations

import subprocess
import sys
import textwrap
import unittest

from fake_scanner import fake_scan_and_redact

from redact_secret_adapters.mask_leaf import count_leaf, mask_leaf_outcome_with
from redact_secret_adapters.outcome import OutcomeCounter

# A documentation IBAN: valid check digits, no real account behind it.
_PII_SAMPLE = "IBAN: DE89370400440532013000"


def _run(body: str) -> str:
    """Runs `body` in a fresh interpreter and returns its stdout.

    Skips the whole case when the core is absent, the way `test_live.py`
    does -- these adapters are testable without the built extension.
    """
    completed = subprocess.run(
        [sys.executable, "-c", textwrap.dedent(body)],
        capture_output=True,
        text=True,
        check=False,
    )
    if completed.returncode != 0:
        raise AssertionError(f"probe failed:\n{completed.stderr}")
    return completed.stdout.strip()


def _core_available() -> bool:
    try:
        import redact_secret  # noqa: F401
    except ImportError:
        return False
    return True


def _pii_api_available() -> bool:
    """Whether the installed core exposes the opt-in PII activation API.

    PII arrived in `redact-secret` 0.1.0b10, and this package's declared
    range still starts at 0.1.0b6 -- deliberately, since an adapter that
    passes no selectors needs nothing newer. CI installs both ends of that
    range, so at the lowest end `initialize` and `pii_activation` simply do
    not exist and every case below has no behaviour to pin. Skipping is the
    honest outcome: the floor is supported, not merely tolerated.
    """
    if not _core_available():
        return False
    import redact_secret

    return all(hasattr(redact_secret, name) for name in ("initialize", "pii_activation"))


@unittest.skipUnless(_pii_api_available(), "the installed redact_secret has no PII activation API")
class PiiActivationPlacementTest(unittest.TestCase):
    """The documented rule: enable PII before the first scan."""

    def test_activation_is_process_wide_one_shot_and_a_later_different_selection_conflicts(self) -> None:
        out = _run(
            """
            import redact_secret as rs
            print(rs.pii_activation())
            rs.initialize(pii=["pii:global"])
            print(rs.pii_activation())
            try:
                rs.initialize(pii=[])
                print("NO_CONFLICT")
            except Exception as error:
                print(type(error).__name__)
            """
        )
        off, on, second = out.splitlines()
        # The identity the core reports; `off` is a selection too, not a neutral state.
        self.assertIn("selectors=off", off)
        self.assertIn("selectors=pii:global", on)
        self.assertEqual("PiiActivationConflictError", second)

    def test_the_documented_order_reports_pii_through_the_logging_filter(self) -> None:
        out = _run(
            f"""
            import logging
            import redact_secret as rs

            rs.initialize(pii=["pii:global"])   # first, before any logging

            from redact_secret_adapters.logging_filter import RedactSecretFilter

            record = logging.makeLogRecord({{"msg": {_PII_SAMPLE!r}}})
            RedactSecretFilter().filter(record)
            print(record.getMessage())
            """
        )
        self.assertNotIn("DE89370400440532013000", out)
        self.assertIn("<SECRET_1>", out)

    def test_KNOWN_LIMITATION_records_before_initialize_are_scanned_with_pii_off(self) -> None:
        """The silent window, pinned rather than hidden.

        A record masked before ``initialize(pii=...)`` passes through with
        its PII intact and reports **no** findings. There is no exception, no
        warning, and no counter that distinguishes it from a record that
        genuinely held nothing -- which is exactly why the placement rule is
        documented as a rule. Nothing here is a defect to fix in these
        adapters: the process, not the filter, owns the activation.
        """
        out = _run(
            f"""
            import logging
            import redact_secret as rs
            from redact_secret_adapters.logging_filter import RedactSecretFilter

            # The wrong order: a handler is already filtering when PII is enabled.
            redact = RedactSecretFilter()
            early = logging.makeLogRecord({{"msg": {_PII_SAMPLE!r}}})
            redact.filter(early)
            print("EARLY", early.getMessage())

            rs.initialize(pii=["pii:global"])

            late = logging.makeLogRecord({{"msg": {_PII_SAMPLE!r}}})
            redact.filter(late)
            print("LATE", late.getMessage())
            """
        )
        early, late = out.splitlines()
        # The limitation, stated as an assertion: plaintext PII on the wire.
        self.assertEqual(f"EARLY {_PII_SAMPLE}", early)
        # And the same filter instance, same value, after activation.
        self.assertNotIn("DE89370400440532013000", late)
        self.assertIn("<SECRET_1>", late)


class PiiWarnGapTest(unittest.TestCase):
    """Activation is not masking.

    Under the core's default policy PII types are confidence-gated rather
    than always redacted: ``High`` redacts, ``Medium`` and ``Low`` resolve to
    ``warn``. A ``warn`` finding leaves the text alone, so a consumer who
    turns PII on still emits lower-confidence PII as plaintext. That is the
    core's decision about policy, not this repository's, and these adapters
    do not compensate for it -- but they do make it **observable**, because
    the counters keep ``findings`` and ``redacted`` apart.

    Mirrors ``packages/adapter/test/pii-warn-gap.test.ts``. The scanner is
    the deterministic fake; ``WARN_ME`` is a magic fixture string.
    """

    def test_a_warn_finding_passes_its_text_through_unchanged(self) -> None:
        leaf = mask_leaf_outcome_with(fake_scan_and_redact, "contact WARN_ME at the desk")
        self.assertEqual("contact WARN_ME at the desk", leaf.text)
        self.assertEqual("unchanged", leaf.outcome)
        self.assertEqual(1, leaf.findings)

    def test_the_counters_make_the_gap_visible(self) -> None:
        counter = OutcomeCounter()
        count_leaf(counter, mask_leaf_outcome_with(fake_scan_and_redact, "contact WARN_ME at the desk"))
        self.assertEqual(1, counter.scanned)
        self.assertEqual(1, counter.findings)
        # The signal an operator alerts on: findings with nothing redacted.
        self.assertEqual(0, counter.redacted)

    def test_a_redacting_leaf_is_the_contrast(self) -> None:
        counter = OutcomeCounter()
        leaf = mask_leaf_outcome_with(fake_scan_and_redact, "token SECRET_TOKEN_1")
        count_leaf(counter, leaf)
        self.assertEqual("redacted", leaf.outcome)
        self.assertEqual(1, counter.findings)
        self.assertEqual(1, counter.redacted)


if __name__ == "__main__":
    unittest.main()
