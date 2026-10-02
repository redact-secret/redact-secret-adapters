"""One PII configuration of Python logging, run in its own process by the pylog.pii-* scenarios
(#194). Activation is process-wide and one-shot. Sources: examples/policy-python/main.py (#181).
Prints one JSON object with the final handler text and the counts."""

import io
import json
import logging
import sys

import redact_secret
from redact_secret_adapters.logging_filter import RedactSecretFilter

TOKEN = "ghp_SYNTHETICREVOKED" + "0" * 20
EMAIL = "jane.doe@acme-corp.io"
WARN_VALUE = "hunter2hunter2"
SAMPLE = f"token {TOKEN}; customer email: {EMAIL}; password={WARN_VALUE}"


def explicit_policy(finding, context):
    # Replaces the core's built-in policy for EVERY finding (examples/policy-python).
    return "block" if finding.type == "private_key" else "redact"


def emit(flt):
    buffer = io.StringIO()
    handler = logging.StreamHandler(buffer)
    handler.addFilter(flt)
    logger = logging.getLogger("pii-profile")
    logger.addHandler(handler)
    logger.setLevel(logging.INFO)
    logger.propagate = False
    logger.info(SAMPLE)
    return buffer.getvalue().rstrip("\n")


def counts_of(outcomes):
    v = outcomes[0].values
    return {"findings": v.findings, "redacted": v.redacted, "blocked": v.blocked, "failed": v.failed}


def main(name):
    outcomes = []
    if name == "default":
        flt = RedactSecretFilter(on_outcome=outcomes.append)
    elif name == "pii":  # application-first: the application enables PII before any record
        redact_secret.initialize(pii=["pii:global"])
        flt = RedactSecretFilter(on_outcome=outcomes.append)
    elif name == "policy":
        redact_secret.initialize(pii=["pii:global"])
        flt = RedactSecretFilter(policy=explicit_policy, on_outcome=outcomes.append)
    elif name == "adapter-first":  # pii= on the filter initializes and verifies the core
        flt = RedactSecretFilter(pii=["pii:global"], on_outcome=outcomes.append)
    elif name == "conflict":
        RedactSecretFilter(pii=["pii:global"])
        result = {"rejected": False, "code": None, "leaks_selector": False}
        try:
            RedactSecretFilter(pii=[])
        except Exception as exc:  # noqa: BLE001
            result = {
                "rejected": True,
                "type": type(exc).__name__,
                "code": getattr(exc, "code", None),
                "leaks_selector": "pii:global" in str(exc),
            }
        sys.stdout.write(json.dumps(result))
        return
    else:
        sys.exit(2)
    sys.stdout.write(json.dumps({"line": emit(flt), "counts": counts_of(outcomes)}))


main(sys.argv[1])
