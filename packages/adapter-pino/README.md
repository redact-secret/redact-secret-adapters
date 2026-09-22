# @redact-secret/adapter-pino

Value-based secret redaction for [pino](https://github.com/pinojs/pino), over
the [Redact Secret](https://github.com/redact-secret/redact-secret) core.

```bash
npm install @redact-secret/core @redact-secret/adapter-pino pino
```

```js
import pino from "pino";
import { createRedactingLogMethod, createRedactingStreamWrite } from "@redact-secret/adapter-pino";

const logger = pino({
  hooks: {
    logMethod: await createRedactingLogMethod(),
    streamWrite: await createRedactingStreamWrite(),
  },
  redact: ["req.headers.authorization"], // pino's own path-based redact still applies, on top
});

logger.info("token is %s", secretValue); // the secret never reaches the transport
```

pino's own `redact` option censors by object *path*. It cannot see a token
inside a message string or an error message. This adapter redacts by *value*,
alongside that mechanism rather than instead of it.

> **Install both hooks.** `hooks.logMethod` sees only the arguments of a log
> call. It never sees **child-logger bindings** (`logger.child({ ... })`,
> `setBindings`) or **`mixin()` output**: pino serializes bindings when the
> child is created and merges `mixin()` after the hook returns. With
> `logMethod` alone, a secret in either reaches the destination in plaintext.
> `hooks.streamWrite` masks the finished line, so it covers both, at the cost
> of scanning each line's strings a second time.

## What is redacted

With `hooks.logMethod`, before pino serializes anything:

- The message — joined with its printf-style interpolation values into the
  exact string pino would format, *before* scanning, so a secret split across
  the format string and its arguments is still one leaf.
- Every string in a merging object, at any depth, including class instances
  and `toJSON()` values (see
  [`@redact-secret/adapter`](../adapter#injected-api)).
- An `Error` anywhere in the call, including a bare `logger.error(err)`:
  `message`, `stack` and own properties are redacted before pino's `err`
  serializer runs. A leading `Error` stays an instance of its class, so
  `err.type` and pino's `msg` fallback behave as without the hook.

With `hooks.streamWrite`, just before the line reaches the destination: every
string value in the line, whatever produced it (bindings, `mixin()`,
serializers, `base`). Object keys are not scanned.

A `block` finding replaces the whole leaf with `[REDACTED:BLOCKED]`; any core
failure produces `[REDACTED:ERROR]`. See
[`@redact-secret/adapter`](../adapter#fail-closed-markers) for all markers and
limits.

## Exports

| Export | Purpose |
| --- | --- |
| `createRedactingLogMethod(options?)` | Live: awaits the core's `initialize()`, returns a `hooks.logMethod` |
| `createRedactingStreamWrite(options?)` | Live: awaits the core's `initialize()`, returns a `hooks.streamWrite` |
| `createRedactingLogMethodWith(scanAndRedact, options?)` | The `logMethod` hook over an injected scanner |
| `createRedactingStreamWriteWith(scanAndRedact, options?)` | The `streamWrite` hook over an injected scanner |
| `formatPinoMessage(fmt, values)` | Internal: the port of pino's message formatter the hook joins with. Kept for compatibility, not a supported API |

`options` is `{ policy, limits }`.

## Supported pino versions

`pino ^10.0.0`, verified by a real `pino` logger writing to a captured stream,
run in CI at both ends of that range. pino `9.x` is deliberately not in the
range: it may work; it is not tested, so it is not claimed.

pino is imported as a type only — it never enters this package's runtime graph.

## License

MIT
