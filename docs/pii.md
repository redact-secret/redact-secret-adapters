# PII detection

The core detects credentials out of the box. Detecting personal data (PII) is
a separate switch that you turn on yourself.

## Turning it on

### JavaScript

Pass `pii` to the factory you already call:

```js
const logger = pino({ hooks: await createRedactingHooks({ pii: ["pii:global"] }) });
```

`pii` is accepted by `createRedactingHooks`, `createRedactingLogMethod`,
`createRedactingStreamWrite`, `createRedactingSpanProcessor`,
`createAiContextBoundary` and `createMcpBoundary`.

Or activate it yourself first, and the factories accept what you chose:

```js
import { initialize } from "@redact-secret/core";

await initialize({ pii: ["pii:global"] });
const logger = pino({ hooks: await createRedactingHooks() });
```

Prefer the first form when the adapter is the first thing in the process to
touch the core.

### Python

```python
import redact_secret

redact_secret.initialize(pii=["pii:global"])  # before the first record or span
```

Credential detection needs no init step in Python, because the extension loads
on `import redact_secret`. PII does, and **where you put that line is the whole
rule**. Handlers are attached and tracer providers are built at import time, so
a module imported earlier can emit before the line runs. Those records are
scanned with PII off and report nothing: no exception, no warning, and no
counter that tells them apart from a record that held nothing. That window is
pinned as a known limitation in `python/tests/test_pii_activation.py`. Enable
PII first, then attach handlers and build providers, or let the factory do it:

```python
handler.addFilter(RedactSecretFilter(pii=["pii:global"]))
processor = create_redacting_span_processor(next_processor, pii=["pii:global"])
```

`pii=` initializes the core and checks `pii_activation()` before the object is
returned. It accepts an equivalent selection that is already active and
otherwise raises `redact_secret_adapters.CoreActivationError` with a fixed code
(`PII_ACTIVATION_NOT_ACTIVE`, `PII_ACTIVATION_UNAVAILABLE` or
`PII_ACTIVATION_UNSUPPORTED`) and no selector, input or core text. It cannot be
combined with an injected scanner. Omitting it leaves activation to the
application, as above.

## The rules

- **Process-wide and one-shot.** The first selection wins. A later *different*
  one fails with `PII_ACTIVATION_CONFLICT`
  (`redact_secret.PiiActivationConflictError` in Python). An empty selection is
  a different selection, not a neutral one.
- **A factory given `pii` checks that it took effect.** It reads the core's
  `piiActivation()` afterwards and refuses if the active selection is not the
  one you asked for, instead of running with PII silently off.
  - `adapter-pino`, `adapter-otel-trace` and `adapter-otel-logs` (beta)
    reject, with a fixed code:
    `PII_ACTIVATION_NOT_ACTIVE`, or `PII_ACTIVATION_UNSUPPORTED` against a core
    too old to report an activation.
  - `adapter-ai-context` and `adapter-mcp` never reject. Every operation fails
    closed as `blocked` / `core_error` instead.
  - The refusal never echoes a selector, the input, or the core's own message.
- **Core version.** Passing `pii` needs `@redact-secret/core` `0.1.0-beta.10`
  or later. Omitting it works at the declared floor, `0.1.0-beta.6`.

## Activation is not masking

Under the core's default policy, PII types are confidence-gated rather than
always redacted. A `High`-confidence finding redacts. `Medium` and `Low`
resolve to `warn`, and a `warn` finding leaves the text alone.

So with PII on, lower-confidence PII still reaches a log line, a span or an AI
context as plaintext. Pass your own `policy` mapping those findings to `redact`
if you need them masked. This repository decides nothing about policy.

You can see it happen:

- In the [outcome counters](../packages/adapter/README.md#outcome-counters),
  a record or span with a non-zero `findings` that is not counted in
  `redacted` is exactly this case.
- In `adapter-ai-context` and `adapter-mcp`, an `ok` outcome whose `findings`
  is non-empty but whose `value` equals the input is exactly this case.

## See the difference

Two runnable comparisons run **one** synthetic input under three configurations,
each in its own process because activation is process-wide and one-shot: credentials
only (PII off), PII activated with the core's default policy, and PII activated with
an explicit core `policy`.

- [JavaScript](../examples/policy-js): `adapter-ai-context` (findings and their
  actions) and `adapter-pino` (counters).
- [Python](../examples/policy-python): `logging` with `on_outcome` counters.

The configurations, as the JavaScript example defines them:

<!-- snippet: examples/policy-js/index.mjs#configurations -->
```js
// An explicit core policy. It replaces the built-in one for EVERY finding, so keep `block` for the
// type the built-in policy blocks. This is an example choice, not a recommendation.
const explicitPolicy = {
  evaluate: (finding) => (finding.type === "private_key" ? "block" : "redact"),
};

const CONFIGURATIONS = {
  default: {}, // credentials only: PII stays off
  pii: { pii: ["pii:global"] }, // PII activated, the core's default policy
  policy: { pii: ["pii:global"], policy: explicitPolicy }, // PII activated, your policy
};
```

What the runs show, with the pinned core `0.1.0-beta.14`:

| Configuration | Credential | Email next to a context word (PII, high) | `password=...` (a `warn`) |
| --- | --- | --- | --- |
| credentials only | redacted | unchanged, and no finding | unchanged, finding with action `warn` |
| PII on, default policy | redacted | redacted | unchanged, still `warn` |
| PII on, explicit policy | redacted | redacted | redacted |

- `redact` replaces the matched part. `warn` reports a finding and leaves the text
  alone. `block` replaces the whole value (`blocked` in AI-context and MCP,
  `[REDACTED:BLOCKED]` in logs and spans).
- The `warn` row is a credential-shaped value, not PII: none of the PII samples tried
  with that core resolved to `warn`, so the guide claims no stable PII `warn` case.
  Which PII is detected, and at what confidence, is the core's decision and can change
  with its version. A masked example does not show that every PII type is supported.
- `findings` counts what the scans reported, once per scan pass (`adapter-pino` scans a
  record in two hooks), so it is not a count of distinct secrets. An `ok` result, or a
  clean counter, is not a guarantee that nothing was missed.
- The examples use only options in released adapters (`pii` and `policy` in the npm
  adapters, `redact_secret.initialize(pii=...)` and `policy=` in Python). Other
  released options, such as `scanLimits`, `ruleset`, `placeholderFormatter`,
  `actionPolicy` or the Python `pii=` factory argument, have no example here; the
  [policy overlays guide](./policy-overlays.md) covers `actionPolicy`.

## Building your own integration

`@redact-secret/adapter` exports the activation step every live factory runs:
`activateCore(core, { pii })`. See
[its README](../packages/adapter/README.md#core-activation-and-pii).
