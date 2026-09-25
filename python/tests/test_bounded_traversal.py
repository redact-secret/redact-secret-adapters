"""Bounded traversal of pathological value trees (#11), from the shared
``fixtures/bounded-traversal-cases.json`` that
``packages/adapter/test/bounded-traversal.test.ts`` also reads. Each case
builds its shape from parameters, walks it, and checks that the walk
terminates, never passes the planted synthetic secret through, and calls the
scanner no more often than the case's bound.
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path
from typing import Any

from fake_scanner import RecordingScanner

from redact_secret_adapters.mask_secrets import mask_secrets_with

FIXTURES_PATH = Path(__file__).resolve().parents[2] / "fixtures" / "bounded-traversal-cases.json"
CASES = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))["cases"]


def _snake(name: str) -> str:
    return re.sub(r"(?<!^)(?=[A-Z])", "_", name).lower()


def build_shape(shape: dict[str, Any]) -> Any:
    """Builds a case's shape iteratively, so building never recurses as deep as the shape."""
    kind, leaf = shape["kind"], shape["leaf"]
    if kind in ("nested-arrays", "nested-objects", "nested-objects-with-leaves"):
        value: Any = leaf
        for _ in range(shape["depth"]):
            if kind == "nested-arrays":
                value = [value]
            elif kind == "nested-objects":
                value = {"child": value}
            else:
                value = {"leaf": leaf, "child": value}
        return value
    if kind == "wide-array":
        return [leaf] * shape["width"]
    if kind == "wide-object":
        return {f"k{index}": leaf for index in range(shape["width"])}
    if kind == "cube":
        side = shape["side"]
        return [[[leaf] * side for _ in range(side)] for _ in range(side)]
    if kind == "long-string":
        return "x" * shape["length"] + " " + leaf
    raise ValueError(f"unknown shape kind: {kind}")


class BoundedTraversalTest(unittest.TestCase):
    def test_shared_cases(self) -> None:
        for case in CASES:
            with self.subTest(name=case["name"]):
                scanner = RecordingScanner()
                limits = {_snake(key): value for key, value in case["limits"].items()}
                result = mask_secrets_with(scanner, build_shape(case["shape"]), limits=limits or None)
                serialized = json.dumps(result)
                self.assertLessEqual(len(scanner.calls), case["maxScannerCalls"])
                self.assertNotIn(case["shape"]["leaf"], serialized)
                self.assertIn(case["mustContain"], serialized)


if __name__ == "__main__":
    unittest.main()
