# Changelog

All notable changes to `redact-secret-adapters` (PyPI) are documented in this
file. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Every package in this repository carries its own SemVer and is released
independently — see [ARCHITECTURE.md § Versioning](../ARCHITECTURE.md#versioning).
A change to the range this package declares against `redact-secret`, its
`requires-python` floor, or the `otel` extra's `opentelemetry-sdk` range is
always its own entry, naming the test that backs the new range, never folded
into a generic "bump dependency" line.

To release: in a PR into `develop`, move this section's `Unreleased`
entries under a new `## [x.y.z] - YYYY-MM-DD` heading matching the version
bumped in `pyproject.toml`. The next release train publishes and tags every
package whose declared version isn't on its registry yet — see
[RELEASING.md](../RELEASING.md). This file ships inside the sdist
(`tool.hatch.build.targets.sdist.include` in `pyproject.toml`), so a consumer
can read it without leaving their environment.

## [Unreleased]

### Fixed

- `otel`: a string-sequence attribute containing `None` (which the SDK
  accepts) was exported unscanned. Each `str` element is now masked and
  `None` kept in place.
- `otel`: the span name, status description, event names, and link
  attributes are now redacted, not only span and event attributes.
- `RedactSecretFilter`: a `%`-formatting error (`logger.info("value", x)`,
  `logger.info("%d", "abc")`) or a message whose `__str__` raises no longer
  raises out of the filter into the logging call; the message becomes
  `[REDACTED:ERROR]` and the arguments are cleared, so the handler's
  `handleError` never prints them.
- An exception whose `__str__` raises no longer crashes `logger.exception()`
  or `mask_log_value_with`; its `message` becomes `[REDACTED:ERROR]`. The
  filter now scans an exception once, as its formatted traceback (which
  already includes the message and the cause chain), instead of also
  scanning the message and every cause and discarding the results.
- `otel`: if a private span field the processor writes is missing, or a
  write does not show through the public accessor (an SDK release that
  moved the field), the span is now dropped with a one-time
  `RuntimeWarning` instead of being exported unredacted. No redaction
  failure raises out of `on_end`.

## [0.1.0]

Initial release. Not yet published — this heading gains a release date once
the Release workflow first publishes this package.

### Added

- `RedactSecretFilter` (`redact_secret_adapters.logging_filter`): a
  `logging.Filter` that redacts a record's `msg`, `args`, and exception info
  before any handler formats it. Python's standard library has no
  value-based redaction of its own.
- `mask_secrets_with` / `mask_leaf_with` / `mask_log_value_with`
  (`redact_secret_adapters`): the shared fail-closed masking primitives,
  usable directly as a masking callback (e.g. Langfuse's `mask=`).
- `otel` module (`redact_secret_adapters.otel`, requires the `otel` extra): a
  `SpanProcessor` wrapper equivalent to the JS `adapter-otel` package. Writes
  through `BoundedAttributes`' backing dict, since the Python OpenTelemetry
  SDK marks span and event attributes immutable once a span ends, before any
  processor hook fires.
- Declared ranges: `redact-secret>=0.1.0b6,<0.2`; `requires-python >=3.10`
  for the stdlib `logging` integration; `otel` extra:
  `opentelemetry-sdk>=1.16.0,<2`, verified by a real span passed through a
  real `TracerProvider` at both ends of the range.
