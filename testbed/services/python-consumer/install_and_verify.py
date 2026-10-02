"""Build-time installer for the Python consumer image (#193). Mirror of
node-consumer/install-and-verify.mjs.

Creates /opt/venv, installs the pinned core and (candidate) the wheel built
from this checkout, or (published) the pinned adapter version, then refuses to
continue unless the result is what the mode promises:

  candidate  the adapter distribution's direct_url.json points at the wheel file
             and that file's sha256 equals the manifest's; the wheel's own file
             list holds no control or fixture code.
  published  the adapter distribution has no direct_url.json (it came from an
             index) and its version is the requested pin.

TESTBED_FAULT (self-test only): missing-peer (omit the core, so `pip check`
fails), wrong-mode (install from the index although candidate was selected),
broken-exports (delete the adapter's logging_filter module after the checks).
"""

import hashlib
import json
import os
import subprocess
import sys
import zipfile
from pathlib import Path

ARTIFACTS = Path(os.environ.get("TESTBED_ARTIFACTS", "/artifacts"))
VENV = Path(os.environ.get("TESTBED_VENV", "/opt/venv"))
fault = os.environ.get("TESTBED_FAULT", "")
CODE_MARKERS = ("__control", "testbed")  # in code files
PATH_MARKERS = ("__control", "testbed", "fixtures")  # in file paths
manifest = json.loads((ARTIFACTS / "manifest.json").read_text())
plan = manifest["python"]
mode = manifest["mode"]


def die(message):
    print(f"INSTALL VERIFICATION FAILED: {message}", file=sys.stderr)
    sys.exit(1)


def sha256(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


if mode not in ("candidate", "published"):
    die(f"unknown mode '{mode}'")

subprocess.run([sys.executable, "-m", "venv", str(VENV)], check=True)
pip = [str(VENV / "bin" / "python"), "-m", "pip", "--disable-pip-version-check", "install", "--no-cache-dir"]

specs = []
wheel = None
if mode == "candidate" and fault != "wrong-mode":
    if not plan.get("file"):
        die("candidate wheel is missing from the manifest")
    wheel = ARTIFACTS / "python" / plan["file"]
    if not wheel.is_file():
        die(f"candidate wheel {plan['file']} is missing")
    if sha256(wheel) != plan["sha256"]:
        die(f"candidate wheel {plan['file']} does not match its recorded sha256")
    with zipfile.ZipFile(wheel) as z:
        for name in z.namelist():
            body = z.read(name).decode("utf-8", "replace") if name.endswith((".py", ".pyi")) else ""
            if any(m in name for m in PATH_MARKERS) or any(m in body for m in CODE_MARKERS):
                die(f"wheel member {name} carries control or fixture code")
    specs.append(str(wheel))
else:
    specs.append(f"{plan['name']}=={plan['version']}")
if fault != "missing-peer":
    specs += [f"{n}=={v}" for n, v in plan["core"].items()]
specs += [f"{n}=={v}" for n, v in plan["hosts"].items()]

# --no-deps: every dependency is an explicit exact pin above, so pip cannot pick a prerelease core by itself.
print("+ pip install --no-deps", " ".join(Path(s).name if s.startswith("/") else s for s in specs))
subprocess.run([*pip, "--no-deps", *specs], check=True)
if subprocess.run([str(VENV / "bin" / "python"), "-m", "pip", "check"]).returncode != 0:
    die("pip check reports a missing or incompatible dependency")

probe = r"""
import json, importlib.metadata as m, sys
out = {}
for name in sys.argv[1:]:
    d = m.distribution(name)
    du = d.read_text("direct_url.json")
    out[name] = {"version": d.version, "direct_url": json.loads(du) if du else None}
print(json.dumps(out))
"""
names = [plan["name"], *plan["core"], *plan["hosts"]]
dists = json.loads(
    subprocess.run([str(VENV / "bin" / "python"), "-c", probe, *names], check=True, capture_output=True, text=True).stdout
)
adapter = dists[plan["name"]]
if mode == "candidate":
    url = (adapter["direct_url"] or {}).get("url", "")
    if not url.startswith("file://") or not url.endswith(plan["file"]):
        die("adapter did not install from the candidate wheel (wrong installation mode)")
    if adapter["version"] != plan["version"]:
        die(f"adapter installed {adapter['version']}, built {plan['version']}")
else:
    if adapter["direct_url"] is not None:
        die("published mode installed from a local path")
    if adapter["version"] != plan["version"]:
        die(f"adapter resolved to {adapter['version']}, requested {plan['version']}")
for name, version in {**plan["core"], **plan["hosts"]}.items():
    if dists[name]["version"] != version:
        die(f"{name} is {dists[name]['version']}, expected {version}")

if fault == "broken-exports":
    for f in VENV.glob("lib/python*/site-packages/redact_secret_adapters/logging_filter.py"):
        f.unlink()

Path("/opt/consumer").mkdir(exist_ok=True)
Path("/opt/consumer/install-manifest.json").write_text(
    json.dumps(
        {
            "schema": "redact-secret-adapters/testbed-install-v1",
            "host": "python",
            "mode": mode,
            "evidence": mode,
            "python": sys.version.split()[0],
            "adapters": [{"name": plan["name"], "version": adapter["version"], "wheelSha256": plan.get("sha256")}],
            "core": {n: dists[n]["version"] for n in plan["core"]},
            "hosts": {n: dists[n]["version"] for n in plan["hosts"]},
            "fault": fault or None,
        },
        indent=2,
    )
)
print("install verified")
