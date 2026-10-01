"""Tests for mask_secrets_with. They need nothing beyond the standard
library and pytest -- not even the built redact_secret extension: a fake
scanner stands in for the core.
"""

from __future__ import annotations

import json
import re
import time
import unittest
from collections import OrderedDict, defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

from fake_scanner import RecordingScanner, fake_scan_and_redact

import redact_secret_adapters
from redact_secret_adapters._walk import walk
from redact_secret_adapters.mask_leaf import (
    BLOCK_MARKER,
    CYCLE_MARKER,
    DEFAULT_LIMITS,
    ERROR_MARKER,
    LIMIT_MARKER,
    resolve_limit,
)
from redact_secret_adapters.mask_log_value import mask_log_value_with
from redact_secret_adapters.mask_secrets import mask_secrets_with
from redact_secret_adapters.outcome import OutcomeCounter

FIXTURES_PATH = Path(__file__).resolve().parents[2] / "fixtures" / "mask-secrets-cases.json"


class SharedFixtureTest(unittest.TestCase):
    """The same fixture file `mask-secrets.test.mjs` reads, proving JS and
    Python agree on nested objects, arrays, chat-message arrays, tool-call
    arguments/results, and Unicode."""

    def test_shared_cases(self) -> None:
        cases = json.loads(FIXTURES_PATH.read_text(encoding="utf-8"))["cases"]
        for case in cases:
            with self.subTest(name=case["name"]):
                result = mask_secrets_with(fake_scan_and_redact, case["input"])
                self.assertEqual(result, case["expected"])


