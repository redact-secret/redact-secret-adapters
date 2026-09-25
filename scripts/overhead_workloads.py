"""Builds the adapter-overhead workloads in ``fixtures/overhead-profiles.json``
(#11), event for event identical to ``scripts/overhead-workloads.mjs``.
Both are pinned to one digest by ``python/tests/test_overhead_workloads.py``
and ``packages/adapter/test/overhead-workloads.test.ts``, so a JavaScript and
a Python number for the same profile describe the same input.

Every string is filler from the profile file or one synthetic token built
here at runtime. Nothing is read from the environment.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any, Optional

PROFILES_PATH = Path(__file__).resolve().parent.parent / "fixtures" / "overhead-profiles.json"


def load_profiles() -> dict[str, Any]:
    return json.loads(PROFILES_PATH.read_text(encoding="utf-8"))


def synthetic_secret(document: dict[str, Any]) -> str:
    secret = document["secret"]
    return secret["prefix"] + secret["fill"] * secret["length"]


def _words(document: dict[str, Any], count: int, seed: int) -> str:
    filler = document["filler"]
    return " ".join(filler[(seed + k * 7) % len(filler)] for k in range(count)) + f" #{seed}"


def _nested(document: dict[str, Any], depth: int, seed: int, words: int) -> dict[str, Any]:
    value: dict[str, Any] = {"leaf": _words(document, words, seed)}
    for level in range(1, depth):
        value = {"level": _words(document, words, seed + level), "inner": value}
    return value


def _log_event(document: dict[str, Any], params: dict[str, Any], index: int, secret: Optional[str]) -> dict[str, Any]:
    message = _words(document, params["stringWords"], index) + " %s" * params["messageArgs"]
    args = [f"v{index}-{a}" for a in range(params["messageArgs"])]
    fields: dict[str, Any] = {
        f"f{f}": _words(document, params["stringWords"], index + f) for f in range(params["fields"])
    }
    if params["nestedDepth"] > 0:
        fields["f0"] = _nested(document, params["nestedDepth"], index, params["stringWords"])
    if params["arrayLength"] > 0:
        fields["f1"] = [_words(document, params["stringWords"], index + a) for a in range(params["arrayLength"])]
    if secret is not None:
        fields["f2"] = f"token={secret}"
    return {"message": message, "args": args, "fields": fields}


def _span_event(document: dict[str, Any], params: dict[str, Any], index: int, secret: Optional[str]) -> dict[str, Any]:
    words = params["stringWords"]
    attributes: dict[str, Any] = {f"a{a}": _words(document, words, index + a) for a in range(params["attributes"])}
    for a in range(params["arrayAttributes"]):
        attributes[f"arr{a}"] = [_words(document, words, index + a + k) for k in range(params["arrayLength"])]
    if secret is not None:
        attributes["a2"] = f"token={secret}"
    events = [
        {
            "name": f"event {e} #{index}",
            "attributes": {f"e{a}": _words(document, words, index + e + a) for a in range(params["eventAttributes"])},
        }
        for e in range(params["events"])
    ]
    return {"name": f"op #{index}", "attributes": attributes, "events": events}


def _payload_event(
    document: dict[str, Any], params: dict[str, Any], index: int, secret: Optional[str]
) -> dict[str, Any]:
    words = params["stringWords"]
    messages = [
        {"role": "user" if m % 2 == 0 else "assistant", "content": _words(document, words, index + m)}
        for m in range(params["messages"])
    ]
    if secret is not None:
        messages[1]["content"] = f"{messages[1]['content']} token={secret}"
    tool_calls = [
        {
            "name": f"tool_{t}",
            "arguments": {"query": _words(document, words, index + t)},
            "result": _words(document, words, index + t + 1),
        }
        for t in range(params["toolCalls"])
    ]
    return {"messages": messages, "toolCalls": tool_calls}


_BUILDERS = {"log-event": _log_event, "span": _span_event, "payload": _payload_event}


def build_events(document: dict[str, Any], profile: dict[str, Any]) -> list[dict[str, Any]]:
    build = _BUILDERS.get(profile["shape"])
    if build is None:
        raise ValueError(f"unknown workload shape: {profile['shape']}")
    secret = synthetic_secret(document)
    every = profile["params"]["secretEvery"]
    return [
        build(document, profile["params"], index, secret if index % every == 0 else None)
        for index in range(document["distinctEvents"])
    ]


def workload_digest(document: dict[str, Any]) -> str:
    """Canonical JSON (sorted keys) of every profile's events, hashed; identical in JavaScript."""
    everything = {profile["id"]: build_events(document, profile) for profile in document["profiles"]}
    canonical = json.dumps(everything, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
