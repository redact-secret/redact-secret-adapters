"""The scenario/result envelope and fixed scenario-ID registry, Python side (#192).

Twin of envelope.mjs; keep them in step (testbed/test checks both against
result.schema.json). A scenario module under scenarios/ exposes SCENARIOS: a
list of dicts {id, title, classification, run(ctx, rec)}.
"""

from __future__ import annotations

import importlib.util
import json
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path

RESULT_SCHEMA = "redact-secret-adapters/testbed-result-v1"
SCENARIO_ID = re.compile(r"^(smoke|pino|pylog|aictx|browser|ui)\.[a-z0-9]+(-[a-z0-9]+)*$")
CLASSIFICATIONS = ("install-check", "qualification", "negative-control", "failure-injection")
LIMITS = {
    "assertions": 50,
    "name": 120,
    "detail": 240,
    "message": 240,
    "title": 200,
    "evidence_bytes": 8192,
    "comparisons": 12,
    "comparison_value": 100,
}
COMPARISON_KINDS = ("masking", "warn", "block", "limit", "init-failure", "cancellation", "stream", "policy", "other")


def load_sentinels(contract_dir: Path):
    out = []
    for f in sorted((contract_dir / "sentinels.d").glob("*.json")):
        out += [re.compile(p) for p in json.loads(f.read_text())["patterns"]]
    return out


def make_scrubber(sentinels):
    def scrub(value, maximum):
        text = str(value)
        for rx in sentinels:
            text = rx.sub("[SENTINEL]", text)
        return text if len(text) <= maximum else text[: maximum - 1] + "…"

    return scrub


class Recorder:
    def __init__(self, scrub):
        self.scrub = scrub
        self.assertions = []
        self.evidence = {}
        self.status = None
        self.overflow = False
        self.comparisons = []

    def check(self, name, ok, detail=None):
        if len(self.assertions) < LIMITS["assertions"]:
            entry = {"name": self.scrub(name, LIMITS["name"]), "ok": ok is True}
            if detail is not None and ok is not True:
                entry["detail"] = self.scrub(detail, LIMITS["detail"])
            self.assertions.append(entry)
        else:
            self.overflow = True
        return ok is True

    def compare(self, label, expected, actual, kind="other"):
        """Expected-versus-actual pair for the scenario UI (#196) plus an equality assertion.

        Values must be display-safe primitives (a sanitized output, a placeholder, or a fixed label),
        never a raw input or warn/negative-control plaintext. The self-test fault `wrong-expectation`
        replaces every expected value, so the run must fail.
        """
        want = "[wrong expectation injected]" if os.environ.get("TESTBED_FAULT") == "wrong-expectation" else expected

        def show(v):
            if v is None or isinstance(v, (bool, int, float)):
                return v
            if isinstance(v, str):
                return self.scrub(v, LIMITS["comparison_value"])
            return "[non-primitive]"

        match = type(want) is type(actual) and want == actual
        self.check(label, match, "expected and actual differ")
        if len(self.comparisons) >= LIMITS["comparisons"]:
            self.overflow = True
            return match
        self.comparisons.append(
            {
                "label": self.scrub(label, LIMITS["name"]),
                "kind": kind if kind in COMPARISON_KINDS else "other",
                "expected": show(want),
                "actual": show(actual),
                "match": match,
            }
        )
        return match

    def unsupported(self, reason):
        self.status = "unsupported"
        self.check("supported", False, reason)


def run_scenario(definition, host, ctx, scrub):
    started = time.time()
    rec = Recorder(scrub)
    error = None
    try:
        definition["run"](ctx, rec)
    except Exception as exc:  # noqa: BLE001 - any failure becomes status "error"
        error = {"code": scrub(type(exc).__name__, 80), "message": "scenario threw; message withheld"}
    if error or rec.overflow:
        status = "error"
    elif rec.status:
        status = rec.status
    else:
        status = "pass" if rec.assertions and all(a["ok"] for a in rec.assertions) else "fail"

    raw_evidence = {**rec.evidence, "comparisons": rec.comparisons} if rec.comparisons else rec.evidence
    encoded = scrub(json.dumps(raw_evidence), 10**9)
    evidence = {}
    if len(encoded.encode()) > LIMITS["evidence_bytes"]:
        status = "error"
        error = {"code": "evidence-too-large", "message": f"evidence exceeded {LIMITS['evidence_bytes']} bytes"}
    else:
        evidence = json.loads(encoded)
    result = {
        "schema": RESULT_SCHEMA,
        "scenarioId": definition["id"],
        "host": host,
        "classification": definition["classification"],
        "title": scrub(definition["title"], LIMITS["title"]),
        "status": status,
        "startedAt": datetime.fromtimestamp(started, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z",
        "durationMs": int((time.time() - started) * 1000),
        "assertions": rec.assertions,
        "evidence": evidence,
    }
    if error:
        result["error"] = error
    return result


def discover_scenarios(directory: Path, host: str, contract_dir: Path):
    namespaces = json.loads((contract_dir / "namespaces.json").read_text())["namespaces"]
    fixed = set()
    for f in (contract_dir / "ids").glob("*.json"):
        for s in json.loads(f.read_text())["scenarios"]:
            fixed.add((s["host"], s["id"]))
    found = {}
    for path in sorted(directory.glob("*.py")):
        if path.name.startswith("_"):
            continue
        spec = importlib.util.spec_from_file_location(f"scenario_{path.stem}", path)
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        for d in getattr(mod, "SCENARIOS", None) or []:
            where = f"{path.name}:{d.get('id')}"
            sid = d.get("id")
            if not isinstance(sid, str) or not SCENARIO_ID.match(sid):
                raise ValueError(f"{where}: invalid scenario id")
            if host not in namespaces.get(sid.split(".")[0], {}).get("hosts", []):
                raise ValueError(f"{where}: namespace not allowed on host '{host}'")
            if d.get("classification") not in CLASSIFICATIONS:
                raise ValueError(f"{where}: invalid classification")
            if not callable(d.get("run")) or not isinstance(d.get("title"), str):
                raise ValueError(f"{where}: needs title and run()")
            if (host, sid) not in fixed:
                raise ValueError(f"{where}: not listed in contract/ids")
            if sid in found:
                raise ValueError(f"{where}: duplicate scenario id")
            found[sid] = d
    for h, sid in fixed:
        if h == host and sid not in found:
            raise ValueError(f"{sid}: listed in contract/ids but no module defines it")
    return found
