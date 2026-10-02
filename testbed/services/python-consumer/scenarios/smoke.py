"""Smoke scenarios for the Python consumer (#192/#193); see scenarios/smoke.mjs.

#194 adds Python logging scenarios in its own module under this directory.
"""

import importlib
import json
import os
import sys
from pathlib import Path

SYNTHETIC_TOKEN = "ghp_SYNTHETICREVOKED" + "0" * 20
CODE_MARKERS = ("__control", "testbed")
PATH_MARKERS = ("__control", "testbed", "fixtures")
PUBLIC_IMPORTS = {
    "redact_secret_adapters": "mask_secrets_with",
    "redact_secret_adapters.logging_filter": "RedactSecretFilter",
}


def _package_dir():
    import redact_secret_adapters

    return Path(redact_secret_adapters.__file__).resolve().parent


def public_imports(ctx, rec):
    for module, symbol in PUBLIC_IMPORTS.items():
        try:
            mod = importlib.import_module(module)
        except Exception as exc:  # noqa: BLE001
            rec.check(f"import {module}", False, f"import failed: {type(exc).__name__}")
            continue
        rec.check(f"import {module}", True)
        rec.check(f"{module} exports {symbol}", hasattr(mod, symbol))
    rec.evidence["adapters"] = [{"name": a["name"], "version": a["version"]} for a in ctx["install"]["adapters"]]


def install_isolation(ctx, rec):
    pkg = _package_dir()
    site = Path(sys.prefix).resolve()
    rec.check("running inside the consumer venv", sys.prefix != sys.base_prefix)
    rec.check("adapter resolves inside the venv", site in pkg.parents, "path outside the venv")
    rec.check("PYTHONPATH is unset", "PYTHONPATH" not in os.environ)
    allowed = ("/app", "/opt/venv", "/usr/local/lib")
    rec.check("sys.path holds only the app, the venv and the stdlib", all(p.startswith(allowed) for p in sys.path if p))
    markers = set()
    for f in pkg.rglob("*"):
        if f.is_file():
            rel = str(f.relative_to(pkg))
            body = f.read_bytes().decode("utf-8", "replace") if f.suffix in (".py", ".pyi") else ""
            markers.update(m for m in PATH_MARKERS if m in rel)
            markers.update(m for m in CODE_MARKERS if m in body)
    rec.check("adapter contains no control or fixture code", not markers, ",".join(sorted(markers)))
    rec.evidence["installRoot"] = str(site)


def core_active(ctx, rec):
    import redact_secret

    native = [p.name for p in Path(redact_secret.__file__).parent.glob("_native*") if p.suffix in (".so", ".pyd", ".dylib")]
    rec.evidence["core"] = ctx["install"]["core"]
    rec.evidence["artifact"] = {"version": redact_secret.VERSION, "native": native}
    rec.check("core exposes a native artifact", len(native) == 1)
    out = redact_secret.scan_and_redact(f"deploy {SYNTHETIC_TOKEN}")
    text = out.text
    rec.check("the synthetic token does not survive", SYNTHETIC_TOKEN not in text)
    rec.check("something was redacted", "<SECRET_" in text, "no redaction marker")


SCENARIOS = [
    {
        "id": "smoke.python-public-imports",
        "title": "Installed adapter loads through its public modules",
        "classification": "install-check",
        "run": public_imports,
    },
    {
        "id": "smoke.python-install-isolation",
        "title": "Adapter resolves from the clean venv, not the checkout, and ships no control or fixture code",
        "classification": "install-check",
        "run": install_isolation,
    },
    {
        "id": "smoke.python-core-active",
        "title": "The real core is loaded and masks a synthetic token; the native artifact is reported",
        "classification": "install-check",
        "run": core_active,
    },
]
