"""The adapter-overhead workloads (#11) are built, not committed. This pins
the Python builder to the digest recorded in
``fixtures/overhead-profiles.json``, which
``packages/adapter/test/overhead-workloads.test.ts`` pins the JavaScript
builder to as well, so both harnesses measure one input."""

from __future__ import annotations

import importlib.util
import json
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "overhead_workloads.py"
_spec = importlib.util.spec_from_file_location("overhead_workloads", _SCRIPT)
workloads = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(workloads)


def test_the_python_workload_builder_reproduces_the_pinned_digest() -> None:
    document = workloads.load_profiles()
    assert workloads.workload_digest(document) == document["workloadDigest"]


def test_the_synthetic_token_is_planted_only_where_declared() -> None:
    document = workloads.load_profiles()
    secret = workloads.synthetic_secret(document)
    for profile in document["profiles"]:
        events = workloads.build_events(document, profile)
        assert len(events) == document["distinctEvents"]
        for index, event in enumerate(events):
            planted = secret in json.dumps(event)
            assert planted == (index % profile["params"]["secretEvery"] == 0), (profile["id"], index)
