#!/usr/bin/env python3
"""
Builds the real sdist and wheel for `python/`, `twine check`s both, then
installs the wheel -- not editable, not the source tree -- into a fresh
virtualenv OUTSIDE the checkout and runs a smoke test from there.

`pip install -e "./python[otel,test]"` (what the `python` CI job runs)
never builds a wheel, so a module missing from the built distribution, a
`py.typed` that doesn't get packaged, or a `packages` misconfiguration in
`pyproject.toml` passes through every one of those tests. This script
installs the built artifact the way a real installer would.

    python scripts/smoke-test-python-wheel.py
"""

from __future__ import annotations

import shutil
import subprocess
import sys
import tempfile
import venv
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
PYTHON_DIR = REPO_ROOT / "python"
DIST_DIR = PYTHON_DIR / "dist"

# A deterministic stand-in for `redact_secret.scan_and_redact`, kept in
# sync by hand with `python/tests/fake_scanner.py`: BOOM raises, BLOCK_ME
# gets a `block` finding, SECRET_TOKEN_\d+ gets a `redact` finding over
# that span, anything else is untouched. Not imported from the repo --
# this smoke test runs from a venv outside it.
SMOKE_TEST_PY = """
import logging
import re
from pathlib import Path
from types import SimpleNamespace

import redact_secret_adapters
from redact_secret_adapters.logging_filter import RedactSecretFilter

# py.typed must ship in the installed distribution, not just the source tree.
py_typed = Path(redact_secret_adapters.__file__).parent / "py.typed"
assert py_typed.is_file(), f"py.typed missing from installed distribution: {py_typed}"

_SECRET_TOKEN = re.compile(r"SECRET_TOKEN_\\d+")


def fake_scan_and_redact(text, policy=None):
    if "BOOM" in text:
        raise RuntimeError("simulated core failure")
    if "BLOCK_ME" in text:
        return SimpleNamespace(
            text=text.replace("BLOCK_ME", "<SECRET_1>"),
            findings=[SimpleNamespace(action="block")],
        )
    match = _SECRET_TOKEN.search(text)
    if match:
        redacted = text[: match.start()] + "<SECRET_1>" + text[match.end() :]
        return SimpleNamespace(text=redacted, findings=[SimpleNamespace(action="redact")])
    return SimpleNamespace(text=text, findings=[])


class ListHandler(logging.Handler):
    def __init__(self):
        super().__init__()
        self.records = []

    def emit(self, record):
        self.records.append(self.format(record))


logger = logging.getLogger("redact-secret-adapters-smoke-test")
logger.setLevel(logging.INFO)
handler = ListHandler()
logger.addHandler(handler)
logger.addFilter(RedactSecretFilter(fake_scan_and_redact))

logger.info("token is %s", "SECRET_TOKEN_1")

assert len(handler.records) == 1, handler.records
assert "<SECRET_1>" in handler.records[0], handler.records
assert "SECRET_TOKEN_1" not in handler.records[0], handler.records

print("redact_secret_adapters: ok (py.typed present, RedactSecretFilter redacts on a real Logger)")
"""


def run(args: list[str], cwd: Path | None = None) -> None:
    print(f"+ {' '.join(str(a) for a in args)}" + (f"  (in {cwd})" if cwd else ""))
    subprocess.run(args, cwd=cwd, check=True)


def main() -> None:
    if DIST_DIR.exists():
        shutil.rmtree(DIST_DIR)

    run([sys.executable, "-m", "build", str(PYTHON_DIR)])

    wheels = sorted(DIST_DIR.glob("*.whl"))
    sdists = sorted(DIST_DIR.glob("*.tar.gz"))
    if len(wheels) != 1:
        raise SystemExit(f"expected exactly one wheel in {DIST_DIR}, found {wheels}")
    if len(sdists) != 1:
        raise SystemExit(f"expected exactly one sdist in {DIST_DIR}, found {sdists}")

    run([sys.executable, "-m", "twine", "check", str(wheels[0]), str(sdists[0])])

    root = Path(tempfile.mkdtemp(prefix="redact-secret-wheel-"))
    venv_dir = root / "venv"
    print(f"throwaway venv: {venv_dir} (outside {REPO_ROOT})")

    ok = False
    try:
        venv.create(venv_dir, with_pip=True)
        venv_python = (
            venv_dir
            / ("Scripts" if sys.platform == "win32" else "bin")
            / ("python.exe" if sys.platform == "win32" else "python")
        )

        # Not editable, not the source tree: the built wheel, exactly as a
        # real installer would receive it.
        run([str(venv_python), "-m", "pip", "install", str(wheels[0])])

        smoke_test_path = root / "smoke_test.py"
        smoke_test_path.write_text(SMOKE_TEST_PY)
        run([str(venv_python), "smoke_test.py"], cwd=root)

        print("\nsmoke test passed: the built wheel installs clean and runs from outside the checkout.")
        ok = True
    finally:
        if ok:
            shutil.rmtree(root, ignore_errors=True)
        else:
            print(f"\nsmoke test failed — throwaway venv left at {root} for inspection", file=sys.stderr)


if __name__ == "__main__":
    main()
