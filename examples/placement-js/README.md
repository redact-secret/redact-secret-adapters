# Placement verification: pino and OpenTelemetry (JavaScript)

Protection depends on **where** the adapter is placed. This recipe sends a fixed
synthetic credential through a real pino logger and a real OpenTelemetry tracer
into captured memory, then checks the final bytes. It also runs **negative
controls**: paths that are deliberately unprotected, which the verifier must flag.
If it ever reports a control as protected, the verifier is broken.

- Runtime: Node.js 22 or 24 (ESM).
- Installs: `@redact-secret/adapter-pino` 0.1.6, `@redact-secret/adapter-otel-trace` 0.1.4, `@redact-secret/core` 0.1.0-beta.14, `pino` 10.3.1, `@opentelemetry/sdk-trace-base` 2.11.0, `@opentelemetry/otlp-transformer` 0.222.0.
- Everything stays in memory. Nothing contacts a collector, a log service or a production endpoint.

## Run it

Copy this folder out of the repository first (see [how](../README.md#run-one)), then:

```sh
npm install
npm start
```

## What the verifier decides

It only looks at captured output:

<!-- snippet: examples/placement-js/verify.mjs#verdict -->
```js
/**
 * LEAKED     the synthetic credential is in the captured output
 * UNVERIFIED nothing was captured, or no sanitized placeholder is in it, so nothing was proven
 * PROTECTED  output exists, the credential is absent, and a sanitized placeholder is present
 */
export function verdict(captured) {
  if (captured.includes(TOKEN)) return "LEAKED";
  if (captured.length === 0 || !/<SECRET_\d+>/.test(captured)) return "UNVERIFIED";
  return "PROTECTED";
}
```

A pipeline that drops all output is `UNVERIFIED`, not `PROTECTED`. The report prints a
label, a verdict and a placeholder count, never the captured bytes.

## The paths

pino. The recipe logs a message, a child binding, `mixin()` output and an `Error`:

<!-- snippet: examples/placement-js/pino-recipes.mjs#pino-protected -->
```js
async function protectedPino() {
  const sink = capture();
  const logger = pino({ ...options, hooks: await createRedactingHooks() }, sink);
  logEverywhere(logger);
  return sink.text;
}
```

Its two controls are a logger with no hooks and a logger with only the `logMethod`
hook, which leaves child bindings and `mixin()` output unprotected.

OpenTelemetry traces. One provider, two destinations. What decides which is
protected is the registration order:

<!-- snippet: examples/placement-js/otel-recipes.mjs#otel-protected -->
```js
await emitOneSpan([
  // Control: a processor registered AHEAD of the redacting one sees the span before it is redacted.
  new SimpleSpanProcessor(sibling),
  // Wrap the processor that feeds the exporter. The redacting processor goes around it, not beside it.
  await createRedactingSpanProcessor(new SimpleSpanProcessor(guarded)),
]);
```

The exporter serializes spans to the OTLP/JSON request body an `http/json` exporter would
send, so the check covers supported exporter serialization and not just a callback.

## Expected output

<!-- expected-output -->
```text
ok   protected PROTECTED  pino: message, child binding, mixin and Error, with createRedactingHooks() (8 placeholders)
ok   control   LEAKED     pino: no hooks at all (0 placeholders)
ok   control   LEAKED     pino: only the logMethod hook (child bindings and mixin escape) (5 placeholders)
ok   protected PROTECTED  otel traces: exporter behind createRedactingSpanProcessor() (name, attribute, event) (3 placeholders)
ok   control   LEAKED     otel traces: exporter on a processor registered ahead of the redacting one (0 placeholders)
OK: every protected path passed and every negative control was detected (tested paths only)
```

`ok` on a `control` row means the leak **was** detected. A `FAIL` row, or a final `FAIL:`
line with exit code 1, means a protected path leaked or a control was not seen.

## Adapt it to your topology

1. Replace the body of `protectedPino()` or the span setup with the construction your
   application really uses: your `pino()` options, your child loggers, your processor list.
2. Keep the destination in memory. Point your logger at a capture object, or your exporter at
   a serializer that writes to a string. Do not send the synthetic token to a real endpoint.
3. Keep `TOKEN` synthetic. Never put a real credential into this verifier.
4. Add a control for each path you worry about: the same calls through a logger or
   processor list built without the adapter. A recipe with no control proves little.

## What a pass means

A `PROTECTED` row means: for **this** pipeline, built **this** way, with **this** synthetic
value, the captured bytes held no trace of it and held a sanitized placeholder. It does not
certify other handlers, transports, processors, later configuration changes or other values.
Detection is the core's, and a clean result is not proof an input held no secret.

What the adapters cover and do not: the [pino](../../packages/adapter-pino#what-is-covered)
and [OpenTelemetry trace](../../packages/adapter-otel-trace#what-is-covered) guides. The real-host tests
this recipe mirrors are `packages/adapter-pino/test/pino-host.test.ts` and
`packages/adapter-otel-trace/test/exporter-bytes.test.ts`. If a row is not what you expected,
see [troubleshooting](../../docs/troubleshooting.md).
