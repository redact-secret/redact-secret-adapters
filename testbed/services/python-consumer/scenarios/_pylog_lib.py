"""Shared fixtures for the Python logging scenarios (#194). Not a scenario module (the leading
underscore keeps it out of discovery). Everything here is synthetic.

The verifier looks only at the text a handler wrote, never at how the pipeline was built or at
on_outcome (the same rule as examples/placement-python/verify.py).
"""

import importlib
import inspect
import io
import json
import logging
import re
import subprocess
import sys
from pathlib import Path

TOKEN = "ghp_SYNTHETICREVOKED" + "0" * 20
EMAIL = "jane.doe@acme-corp.io"
WARN_VALUE = "hunter2hunter2"
SAMPLE = f"token {TOKEN}; customer email: {EMAIL}; password={WARN_VALUE}"
_BODY = "MIIBOgIBAAJBAKSYNTHETICREVOKEDNOTAREALKEY".ljust(76, "A")
PEM = "\n".join(["-----BEGIN RSA PRIVATE KEY-----", _BODY, _BODY, _BODY, "-----END RSA PRIVATE KEY-----"])
SECRETS = (TOKEN, EMAIL, WARN_VALUE, "SYNTHETICREVOKEDNOTAREALKEY")

BLOCK_MARKER = "[REDACTED:BLOCKED]"
ERROR_MARKER = "[REDACTED:ERROR]"
LIMIT_MARKER = "[REDACTED:LIMIT_EXCEEDED]"
_PLACEHOLDER = re.compile(r"<SECRET_\d+>|\[REDACTED:[A-Z_]+\]")
PROFILE = Path(__file__).resolve().parent / "_pylog_profile.py"
FORMAT = "%(levelname)s %(name)s %(message)s"


class Sink(io.StringIO):
    """A destination that keeps the exact text a handler writes, bounded in size."""

    def __init__(self, max_bytes=64 * 1024):
        super().__init__()
        self.max_bytes = max_bytes
        self.dropped = 0

    def write(self, s):
        if self.tell() + len(s) > self.max_bytes:
            self.dropped += 1
            return 0
        return super().write(s)


def verdict(captured, secrets=SECRETS):
    """LEAKED: a fixture secret is in the output. UNVERIFIED: nothing captured or no sanitized
    marker, so nothing was proven. PROTECTED: output exists, no secret, a marker is present."""
    if any(s in captured for s in secrets):
        return "LEAKED"
    if not captured or not _PLACEHOLDER.search(captured):
        return "UNVERIFIED"
    return "PROTECTED"


def keep(ctx, label, text):
    """Stores the final handler text in the bounded capture sink, with fixture secrets masked."""
    for s in SECRETS:
        text = text.replace(s, "[SENTINEL]")
    ctx["captures"].add(label, text)


class JsonFormatter(logging.Formatter):
    """A structured handler format that writes message, exception text and one extra field."""

    def format(self, record):
        out = {"level": record.levelname, "msg": record.getMessage()}
        if record.exc_text or record.exc_info:
            out["exc"] = self.formatException(record.exc_info) if record.exc_info else record.exc_text
        if hasattr(record, "ctx"):
            out["ctx"] = record.ctx
        return json.dumps(out, default=str)


_counter = [0]


def make_logger(*handlers, propagate=False, name=None):
    _counter[0] += 1
    logger = logging.getLogger(name or f"testbed.pylog.{_counter[0]}")
    logger.handlers[:] = list(handlers)
    logger.setLevel(logging.DEBUG)
    logger.propagate = propagate
    return logger


def make_handler(flt=None, formatter=None, sink=None):
    sink = sink if sink is not None else Sink()
    handler = logging.StreamHandler(sink)
    handler.setFormatter(formatter or logging.Formatter(FORMAT))
    if flt is not None:
        handler.addFilter(flt)
    return handler, sink


def filter_cls():
    return importlib.import_module("redact_secret_adapters.logging_filter").RedactSecretFilter


def features():
    """Which installed behaviors exist, probed from the installed package and never from a version
    string. Candidate mode has the unreleased budget (#173) and explicit PII activation (#176)."""
    try:
        importlib.import_module("redact_secret_adapters.budget")
        budget = "operation_limits" in inspect.signature(filter_cls().__init__).parameters
    except Exception:  # noqa: BLE001
        budget = False
    pii = "pii" in inspect.signature(filter_cls().__init__).parameters
    return {"budget": budget, "pii": pii}


def require_feature(ctx, rec, name, present, reason):
    """Candidate mode REQUIRES the feature (a missing one is a failed check); a published pin
    records an explicit 'unsupported'. Returns True when the scenario may go on."""
    rec.evidence["mode"] = ctx["install"]["mode"]
    rec.evidence[name] = present
    if present:
        return True
    if ctx["install"]["mode"] == "candidate":
        rec.check(f"candidate supports {name}", False, "feature missing from the candidate build")
    else:
        rec.unsupported(reason)
    return False


def run_profile(name):
    """Runs one PII configuration in its own process (activation is process-wide and one-shot)."""
    child = subprocess.run(
        [sys.executable, str(PROFILE), name],
        capture_output=True,
        text=True,
        timeout=20,
        env={"PATH": "/opt/venv/bin:/usr/local/bin:/usr/bin", "PYTHONDONTWRITEBYTECODE": "1"},
    )
    if child.returncode != 0:
        return None
    try:
        return json.loads(child.stdout)
    except ValueError:
        return None
