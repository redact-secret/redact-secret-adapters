"""Machine identity for the adapter-overhead harnesses (#108).

Python mirror of ``scripts/bench-environment.mjs``: keep the two in step.
A container cannot see the host CPU, so ``scripts/bench-docker.mjs`` passes the
host's model in as ``REDACT_SECRET_BENCH_HOST_CPU``; the harness prefers it and
records the container-visible value beside it.
"""

from __future__ import annotations

import os
import platform
import re
import subprocess
import sys
from typing import Any, Mapping, Optional

HOST_CPU_ENV = "REDACT_SECRET_BENCH_HOST_CPU"

_ARCH_ALIASES = {"aarch64": "arm64", "arm64": "arm64", "x86_64": "x64", "amd64": "x64", "x64": "x64"}
_PLACEHOLDER = re.compile(r"^unknown(-cpu)?$", re.IGNORECASE)


def normalize_arch(arch: str) -> str:
    """One arch string per machine, whichever runtime reports it."""
    return _ARCH_ALIASES.get(arch.lower(), arch)


def clean_cpu_model(value: Optional[str]) -> Optional[str]:
    """A CPU model string, or None when it is empty or a placeholder such as "unknown"."""
    if not isinstance(value, str):
        return None
    trimmed = value.strip()
    return None if trimmed == "" or _PLACEHOLDER.match(trimmed) else trimmed


def visible_cpu_model() -> Optional[str]:
    """The CPU model this process can see."""
    try:
        if sys.platform == "darwin":
            return clean_cpu_model(subprocess.check_output(["sysctl", "-n", "machdep.cpu.brand_string"], text=True))
        with open("/proc/cpuinfo", encoding="utf-8") as cpuinfo:
            for line in cpuinfo:
                if line.startswith("model name"):
                    return clean_cpu_model(line.split(":", 1)[1])
    except (OSError, subprocess.CalledProcessError):
        pass
    return clean_cpu_model(platform.processor())


def resolve_cpu_model(env: Mapping[str, str], visible: Optional[str]) -> dict[str, Any]:
    """The model to key a profile on: the host's when the wrapper passed it, else what is visible."""
    host = clean_cpu_model(env.get(HOST_CPU_ENV))
    return {
        "cpuModel": host if host is not None else visible,
        "cpuModelContainer": visible,
        "cpuModelSource": "host-env" if host is not None else ("container" if visible is not None else "unavailable"),
    }


_DETECT: Any = object()


def cpu_environment(
    env: Optional[Mapping[str, str]] = None, visible: Any = _DETECT, arch: Optional[str] = None
) -> dict[str, Any]:
    """The ``environment`` fields for CPU and arch. ``visible`` defaults to detecting it."""
    raw = platform.machine() if arch is None else arch
    seen = visible_cpu_model() if visible is _DETECT else visible
    return {"arch": normalize_arch(raw), "archRaw": raw, **resolve_cpu_model(os.environ if env is None else env, seen)}
