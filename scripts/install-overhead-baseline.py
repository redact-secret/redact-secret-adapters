#!/usr/bin/env python3
"""Installs the previous release of ``redact-secret-adapters`` into a
directory, so ``scripts/measure-overhead.py --baseline <dir>`` can time it
against the current build in the same session (#97):

    python scripts/install-overhead-baseline.py <dir>
    python scripts/install-overhead-baseline.py <dir> 0.1.0

By default the baseline is the highest version on PyPI below the one in
``python/pyproject.toml``, so the script carries no version number of its
own. The package alone is installed (``--no-deps``): the harness injects its
own core and hosts into both builds.
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

try:
    from packaging.version import Version
except ImportError:  # pip always vendors it
    from pip._vendor.packaging.version import Version  # type: ignore[no-redef]

NAME = "redact-secret-adapters"


def main() -> None:
    if len(sys.argv) not in (2, 3) or sys.argv[1].startswith("-"):
        sys.exit("usage: install-overhead-baseline.py <dir> [version]")
    target = Path(sys.argv[1]).resolve()
    if len(sys.argv) == 3:
        chosen = sys.argv[2]
    else:
        pyproject = Path(__file__).resolve().parent.parent / "python" / "pyproject.toml"
        found = re.search(r'^version = "([^"]+)"', pyproject.read_text(encoding="utf-8"), re.MULTILINE)
        if found is None:
            sys.exit(f"no version in {pyproject}")
        current = Version(found.group(1))
        with urllib.request.urlopen(f"https://pypi.org/pypi/{NAME}/json", timeout=30) as response:
            releases = json.load(response)["releases"]
        below = sorted((Version(v) for v, files in releases.items() if files and Version(v) < current))
        if not below:
            print(f"{NAME}: nothing published below {current}; no baseline", file=sys.stderr)
            return
        chosen = str(below[-1])
        print(f"{NAME}: baseline {chosen} (workspace {current})", file=sys.stderr)
    subprocess.run(
        [
            sys.executable,
            "-m",
            "pip",
            "install",
            "--quiet",
            "--no-deps",
            "--only-binary",
            ":all:",
            "--target",
            str(target),
            f"{NAME}=={chosen}",
        ],
        check=True,
    )


if __name__ == "__main__":
    main()
