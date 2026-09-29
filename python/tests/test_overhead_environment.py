"""Machine identity in the Python overhead harness (#108). Mirrors
``scripts/test/bench-environment.test.mjs``: a container cannot see the host
CPU, so the wrapper passes it in and the harness prefers it, keeps the
container-visible value, and reports one arch string per machine. All values
are synthetic."""

from __future__ import annotations

import importlib.util
from pathlib import Path

_SCRIPT = Path(__file__).resolve().parents[2] / "scripts" / "overhead_environment.py"
_spec = importlib.util.spec_from_file_location("overhead_environment", _SCRIPT)
environment = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(environment)

HOST = "Synthetic Host CPU 9000"
KEY = environment.HOST_CPU_ENV


def test_arch_is_one_string_per_machine() -> None:
    assert environment.normalize_arch("aarch64") == "arm64"
    assert environment.normalize_arch("arm64") == "arm64"
    assert environment.normalize_arch("x86_64") == "x64"
    assert environment.normalize_arch("AMD64") == "x64"
    assert environment.normalize_arch("riscv64") == "riscv64"


def test_placeholder_and_empty_cpu_models_are_not_a_model() -> None:
    for value in ("unknown", "Unknown", "unknown-cpu", "", "   ", None):
        assert environment.clean_cpu_model(value) is None
    assert environment.clean_cpu_model("  Synthetic CPU  ") == "Synthetic CPU"


def test_the_host_model_from_the_wrapper_wins_and_the_container_value_is_kept() -> None:
    assert environment.resolve_cpu_model({KEY: HOST}, "Synthetic Container CPU") == {
        "cpuModel": HOST,
        "cpuModelContainer": "Synthetic Container CPU",
        "cpuModelSource": "host-env",
    }


def test_without_the_wrapper_the_visible_model_is_used() -> None:
    assert environment.resolve_cpu_model({}, "Synthetic Visible CPU") == {
        "cpuModel": "Synthetic Visible CPU",
        "cpuModelContainer": "Synthetic Visible CPU",
        "cpuModelSource": "container",
    }


def test_no_model_at_all_is_reported_as_unavailable() -> None:
    assert environment.resolve_cpu_model({KEY: "unknown"}, None) == {
        "cpuModel": None,
        "cpuModelContainer": None,
        "cpuModelSource": "unavailable",
    }


def test_a_container_that_sees_no_cpu_still_carries_the_hosts_and_a_normalized_arch() -> None:
    assert environment.cpu_environment({KEY: HOST}, visible=None, arch="aarch64") == {
        "arch": "arm64",
        "archRaw": "aarch64",
        "cpuModel": HOST,
        "cpuModelContainer": None,
        "cpuModelSource": "host-env",
    }