class MaskSecretsWithTest(unittest.TestCase):
    def test_large_string_within_limit_is_scanned_in_full(self) -> None:
        data = {"blob": "x" * 3000 + " SECRET_TOKEN_9 " + "y" * 3000}
        expected = {"blob": "x" * 3000 + " <SECRET_1> " + "y" * 3000}
        self.assertEqual(mask_secrets_with(fake_scan_and_redact, data), expected)

    def test_block_finding_replaces_the_whole_leaf(self) -> None:
        result = mask_secrets_with(fake_scan_and_redact, {"key": "prefix BLOCK_ME suffix"})
        self.assertEqual(result["key"], BLOCK_MARKER)
        serialized = json.dumps(result)
        self.assertNotIn("prefix", serialized)
        self.assertNotIn("suffix", serialized)

    def test_core_failure_fails_closed(self) -> None:
        result = mask_secrets_with(fake_scan_and_redact, {"key": "trigger BOOM here"})
        self.assertEqual(result["key"], ERROR_MARKER)
        self.assertNotIn("BOOM", json.dumps(result))

    def test_numbers_booleans_and_none_are_unchanged(self) -> None:
        data = {"count": 1, "ratio": 0.5, "active": False, "missing": None}
        self.assertEqual(mask_secrets_with(fake_scan_and_redact, data), data)

    def test_any_other_object_fails_closed_to_the_error_marker(self) -> None:
        # #85: an object the walker cannot see into is never passed through
        # for a `%(ctx)s` format or a `default=str` JSON formatter to print.
        @dataclass
        class Context:
            token: str

        class Leaky:
            def __str__(self) -> str:
                return "SECRET_TOKEN_7"

        values = {
            "when": datetime(2026, 1, 1, tzinfo=timezone.utc),
            "set": {"SECRET_TOKEN_7"},
            "frozenset": frozenset({"SECRET_TOKEN_7"}),
            "bytes": b"SECRET_TOKEN_7",
            "dataclass": Context("SECRET_TOKEN_7"),
            "instance": Leaky(),
        }
        for mask in (mask_secrets_with, mask_log_value_with):
            with self.subTest(mask=mask.__name__):
                counter = OutcomeCounter()
                result = walk(fake_scan_and_redact, values, policy=None, limits=None, counter=counter)
                self.assertEqual(result, {key: ERROR_MARKER for key in values})
                self.assertEqual(counter.failed, len(values))
                self.assertEqual(mask(fake_scan_and_redact, values), result)
                self.assertEqual(mask(fake_scan_and_redact, Leaky()), ERROR_MARKER)
                self.assertNotIn("SECRET_TOKEN_7", json.dumps(result, default=str))

    def test_a_container_whose_read_raises_degrades_per_entry_and_never_raises(self) -> None:
        class BadItem(dict):
            def __getitem__(self, key):
                if key == "bad":
                    raise RuntimeError("unreadable SECRET_TOKEN_7")
                return super().__getitem__(key)

        class BadKeys(dict):
            def keys(self):
                raise RuntimeError("unreadable SECRET_TOKEN_7")

        class BadSlice(list):
            def __getitem__(self, index):
                raise RuntimeError("unreadable SECRET_TOKEN_7")

        data = {
            "entries": BadItem(ok="SECRET_TOKEN_1", bad="SECRET_TOKEN_2"),
            "keys": BadKeys(k="SECRET_TOKEN_3"),
            "slice": BadSlice(["SECRET_TOKEN_4"]),
        }
        for mask in (mask_secrets_with, mask_log_value_with):
            with self.subTest(mask=mask.__name__):
                self.assertEqual(
                    mask(fake_scan_and_redact, data),
                    {
                        "entries": {"ok": "<SECRET_1>", "bad": ERROR_MARKER},
                        "keys": ERROR_MARKER,
                        "slice": ERROR_MARKER,
                    },
                )

    def test_an_invalid_limit_falls_back_to_the_default_instead_of_disabling_it(self) -> None:
        deep: object = "SECRET_TOKEN_1"
        for _ in range(DEFAULT_LIMITS["max_depth"] + 2):
            deep = {"child": deep}
        for bad in (None, float("nan"), -1, "5", True, [8]):
            with self.subTest(limit=repr(bad)):
                limits = {key: bad for key in DEFAULT_LIMITS}
                result = json.dumps(mask_secrets_with(fake_scan_and_redact, deep, limits=limits))
                self.assertIn(LIMIT_MARKER, result)
                self.assertNotIn("SECRET_TOKEN_1", result)
                self.assertEqual(mask_secrets_with(fake_scan_and_redact, ["a"] * 1001, limits=limits), ["a"] * 1000)
                scanner = RecordingScanner()
                mask_secrets_with(scanner, ["x"] * 1000 + [{"k": "x"}] * 1000, limits=limits)
                self.assertEqual(len(scanner.calls), 1000)
        # A NaN leaf budget would otherwise never trip.
        scanner = RecordingScanner()
        mask_secrets_with(scanner, [["x"] * 1000] * 6, limits={"max_total_leaves": float("nan")})
        self.assertEqual(len(scanner.calls), DEFAULT_LIMITS["max_total_leaves"])
        # Valid bounds are kept: 0 is a bound, and a fraction truncates like the TS slice.
        self.assertEqual(mask_secrets_with(fake_scan_and_redact, ["a", "b"], limits={"max_array_length": 1.5}), ["a"])
        self.assertEqual(mask_secrets_with(fake_scan_and_redact, "a", limits={"max_string_length": 0}), LIMIT_MARKER)
        self.assertEqual(
            mask_secrets_with(fake_scan_and_redact, ["a"], limits={"max_array_length": float("inf")}), ["a"]
        )
        self.assertEqual(mask_secrets_with(fake_scan_and_redact, {"a": 1}, limits={"max_depth": 0}), LIMIT_MARKER)
        # Not a mapping at all: no overrides.
        self.assertEqual(mask_secrets_with(fake_scan_and_redact, ["SECRET_TOKEN_1"], limits=[1]), ["<SECRET_1>"])

    def test_resolve_limit_mirrors_the_ts_resolve_limit(self) -> None:
        for good in (0, 3, 2.5, float("inf")):
            self.assertEqual(resolve_limit(good, 7), good)
        for bad in (None, float("nan"), -1, -0.5, "5", True, False, [1]):
            self.assertEqual(resolve_limit(bad, 7), 7, repr(bad))

    def test_tuples_and_dict_list_subclasses_are_walked(self) -> None:
        class TagList(list):
            pass

        data = {
            "tuple": ("ok", "SECRET_TOKEN_1 a"),
            "ordered": OrderedDict([("k", "SECRET_TOKEN_2 b")]),
            "default": defaultdict(list, {"k": ["SECRET_TOKEN_3 c"]}),
            "tags": TagList(["SECRET_TOKEN_4 d"]),
        }
        for mask in (mask_secrets_with, mask_log_value_with):
            with self.subTest(mask=mask.__name__):
                result = mask(fake_scan_and_redact, data)
                self.assertEqual(
                    result,
                    {
                        "tuple": ("ok", "<SECRET_1> a"),
                        "ordered": {"k": "<SECRET_1> b"},
                        "default": {"k": ["<SECRET_1> c"]},
                        "tags": ["<SECRET_1> d"],
                    },
                )
                # Subclasses come back as the plain container.
                self.assertIs(type(result["tuple"]), tuple)
                self.assertIs(type(result["ordered"]), dict)
                self.assertIs(type(result["tags"]), list)

    def test_exceptions_are_walked_by_the_masking_callback_too(self) -> None:
        result = mask_secrets_with(fake_scan_and_redact, {"error": ValueError("SECRET_TOKEN_1 leaked")})
        self.assertEqual(result["error"]["type"], "ValueError")
        self.assertEqual(result["error"]["message"], "<SECRET_1> leaked")
        self.assertNotIn("SECRET_TOKEN_1", json.dumps(result))

    def test_tuple_limits_and_cycles_match_lists(self) -> None:
        self.assertEqual(
            mask_secrets_with(fake_scan_and_redact, ("a", "b", "c"), limits={"max_array_length": 2}), ("a", "b")
        )
        self.assertEqual(
            mask_secrets_with(fake_scan_and_redact, {"t": ("SECRET_TOKEN_1",)}, limits={"max_depth": 1}),
            {"t": LIMIT_MARKER},
        )
        inner: list = []
        outer = (inner,)
        inner.append(outer)
        self.assertEqual(mask_secrets_with(fake_scan_and_redact, outer), ([CYCLE_MARKER],))

    def test_depth_beyond_limit_is_marked_rather_than_walked(self) -> None:
        data = {"a": {"b": {"c": "SECRET_TOKEN_1"}}}
        result = mask_secrets_with(fake_scan_and_redact, data, limits={"max_depth": 1})
        self.assertEqual(result["a"], LIMIT_MARKER)

    def test_array_and_dict_entries_beyond_limit_are_dropped(self) -> None:
        array_result = mask_secrets_with(fake_scan_and_redact, ["a", "b", "c"], limits={"max_array_length": 2})
        self.assertEqual(array_result, ["a", "b"])

        dict_result = mask_secrets_with(
            fake_scan_and_redact, {"a": "1", "b": "2", "c": "3"}, limits={"max_object_keys": 2}
        )
        self.assertEqual(list(dict_result.keys()), ["a", "b"])

    def test_total_leaf_budget_bounds_the_whole_call(self) -> None:
        data = {"a": "SECRET_TOKEN_1", "b": "SECRET_TOKEN_2", "c": "SECRET_TOKEN_3"}
        result = mask_secrets_with(fake_scan_and_redact, data, limits={"max_total_leaves": 2})
        self.assertEqual(result["a"], "<SECRET_1>")
        self.assertEqual(result["b"], "<SECRET_1>")
        self.assertEqual(result["c"], LIMIT_MARKER)

    def test_max_nodes_counts_every_visit_once_per_path(self) -> None:
        # #87. root, a, a[0], a[1], b: five visits.
        data = {"a": [1, 2], "b": "SECRET_TOKEN_7"}

        def masked(max_nodes: int):
            return mask_secrets_with(fake_scan_and_redact, data, limits={"max_nodes": max_nodes})

        self.assertEqual(masked(5), {"a": [1, 2], "b": "<SECRET_1>"})
        self.assertEqual(masked(4), {"a": [1, 2], "b": LIMIT_MARKER})
        self.assertEqual(masked(2), {"a": [LIMIT_MARKER, LIMIT_MARKER], "b": LIMIT_MARKER})
        self.assertEqual(masked(0), LIMIT_MARKER)
        # A shared reference counts on every path it is reached by.
        shared = [1, 2, 3]
        self.assertEqual(
            mask_secrets_with(fake_scan_and_redact, [shared, shared], limits={"max_nodes": 6}),
            [[1, 2, 3], [LIMIT_MARKER, LIMIT_MARKER, LIMIT_MARKER]],
        )

    def test_a_shared_reference_dag_is_bounded_by_max_nodes_not_its_path_count(self) -> None:
        # #87. 8 levels of 1000 references to the next: 1000^8 paths, 8001 lists.
        node: object = 1
        for _ in range(8):
            node = [node] * 1000
        counter = OutcomeCounter()
        start = time.perf_counter()
        result = walk(fake_scan_and_redact, node, policy=None, limits=None, counter=counter)
        self.assertLess(time.perf_counter() - start, 5.0)
        self.assertIn(LIMIT_MARKER, json.dumps(result))
        self.assertGreater(counter.limited, 0)

    def test_cycle_is_marked_rather_than_recursed_into_forever(self) -> None:
        data: dict = {"name": "root"}
        data["self"] = data
        result = mask_secrets_with(fake_scan_and_redact, data)
        self.assertEqual(result["name"], "root")
        self.assertEqual(result["self"], CYCLE_MARKER)

    def test_string_too_long_is_marked_not_scanned(self) -> None:
        data = {"blob": "a" * 50}
        result = mask_secrets_with(fake_scan_and_redact, data, limits={"max_string_length": 10})
        self.assertEqual(result["blob"], LIMIT_MARKER)

    def test_policy_reaches_the_scanner(self) -> None:
        policy = object()
        for mask in (mask_secrets_with, mask_log_value_with):
            with self.subTest(mask=mask.__name__):
                scanner = RecordingScanner()
                mask(scanner, {"a": "x", "b": ["y", ("z",)]}, policy=policy)
                # A value directly under a mapping key is also scanned in its key
                # context; a sequence element is not (#172).
                self.assertEqual([text for text, _ in scanner.calls], ["x", '{"a":"x"}', "y", "z"])
                self.assertTrue(all(called_policy is policy for _, called_policy in scanner.calls))

    def test_rejects_non_callable_scan_and_redact(self) -> None:
        with self.assertRaises(TypeError):
            mask_secrets_with(None, {})


class PackageVersionTest(unittest.TestCase):
    def test_version_comes_from_pyproject(self) -> None:
        pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
        declared = re.search(r'^version = "([^"]+)"$', pyproject, re.MULTILINE).group(1)
        self.assertEqual(redact_secret_adapters.__version__, declared)


if __name__ == "__main__":
    unittest.main()
