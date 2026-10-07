# Python `logging` quickstart

Keeps a synthetic token out of a Python `logging` handler. No account or key is involved.

- Runtime: Python 3.10 or later.
- Installs: `redact-secret-adapters` 0.1.6 and `redact-secret` 0.1.0b14 (a beta, pinned exactly).
- Files: `app.py` is the whole quickstart. `check.py` runs it and checks the text it wrote.

## Run it

Copy this folder out of the repository first (see [how](../README.md#run-one)), then:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python check.py
```

## The code

<!-- snippet: examples/python-logging/app.py -->
```python
import logging

from redact_secret_adapters.logging_filter import RedactSecretFilter

# Synthetic, revoked-shaped value only. Never put a real credential in an example.
token = "ghp_SYNTHETICREVOKED00000000000000000000"

handler = logging.StreamHandler()
handler.addFilter(RedactSecretFilter())  # on the handler, not the logger
logging.getLogger().addHandler(handler)

logging.warning("deploy with token %s", token)
```

Add the filter to **every handler that writes somewhere**. A handler without it
writes plaintext. [`placement-python`](../placement-python) shows how to prove that
for your own handlers.

## Expected output

<!-- expected-output -->
```text
deploy with token <SECRET_1>
OK: the synthetic token never reached the log output
```

`logging.StreamHandler` writes to stderr, and `check.py` reads that stream. The
first line is what the handler wrote. The last line is the success indicator. On
failure it prints `FAIL: ...` with no log content and exits non-zero.

## Next

- Check **your own** handlers: [`placement-python`](../placement-python).
- Something unexpected such as `[REDACTED:ERROR]`: [troubleshooting](../../docs/troubleshooting.md).
- All options: [Python guide](../../python#readme).
