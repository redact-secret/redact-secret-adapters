"""Runs app.py and checks the text it wrote. Its messages never include the app's output."""

import pathlib
import subprocess
import sys

TOKEN = "ghp_SYNTHETICREVOKED00000000000000000000"
here = pathlib.Path(__file__).parent
expected = (here / "expected.txt").read_text()

run = subprocess.run([sys.executable, str(here / "app.py")], capture_output=True, text=True)
# logging.StreamHandler writes to stderr, so that is the destination being checked.
output = run.stderr

if run.returncode != 0:
    sys.exit(f"FAIL: app.py exited with status {run.returncode}")
if TOKEN in output or TOKEN in run.stdout:
    sys.exit("FAIL: the synthetic token reached the log output")
if output != expected:
    sys.exit("FAIL: the log output is not the expected redacted output")
sys.stdout.write(output)
print("OK: the synthetic token never reached the log output")
