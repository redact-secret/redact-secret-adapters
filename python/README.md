# redact-secret-adapters

[![PyPI version](https://img.shields.io/pypi/v/redact-secret-adapters)](https://pypi.org/project/redact-secret-adapters/)
[![PyPI downloads](https://img.shields.io/pypi/dm/redact-secret-adapters)](https://pypi.org/project/redact-secret-adapters/)
[![Python](https://img.shields.io/badge/python-%E2%89%A53.10-blue)](https://pypi.org/project/redact-secret-adapters/)
[![typed](https://img.shields.io/pypi/types/redact-secret-adapters)](https://pypi.org/project/redact-secret-adapters/)
[![CI](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/redact-secret/redact-secret-adapters/badge)](https://scorecard.dev/viewer/?uri=github.com/redact-secret/redact-secret-adapters)
[![License: MIT](https://img.shields.io/github/license/redact-secret/redact-secret-adapters)](https://github.com/redact-secret/redact-secret-adapters/blob/main/LICENSE)

Keep secrets out of Python logs and OpenTelemetry traces. Tokens, API keys and
passwords are replaced before a record reaches a handler or a span reaches an
exporter.

Built on [Redact Secret](https://github.com/redact-secret/redact-secret),
which does the detection.

## Install

```bash
pip install redact-secret redact-secret-adapters           # logging
pip install redact-secret "redact-secret-adapters[otel]"   # + OpenTelemetry
```

Needs Python 3.10 or later.

## Quick start

| I want to protect | Go to |
| --- | --- |
| `logging` records | [`logging`](#logging) |
| OpenTelemetry spans | [OpenTelemetry](#opentelemetry-otel-extra) |
| A value my tool hands me to mask (Langfuse and similar) | [Masking callbacks](#masking-callbacks-langfuse-and-similar) |

## `logging`

```python
import logging
from redact_secret_adapters.logging_filter import RedactSecretFilter

handler = logging.StreamHandler()
handler.addFilter(RedactSecretFilter())  # on the handler, not the logger
logging.getLogger().addHandler(handler)

token = "ghp_SYNTHETICREVOKED00000000000000000000"  # synthetic
logging.warning("deploy with token %s", token)
# deploy with token <SECRET_1>
```

Your formatters, `extra` configuration and exception logging keep working
unchanged.

### Where to attach it

A `logging.Filter` runs **only where it is attached**. This is the one thing
to get right: add the filter to **every handler that writes somewhere**.

```python
import logging
from redact_secret_adapters.logging_filter import RedactSecretFilter

console = logging.StreamHandler()
audit = logging.FileHandler("audit.log")

redact = RedactSecretFilter()  # no per-record state: one instance can be shared
for handler in (console, audit):
    handler.addFilter(redact)  # every emitting handler, not the logger
    logging.getLogger().addHandler(handler)
```

This is not global automatic protection. A handler added anywhere else (by a
library, by `logging.basicConfig`, by a child logger of your own) is
unprotected until it, too, carries the filter.

| Placement | Covers | Leaves unprotected |
| --- | --- | --- |
| Every emitting **handler** (supported) | that handler, and any handler that runs after it on the same record | a handler attached later without the filter |
| A **handler** on an ancestor logger | records that propagate to it, including from child loggers | a handler the child carries itself |
| A **logger** | records logged directly on that logger | records **propagated** from child loggers: `Logger.filter` never runs for an ancestor |
| The `QueueListener`'s sink handler | the final destination | the record while it sits on the queue, and anywhere a `QueueHandler` subclass sends it (a socket, a `multiprocessing` queue) |

Handlers run in the order they were added and the filter mutates the record in
place, so a filtered handler also protects every handler after it, and an
**unfiltered handler that runs before it emits plaintext**. Do not rely on
order: filter each one.

For a `QueueHandler`/`QueueListener` pair, attach the filter to the
**`QueueHandler`**. It runs in the emitting thread, so only masked records
cross the queue:

```python
handler = logging.handlers.QueueHandler(records)
handler.addFilter(RedactSecretFilter())
listener = logging.handlers.QueueListener(records, logging.StreamHandler())
```

`python/tests/test_logging_placement.py` asserts each supported placement and,
as synthetic negative controls, that plaintext really does escape each wrong
one.

### What is covered

| Covered | Not covered |
| --- | --- |
| The message, formatted with its `args` before scanning | Record attributes you did not name in `extra_fields` |
| `exc_info` (replaced with redacted traceback text), cached `exc_text`, `stack_info` | Anything a custom formatter adds after the filter runs |
| Every attribute you name: `RedactSecretFilter(extra_fields=["user"])` | Dict keys and attribute names. Do not put a secret in a key |

After formatting the message the filter clears `args`, so a downstream
formatter cannot rebuild the original. A record with no finding is formatted
byte-for-byte as it would be without the filter. Masking an already-masked
record again is a no-op, so two filtered handlers on one record are safe.

What a named extra can be:

| Extra value | Becomes |
| --- | --- |
| `str` | the masked string |
| `dict`, `list`, `tuple` (and subclasses), an exception | a masked copy, walked to the limits below; a subclass comes back as the plain container |
| `int`, `float`, `bool`, `None` | itself, unchanged |
| anything else: a `set`, `bytes`, a dataclass, a `datetime`, any other object | `[REDACTED:ERROR]` |

The last row fails closed on purpose. The filter cannot know what a `%(ctx)s`
format or a JSON formatter's `default=str` would print for an arbitrary
object, so it never hands one over unscanned. Convert such a value to a `dict`
or a `str` yourself before logging it if you want it kept.

Nothing raises into your logging call. A container whose read raises (a
`__getitem__`, `keys()` or slice that raises) becomes `[REDACTED:ERROR]` for
that entry, or for the whole container when it cannot be listed at all. A
message that cannot be formatted (a bad `%` format, a raising `__str__`)
becomes `[REDACTED:ERROR]`.

### Filter options

```python
RedactSecretFilter(extra_fields=["user"], on_outcome=observe, policy=policy, limits={"max_depth": 4})
```

| Option | What it does |
| --- | --- |
| `extra_fields` | Names of record attributes to redact |
| `on_outcome` | A callback with counts per record. See [Counting what happened](#counting-what-happened) |
| `policy` | The core's policy, passed through unchanged |
| `limits` | Override the walk limits. See [Fail-closed markers](#fail-closed-markers) |
| `scan_and_redact` (first positional) | An injected scanner. With no argument it uses `redact_secret.scan_and_redact` |

## OpenTelemetry (`[otel]` extra)

```python
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from redact_secret_adapters.otel import create_redacting_span_processor

provider = TracerProvider()
provider.add_span_processor(create_redacting_span_processor(BatchSpanProcessor(otlp_exporter)))
```

Wrap the processor you already have. It takes `policy`, `limits` and
`on_outcome`.

| Covered | Not covered |
| --- | --- |
| The span name and status description | OpenTelemetry **Logs** and metrics |
| Every string and string-sequence attribute (a `None` inside a sequence stays in place) | Attribute **names**. Do not put a secret in an attribute key |
| Every event's name and attributes | Spans the wrapped processor never receives |
| Every link's attributes | |

OpenInference and GenAI semantic-convention attributes are covered without
hardcoding either convention's attribute list.

**A span that cannot be redacted is dropped, not exported.**
`opentelemetry-sdk` has no public way to change a span before export, so the
adapter writes the private fields behind the read-only accessors (`_name`,
`_status`, `_attributes` and its backing `_dict`) and reads each write back
through the public accessor. If an SDK release moves one of those fields, the
span is dropped rather than exported unredacted, and a `RuntimeWarning` is
issued once per processor. See `redact_secret_adapters.otel` for details.

Supported range: `opentelemetry-sdk>=1.16.0,<2`. CI runs
`tests/test_otel_host.py`, a real `TracerProvider`/exporter round trip, at
both ends of that range on every run.

## Masking callbacks (Langfuse and similar)

```python
from redact_secret_adapters.mask_secrets import mask_secrets

langfuse = Langfuse(mask=mask_secrets)
```

`mask_secrets(data=...)` returns a masked copy. `mask_secrets_with(scan, data)`
is the same walk over an injected scanner.

## PII detection is opt-in

Credential detection needs no init step: the native extension loads on
`import redact_secret`. **PII detection does.** It is opt-in, process-wide and
one-shot, and the application turns it on:

```python
import redact_secret

redact_secret.initialize(pii=["pii:global"])  # before the first record or span
```

**Placement is the whole rule.** Handlers are attached and tracer providers
built at import time, so a module imported earlier can emit *before* the line
above runs. Those records are scanned with PII off and report nothing: no
exception, no warning, and no counter that tells them apart from a record that
genuinely held nothing. These adapters cannot close that window, because the
process, not the filter, owns the activation. It is pinned as a known
limitation in `python/tests/test_pii_activation.py`. Enable PII first, then
attach handlers and build providers.

The selection is one-shot: a later *different* one raises
`redact_secret.PiiActivationConflictError`, and an empty selection is a
different selection, not a neutral one.

**Activation is not masking.** Under the core's default policy, PII types are
confidence-gated rather than always redacted: a `High`-confidence finding
redacts, while `Medium` and `Low` resolve to `warn`, and a `warn` finding
leaves the text alone. Enabling PII therefore still lets lower-confidence PII
reach a handler or an exporter as plaintext. Pass your own `policy` mapping
those findings to `redact` if you need them masked. The counters make it
observable: a record whose `values.findings` is non-zero while
`values.redacted` stays at zero is exactly this case.

## Counting what happened

`on_outcome` reports one summary per unit: one `logging` record, or one span.
It is observational: increment your own counters from it. Nothing here creates
a logger, a handler, an exporter or a network client.

```python
from redact_secret_adapters.logging_filter import RedactSecretFilter


def observe(outcome):  # LogRecordOutcome(level=..., values=ValueCounts(...))
    metrics.increment("log.records", level=outcome.level)
    metrics.increment("log.redacted_values", outcome.values.redacted)


handler.addFilter(RedactSecretFilter(on_outcome=observe))
```

```python
from redact_secret_adapters.otel import create_redacting_span_processor


def observe(outcome):  # SpanOutcome(values=ValueCounts(...), dropped=False)
    if outcome.dropped:
        metrics.increment("span.dropped_unredactable")


provider.add_span_processor(create_redacting_span_processor(next_processor, on_outcome=observe))
```

A `ValueCounts` is six non-negative integers and nothing else. There is no
field for a value, a record attribute, a key, an offset or an exception
message:

| Count | Means |
| --- | --- |
| `scanned` | Leaves handed to the core. A leaf a bound refused before the core saw it is not one of these |
| `findings` | Findings the core reported, summed. **Not** distinct credentials: one credential in five leaves is five findings |
| `redacted` | Leaves whose text the core changed. Lower than `findings` when an action leaves text alone (a `warn`) |
| `blocked` | Leaves replaced whole by `BLOCK_MARKER` |
| `limited` | Values replaced by `LIMIT_MARKER`; never scanned |
| `failed` | Values replaced by `ERROR_MARKER`, plus the `CYCLE_MARKER` case |

- The units follow placement: a record through **two** filtered handlers is
  two passes and reports twice, which is what a per-handler count means. The
  second pass finds nothing left to redact.
- `SpanOutcome.dropped` is this processor's own decision (a masked value would
  not write back). It is **not** a claim that an exporter succeeded, nor that
  a span was sampled out.
- Both observers run after the record or span is fully masked, so neither can
  turn a protected one into an unprotected one. Anything they raise is
  swallowed, never read, and never re-raised.
- The re-entrancy guard is thread-local: an observer that logs or traces does
  not recurse, and one thread never suppresses another's outcome.

## Fail-closed markers

When something goes wrong, a fixed marker is written instead of the original
text.

| Marker | When |
| --- | --- |
| `[REDACTED:BLOCKED]` | A `block` finding. The **entire** leaf is replaced |
| `[REDACTED:ERROR]` | Any exception from the core; a value that cannot be read (a raising `__str__`, `__getitem__` or `keys()`); any object the walker does not walk (see [What is covered](#what-is-covered)). Never the input, never the exception's message |
| `[REDACTED:LIMIT_EXCEEDED]` | A value past a walk budget. Never scanned, never passed through |
| `[REDACTED:CYCLE]` | A self-referencing object |

`DEFAULT_LIMITS`:

| Limit | Default |
| --- | --- |
| `max_depth` | 8 |
| `max_array_length` | 1000 |
| `max_object_keys` | 200 |
| `max_string_length` | 200000 |
| `max_total_leaves` | 5000 |
| `max_nodes` | 20000 |

`max_nodes` counts every value the walk visits: containers and leaves alike,
but not dict keys. A value reached by more than one path counts once per path.
The walk does not track values it has already visited, so a structure built
from shared lists or dicts is walked once per path, and without this budget
its cost would grow exponentially. Past `max_nodes`, every value, a number
included, becomes `[REDACTED:LIMIT_EXCEEDED]`.

A `limits` override that is not a usable bound (`None`, `NaN`, a negative
number, a `bool`, or not a number at all) falls back to that key's default,
instead of raising or disabling the bound. `float("inf")` is a valid bound and
means none.

`mask_secrets_with`, `mask_log_value_with` and `extra_fields` share one
walker, so the extras table under [What is covered](#what-is-covered) holds
for all three: any object that is not a string, number, boolean, `None`,
`dict`, `list`, `tuple` or exception becomes `[REDACTED:ERROR]`. The
TypeScript walker instead serializes an object the way `JSON.stringify` would;
Python has no single serialization to mirror.

**Dict keys and attribute names are not scanned.** The walker masks values
only. Every dict key, and every attribute name copied from an exception's
`__dict__`, reaches the handler unchanged, and so does the name of an
`extra_fields` attribute. The OpenTelemetry processor likewise leaves every
span, event, and link attribute key as it is. Do not put a secret in a key or
an attribute name.

## Development

From the repository root:

```bash
pip install -e "./python[otel,test]"
pytest
```

The fixture tests read the same JSON files in the repository's `fixtures/`
directory as the TypeScript suite; that shared file is what keeps the two
languages equivalent. More:
[CONTRIBUTING.md](https://github.com/redact-secret/redact-secret-adapters/blob/main/CONTRIBUTING.md).
Changes are listed in this package's `CHANGELOG.md`.

## License

MIT
