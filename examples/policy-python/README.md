# Credentials, PII and policy: one input, three configurations (Python)

PII detection is a separate switch from masking. This example runs the **same** synthetic input
under three configurations through Python `logging` and shows what each one does, using the
filter's supported `on_outcome` counters. Nothing here reads finding details the API does not expose.

- Runtime: Python 3.10 or later.
- Installs: `redact-secret-adapters` 0.1.6 and `redact-secret` 0.1.0b14 (a beta, pinned exactly).
- Needs no network service and no credentials.

## Run it

Copy this folder out of the repository first (see [how](../README.md#run-one)), then:

```sh
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python main.py
```

## The three configurations

PII activation is process-wide and one-shot, so each configuration runs in its **own process**
(`main.py` starts one child process per configuration). Do not try to switch between them
inside one initialized process.

<!-- snippet: examples/policy-python/main.py#configurations -->
```python
def explicit_policy(finding, context):
    # An explicit core policy. It replaces the built-in one for EVERY finding, so keep "block" for
    # the type the built-in policy blocks. This is an example choice, not a recommendation.
    return "block" if finding.type == "private_key" else "redact"


CONFIGURATIONS = {
    "default": {"pii": None, "policy": None},  # credentials only: PII stays off
    "pii": {"pii": ["pii:global"], "policy": None},  # PII activated, the core's default policy
    "policy": {"pii": ["pii:global"], "policy": explicit_policy},  # PII activated, your policy
}
```

Each process activates PII **before** the first record, then logs the sample:

<!-- snippet: examples/policy-python/main.py#logging -->
```python
if config["pii"] is not None:
    redact_secret.initialize(pii=config["pii"])  # before the first record is emitted

outcomes = []
buffer = io.StringIO()
handler = logging.StreamHandler(buffer)
handler.addFilter(RedactSecretFilter(policy=config["policy"], on_outcome=outcomes.append))
logger = logging.getLogger("policy-example")
logger.addHandler(handler)
logger.setLevel(logging.INFO)

logger.info(SAMPLE)
# outcomes[0].values: scanned, findings, redacted, blocked, limited, failed. No values, no details.
```

`redact_secret.initialize(pii=...)` is the activation path this example uses. `RedactSecretFilter(pii=[...])`
(released in `redact-secret-adapters` 0.1.4) does the same and verifies the activation, but is not used here.
Where you put the `initialize` line is the whole rule: see the [PII guide](../../docs/pii.md#python).

## Expected output

<!-- expected-output -->
```text
== default ==
logging  findings=2 redacted=1 blocked=0 failed=0
         token <SECRET_1>; customer email: jane.doe@acme-corp.io; password=hunter2hunter2
== pii ==
logging  findings=3 redacted=1 blocked=0 failed=0
         token <SECRET_1>; customer email: <SECRET_2>; password=hunter2hunter2
== policy ==
logging  findings=3 redacted=1 blocked=0 failed=0
         token <SECRET_1>; customer email: <SECRET_2>; password=<SECRET_3>
OK: the three configurations differ as documented
```

The `OK:` line means every difference was asserted. A `FAIL:` line names the configuration that did
not behave as documented and exits non-zero.

## Reading it

| Configuration | Credential | Email (PII, high confidence) | `password=` (a `warn`) |
| --- | --- | --- | --- |
| `default` | redacted | untouched: PII is off | untouched: a `warn` finding |
| `pii` | redacted | redacted (`findings` rises by one) | untouched: still `warn` |
| `policy` | redacted | redacted | redacted: your policy turned `warn` into `redact` |

The logging counters do not carry a finding's action, so the `warn` shows only as a `findings`
count above what `redacted` explains. The [JavaScript comparison](../policy-js) shows each finding's
action through `adapter-ai-context`. The warn/redact/block meanings, what a masked example does and
does not establish, and why counts are not distinct-secret counts, are explained there too.

`redacted` counts values (here one log message), not findings, and `findings` is not a count of
distinct secrets. Neither is a detection guarantee.

## Next

[PII guide](../../docs/pii.md) · [Python counters](../../python#counting-what-happened)
