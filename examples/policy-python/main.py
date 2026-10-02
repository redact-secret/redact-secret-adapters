import io
import json
import logging
import subprocess
import sys

import redact_secret
from redact_secret_adapters.logging_filter import RedactSecretFilter

# Bundled synthetic sample: a credential, a PII value the core redacts at high confidence, and a
# credential-shaped value the core's default policy only warns about. None of them is real.
TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000"
EMAIL = "jane.doe@acme-corp.io"
WARN_VALUE = "hunter2hunter2"
SAMPLE = f"token {TOKEN}; customer email: {EMAIL}; password={WARN_VALUE}"


# snippet:start configurations
def explicit_policy(finding, context):
    # An explicit core policy. It replaces the built-in one for EVERY finding, so keep "block" for
    # the type the built-in policy blocks. This is an example choice, not a recommendation.
    return "block" if finding.type == "private_key" else "redact"


CONFIGURATIONS = {
    "default": {"pii": None, "policy": None},  # credentials only: PII stays off
    "pii": {"pii": ["pii:global"], "policy": None},  # PII activated, the core's default policy
    "policy": {"pii": ["pii:global"], "policy": explicit_policy},  # PII activated, your policy
}
# snippet:end configurations


def run_profile(name: str) -> None:
    """Runs inside a child process: activation is process-wide and one-shot, so each profile gets its own."""
    config = CONFIGURATIONS[name]

    # snippet:start logging
    if config["pii"] is not None:
        redact_secret.initialize(pii=config["pii"])  # before the first record is emitted

    outcomes = []
    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.addFilter(RedactSecretFilter(policy=config["policy"], on_outcome=outcomes.append))
    logger = logging.getLogger("policy-example")
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)

    logger.info(SAMPLE)
    # outcomes[0].values: scanned, findings, redacted, blocked, limited, failed. No values, no details.
    # snippet:end logging

    values = outcomes[0].values
    counts = {
        "findings": values.findings,
        "redacted": values.redacted,
        "blocked": values.blocked,
        "failed": values.failed,
    }
    sys.stdout.write(json.dumps({"line": buffer.getvalue().rstrip("\n"), "counts": counts}))


def fail(message: str) -> None:
    sys.exit(f"FAIL: {message}")


def main() -> None:
    results = {}
    for name in CONFIGURATIONS:
        child = subprocess.run([sys.executable, __file__, name], capture_output=True, text=True)
        if child.returncode != 0:
            fail(f"the {name} process did not finish")
        results[name] = json.loads(child.stdout)
        r = results[name]
        counts = r["counts"]
        print(f"== {name} ==")
        print(
            f"logging  findings={counts['findings']} redacted={counts['redacted']} "
            f"blocked={counts['blocked']} failed={counts['failed']}"
        )
        print(f"         {r['line']}")

    for name, r in results.items():
        if TOKEN in r["line"]:
            fail(f"{name}: the credential was not redacted")
        if r["counts"]["failed"] or r["counts"]["blocked"]:
            fail(f"{name}: an unexpected failure or block")
    # Default: credentials only. The email is untouched and the password is a reported warn.
    line = results["default"]["line"]
    if EMAIL not in line or WARN_VALUE not in line:
        fail("default: expected PII and the warn value to remain")
    # PII on: the email is redacted at high confidence, the warn value is still plaintext.
    line = results["pii"]["line"]
    if EMAIL in line or WARN_VALUE not in line:
        fail("pii: expected the email redacted and the warn value unchanged")
    if results["pii"]["counts"]["findings"] <= results["default"]["counts"]["findings"]:
        fail("pii: expected one more finding than the default")
    # Explicit policy: everything is masked.
    line = results["policy"]["line"]
    if EMAIL in line or WARN_VALUE in line:
        fail("policy: a value was left unmasked")
    print("OK: the three configurations differ as documented")


if __name__ == "__main__":
    if len(sys.argv) > 1:
        run_profile(sys.argv[1])
    else:
        main()
