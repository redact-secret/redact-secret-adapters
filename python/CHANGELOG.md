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

### Changed

- **Behavior change:** `scan_config` beside `policy`, `action_policy`, `scan_limits`, `ruleset` or `placeholder_formatter` (`mask_leaf_with`, `mask_leaf_outcome_with`, `RedactingSpanProcessorWith`) is a fixed, input-free `TypeError`, not a silent precedence; a `scan_config` not built by `resolve_scan_config` is rejected (redact-secret-adapters#213). New `scan_config_of`. The live factories take the loose options only. Test: `python/tests/test_scan_options.py`.

### Added

- `action_policy` on `resolve_scan_config`, `mask_secrets_with`, `mask_log_value_with`, `mask_leaf_with`, `mask_leaf_outcome_with`, `redact_attributes_with`, `RedactSecretFilter`, `RedactingSpanProcessorWith` and `create_redacting_span_processor`: the core's declarative action policy (a `dict`, or its JSON as `str`, `bytes` or `bytearray`), passed to `scan_and_redact(action_policy=...)` intact on every whole-input scan (redact-secret-adapters#217). Snapshotted once (a `dict` is serialized once, a `bytearray` copied); mutually exclusive with `policy` (a `TypeError` before the core is called); the adapter neither parses nor evaluates it. `SCAN_OPTION_CORE_FLOORS["action_policy"]` is `0.1.0-beta.14` (`redact-secret` 0.1.0b14, the first PyPI release with the binding); `verify_scan_options` rejects an older core by name (`CORE_OPTION_UNSUPPORTED`) and a refused document as `CORE_OPTION_REJECTED` with `core_code="INVALID_ACTION_POLICY"`. Every other option keeps working on the declared floor; the `redact-secret>=0.1.0b6` range is unchanged. Test: `tests/test_action_policy.py`.

## [0.1.5] - 2026-10-03
### Changed

- Verified against `redact-secret` 0.1.0b13. No API or range change.

## [0.1.4] - 2026-10-02

### Added

- **Explicit PII activation on the live factories**
  (redact-secret/redact-secret-adapters#176). `RedactSecretFilter(pii=[...])`
  and `create_redacting_span_processor(next, pii=[...])` initialize the core
  with that selection and verify `pii_activation()` reflects it before
  returning, closing the silent PII-off window of the application-first order.
  Both share one implementation (`_activation.py`). Omitting `pii` is
  unchanged: `initialize` is never called. An equivalent active selection is
  accepted; anything else raises the new `CoreActivationError` with a fixed,
  input-free `code` (`PII_ACTIVATION_NOT_ACTIVE`, `PII_ACTIVATION_UNAVAILABLE`,
  `PII_ACTIVATION_UNSUPPORTED`), and unrelated initialization failures
  propagate. `pii` with an injected `scan_and_redact` raises `TypeError`;
  injected paths still never import the real core. Passing `pii` needs
  `redact-secret` 0.1.0b10 or later; the declared floor is unchanged. Tested
  by `test_pii_factories.py` (real-core subprocess cases for adapter-first,
  application-first, repeated and conflicting selections, the unsupported
  floor and failure before the first event, for both factories).

- **`redact_secret_adapters.key_context`**: the shared key-context scan primitive (`scan_leaf_in_key_context`, `key_context_view`, `key_context_prefix`, `KeyContextFailure`), the Python twin of the JavaScript primitive in redact-secret/redact-secret-adapters#172. `mask_leaf_with` and `mask_leaf_outcome_with` take `key=`.

- **`redact_secret_adapters.budget.OperationBudget`: an aggregate budget per operation** (redact-secret/redact-secret-adapters#173), accepted as `operation_limits` by `RedactSecretFilter` (one `filter()` call: message, exception text, stack and every extra field), `RedactingSpanProcessorWith` / `create_redacting_span_processor` (one span), `redact_attributes_with`, `mask_secrets_with` and `mask_log_value_with`. It counts UTF-8 bytes and `scan_and_redact` calls as actual calls and nodes, mapping keys, leaves and findings as occurrences (key-context scans and keys explicitly). Defaults: 16 MiB, 50,000 scans, 100,000 nodes, 100,000 keys, 25,000 leaves, 100,000 findings. Each call has a fresh budget, so threads and re-entrant calls never share one. It is a work counter, not a wall-clock interrupt.

- **Verified core scan options** (redact-secret/redact-secret-adapters#175): `scan_limits` (the core's whole-input limits, a mapping with `max_input_bytes` and `max_findings`), `ruleset` (`str`, `bytes` or `bytearray`) and `placeholder_formatter` (the core's `formatter`), beside `policy`, on `RedactSecretFilter`, `RedactingSpanProcessorWith`, `create_redacting_span_processor`, `redact_attributes_with`, `mask_secrets_with` and `mask_log_value_with`. They are validated and snapshotted once (`resolve_scan_config`) and passed to every scan as `scan_and_redact(text, policy, **requested)`; with none asked the call is exactly `scan_and_redact(text, policy)`. The caller's `policy` replaces the core's built-in policy for every finding and is never combined with another. The live constructors convert a `scan_limits` mapping to `redact_secret.WholeInputLimits`, check `redact_secret.VERSION` against `SCAN_OPTION_CORE_FLOORS` and probe the options with one scan of the empty text, raising a fixed-message `CoreOptionsError` for an unsupported core or a ruleset or limits the core refuses.
- No range change: verified from the declared floor `0.1.0b6` through `0.1.0b12` by `tests/test_scan_options.py`, which CI runs at both Python range endpoints.

### Changed

- **Key-aware detection** (redact-secret/redact-secret-adapters#172). A string directly under a mapping key is now scanned with that key as detection context, so a context-dependent credential (`{"api_key": "..."}`) is masked by `mask_secrets_with`, `mask_log_value_with`, `RedactSecretFilter` (inside `extra_fields` values, and the extra field's own name for a plain string), and `RedactingSpanProcessorWith` / `redact_attributes_with` (the attribute name). The core alone decides; keys are never scanned, rewritten or returned, and sequence elements, messages, tracebacks, span names, event names and status descriptions have no key. A keyed string costs one extra `scan_and_redact` call unless its own scan already redacted or blocked it; the `scanned` outcome counter still counts leaves. A key-context finding outside the leaf (it would rewrite the key) replaces the leaf with `[REDACTED:BLOCKED]`; a key longer than `max_string_length` makes the leaf `[REDACTED:LIMIT_EXCEEDED]`.

- **Behavior change with defaults:** a record, span or call that inspects more than the default budget now has the rest replaced by `[REDACTED:LIMIT_EXCEEDED]` (and mapping keys past it dropped); the outcome counters keep their meaning (`limited` counts them).

## [0.1.3] - 2026-10-01
### Changed

- Verified against `redact-secret` 0.1.0b12, which carries the core's performance improvements; they reach this package through the unchanged core range. No API or range change.

## [0.1.2] - 2026-09-30
### Added

- **`max_nodes` walk budget (default 20000)** in `DEFAULT_LIMITS`
  (redact-secret/redact-secret-adapters#87). The walker behind
  `mask_secrets_with`, `mask_log_value_with` and `extra_fields` budgeted only
  string leaves, and it walks a shared reference once per path. An in-process
  graph of shared lists therefore cost exponential time before any string
  budget tripped (a probe: 10^8 paths took 85 s). Every visited value now
  counts, containers included, with the same rule and default as the
  TypeScript `maxNodes`. Past the budget, every value becomes
  `[REDACTED:LIMIT_EXCEEDED]` (counted `limited`). Invalid overrides fall back
  to the default through `resolve_limit`. Tested by
  `test_max_nodes_counts_every_visit_once_per_path`,
  `test_a_shared_reference_dag_is_bounded_by_max_nodes_not_its_path_count`, and
  the shared `shared_reference_dag_is_bounded_by_max_nodes` and
  `tightened_max_nodes_bounds_a_shared_reference_dag` cases.

### Changed

- **An object the walker does not walk now fails closed to
  `[REDACTED:ERROR]`** instead of passing through unchanged
  (redact-secret/redact-secret-adapters#85). This covers a `set`, `bytes`, a
  dataclass, a `datetime`, or any other instance reached by
  `mask_secrets_with`, `mask_log_value_with`, or a `RedactSecretFilter`
  `extra_fields` entry. Before, a `%(ctx)s` format or a JSON formatter with
  `default=str` printed such a value unscanned. `str`, `int`, `float`,
  `bool` and `None` are unchanged, and `dict`, `list`, `tuple` and
  exceptions are still walked. To keep such a value, convert it to a
  `dict` or `str` before logging it. Tested by
  `test_any_other_object_fails_closed_to_the_error_marker`,
  `test_a_non_container_object_extra_fails_closed_for_str_and_json_formatters`,
  and the shared `opaque_object_never_passes_its_secret_through` case in
  `fixtures/bounded-traversal-cases.json`.

### Fixed

- A container whose read raises (a `dict` subclass whose `__getitem__` or
  `keys()` raises, a `list` subclass whose slicing raises) no longer raises
  out of the walk, or out of `logger.info()` through `RedactSecretFilter`
  (#85). It becomes `[REDACTED:ERROR]` for that key alone, or for the whole
  container when it cannot be listed, as in the TypeScript walker. Tested by
  `test_a_container_whose_read_raises_degrades_per_entry_and_never_raises`,
  `test_an_extra_whose_read_raises_never_raises_into_the_logging_call`, and
  the shared `throwing_entry_degrades_for_that_entry_alone` case.
- `limits` are validated like the TypeScript `resolveLimit` (#85): `None`,
  `NaN`, a negative number, a `bool`, or a non-number falls back to that
  key's default. Before, `max_depth=None` raised `TypeError` out of
  `filter()`, `max_total_leaves=float("nan")` never tripped, and
  `max_array_length=-1` kept all but the last element. Tested by
  `test_an_invalid_limit_falls_back_to_the_default_instead_of_disabling_it`,
  `test_invalid_limits_fall_back_to_the_defaults_instead_of_raising`, and the
  shared `invalid_*_limits_fall_back_to_the_defaults` cases.
## [0.1.1] - 2026-09-28
### Fixed

- The "there is no init step for the Python bindings" claim in
  `mask_secrets.py` and `otel.py` was wrong as of `redact-secret`
  `0.1.0b10` (redact-secret/redact-secret-adapters#51). It holds for
  credential detection, where the extension still loads on
  `import redact_secret`, but **PII detection is an explicit, process-wide,
  one-shot activation**: `redact_secret.initialize(pii=[...])`, whose first
  selection wins and whose later, different selection raises
  `PiiActivationConflictError`. Corrected there and in
  `logging_filter.py`.

- A span's **attribute** values are now counted by the processor's own masker.
  They were redacted correctly, but went through the module-level
  `redact_attributes_with`, so a processor reporting outcomes would have
  counted only the span and event names. Found by the new per-span count
  tests.
- The per-span counter is saved and restored around `on_end`, and its values
  are snapshotted before the span is handed to the next processor. A
  downstream processor that ends a span synchronously inside `next.on_end`
  re-enters `on_end` before the outer span has been reported, and used to
  leave the outer span reporting an **empty** counter. Redaction and export
  were never affected — only the reported numbers.

Note on `mask_leaf_outcome_with`: counting findings needs
`len(result.findings)`, so a malformed core result whose `findings` has no
length (a generator) now fails closed to `ERROR_MARKER` where `0.1.0` returned
the masked text. That is the direction a malformed result should fail in.

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
- `mask_secrets_with` / `mask_log_value_with`: tuples and `dict`/`list`
  subclasses (`OrderedDict`, `defaultdict`, ...) were returned unscanned
  because only exact `dict`/`list` were walked. Both functions now share one
  walker that walks them; a tuple comes back as a plain `tuple`, a
  `dict`/`list` subclass as a plain `dict`/`list`. `mask_secrets_with` now
  also walks exceptions, as `mask_log_value_with` already did.
- `RedactSecretFilter(extra_fields="auth")` named the fields `a`, `u`, `t`,
  `h`; a bare string now names one field. A listed extra holding a
  dict/list/tuple was left unscanned; it is now walked and replaced by a
  masked copy (the caller's object is not mutated).
- `RedactSecretFilter`: a record with `exc_info=(None, None, None)` and a
  cached `exc_text` left that text unscanned; it is now masked.
- `otel`: only `on_end` is required of the wrapped processor, as the
  constructor already checked; a missing `on_start` is skipped and a
  missing `force_flush` returns `True`, like the JS package.
- `mask_log_value_with` / `mask_secrets_with`: an exception's own
  attributes (its `__dict__`, e.g. `exc.headers` or `__notes__`) were
  dropped from the masked mapping. They are now walked and included, like
  the JS `maskError`'s own enumerable properties.
- Build requirement raised from `hatchling>=1.25` to `hatchling>=1.27`:
  1.25.0 cannot build this project (`license-files` must be a table), and
  1.26.x builds a wheel whose metadata omits the `MIT` license expression.

### Documented

- The placement rule, and the window it leaves open. Handlers are attached
  and tracer providers built at import time, so a module imported earlier
  can emit records *before* the line that enables PII has run. Those
  records are scanned with PII off and report nothing — no exception, no
  warning, and no counter that tells them apart from a record that
  genuinely held nothing. These adapters cannot close that window, because
  the process owns the activation, so it is pinned as a **known
  limitation** in `python/tests/test_pii_activation.py` rather than hidden;
  the same file pins the documented order working, and the one-shot
  conflict, each in its own interpreter.
- Activating PII is not the same as masking every PII value: under the
  core's default policy `High`-confidence PII redacts while `Medium` and
  `Low` resolve to `warn`, and a `warn` finding leaves the text alone (see
  `mask_leaf.py`), so lower-confidence PII still reaches a handler or an
  exporter as plaintext unless the caller supplies a `policy` that maps
  those findings to `redact`. These adapters decide nothing about policy
  and synthesize none. The counters make it observable, since `findings`
  and `redacted` are counted apart.

### Added

- `redact_secret_adapters.outcome`: the same input-free outcome contract as
  the TypeScript `@redact-secret/adapter`
  (redact-secret/redact-secret-adapters#45). `OutcomeCounter` /
  `ValueCounts` hold six non-negative integers — `scanned`, `findings`,
  `redacted`, `blocked`, `limited`, `failed` — and nothing else, so there is
  no field for a value, a record attribute, a key, an offset or an exception
  message. `findings` and `redacted` are separate because a `warn` finding
  changes no text, and neither is a count of distinct credentials.
- `RedactSecretFilter(on_outcome=...)`: one `LogRecordOutcome` per record
  the filter masks, carrying the numeric level and the value counts. A record
  through two filtered handlers is two passes and reports twice, which is what
  a per-handler count means.
- `create_redacting_span_processor(on_outcome=...)` and the same keyword on
  `RedactingSpanProcessorWith`: one `SpanOutcome` per span, with `dropped`.
  `dropped` is this processor's own decision and is never a claim that an
  exporter succeeded or that a span was sampled out.
- Both observers are called after the record or span is fully masked;
  anything they raise is swallowed, never read, and never changes what is
  emitted. The re-entrancy guard is thread-local, so an observer that logs or
  traces does not recurse and one thread never suppresses another's outcome.
  Neither creates a logger, a handler, an exporter or a network client.
- `mask_leaf_outcome_with` and `count_leaf`; `mask_leaf_with` is now a
  one-line wrapper over the former and returns exactly the same string for
  every input.

### Changed

- The README now states where `RedactSecretFilter` has to be attached in an
  application with more than one handler, with propagating child loggers, or
  with a `QueueHandler`/`QueueListener` pair, and what each wrong placement
  leaves unprotected (redact-secret/redact-secret-adapters#48). No code
  change: a `logging.Filter` runs only where it is attached, so placement was
  always the security decision — it was documented in one line under a
  single-handler example that could be read as global automatic protection.
  `python/tests/test_logging_placement.py` asserts each supported placement
  and, as synthetic negative controls, that plaintext really does escape each
  wrong one; the wheel smoke test now installs the multi-handler setup the
  README recommends instead of attaching the filter to a logger.

### Deprecated

- `RedactSecretFilter(name=...)`: it was accepted but never honored (the
  filter redacts every record it sees and never drops one, unlike a named
  `logging.Filter`). Passing a non-empty `name` now emits a
  `DeprecationWarning`; the parameter will be removed in a later minor
  release. Attach the filter where it should apply instead.

## [0.1.0] - 2026-09-22
Initial release.

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

