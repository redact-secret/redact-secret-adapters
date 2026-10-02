"""The verifier. It looks only at captured output, never at how the pipeline was built, and it
never prints captured output: only a label, a verdict and a placeholder count."""

import re
import sys

# Synthetic, revoked-shaped value only. Never use a real credential with this verifier.
TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000"
_PLACEHOLDER = re.compile(r"<SECRET_\d+>")


# snippet:start verdict
def verdict(captured: str) -> str:
    """LEAKED: the synthetic credential is in the captured output.
    UNVERIFIED: nothing was captured, or no sanitized placeholder is in it, so nothing was proven.
    PROTECTED: output exists, the credential is absent, and a sanitized placeholder is present.
    """
    if TOKEN in captured:
        return "LEAKED"
    if not captured or not _PLACEHOLDER.search(captured):
        return "UNVERIFIED"
    return "PROTECTED"


# snippet:end verdict


def run(recipes) -> None:
    """Runs every recipe and exits non-zero when a protected path leaks or a control is not detected."""
    failed = False
    for label, control, capture in recipes:
        captured = capture()
        actual = verdict(captured)
        expected = "LEAKED" if control else "PROTECTED"
        ok = actual == expected
        failed = failed or not ok
        kind = "control  " if control else "protected"
        placeholders = len(_PLACEHOLDER.findall(captured))
        print(f"{'ok  ' if ok else 'FAIL'} {kind} {actual:<10} {label} ({placeholders} placeholders)")
    if failed:
        sys.exit("FAIL: a protected path was not proven protected, or a negative control was not detected")
    print("OK: every protected path passed and every negative control was detected (tested paths only)")
