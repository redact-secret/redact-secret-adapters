#!/usr/bin/env python3
"""
Installs one end of every declared compatibility range, so CI can run
pytest against it:

    python scripts/install-range-endpoint.py lowest
    python scripts/install-range-endpoint.py highest

The ranges are read from `python/pyproject.toml` -- the `redact-secret`
dependency and the `opentelemetry-sdk` range in the `otel` extra -- and
resolved against PyPI, so this script never carries a version number of
its own. Nothing is saved to a manifest or a lockfile.
"""

from __future__ import annotations

import json
import subprocess
import sys
import urllib.request
from pathlib import Path

import tomllib
from packaging.requirements import Requirement
from packaging.version import InvalidVersion, Version

END = sys.argv[1] if len(sys.argv) > 1 else None
if END not in ("lowest", "highest"):
    print("usage: install-range-endpoint.py <lowest|highest>", file=sys.stderr)
    sys.exit(2)

PYPROJECT = Path(__file__).resolve().parent.parent / "python" / "pyproject.toml"


def resolve(requirement: Requirement) -> str:
    with urllib.request.urlopen(f"https://pypi.org/pypi/{requirement.name}/json", timeout=30) as response:
        data = json.load(response)

    versions = []
    for raw, releases in data["releases"].items():
        if not releases or all(release.get("yanked") for release in releases):
            continue
        try:
            version = Version(raw)
        except InvalidVersion:
            continue
        if requirement.specifier.contains(version, prereleases=True):
            versions.append(version)
    if not versions:
        raise RuntimeError(f"no published version of {requirement.name} satisfies {requirement.specifier}")
    versions.sort()
    return str(versions[0] if END == "lowest" else versions[-1])


def main() -> None:
    manifest = tomllib.loads(PYPROJECT.read_text())
    project = manifest["project"]
    requirements = [Requirement(spec) for spec in project.get("dependencies", [])]
    requirements += [Requirement(spec) for spec in project.get("optional-dependencies", {}).get("otel", [])]

    specs = [f"{requirement.name}=={resolve(requirement)}" for requirement in requirements if requirement.specifier]
    if not specs:
        return
    print(f"redact-secret-adapters: {END} -> {' '.join(specs)}")
    subprocess.check_call([sys.executable, "-m", "pip", "install", *specs])


if __name__ == "__main__":
    main()
