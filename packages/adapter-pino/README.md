# @redact-secret/adapter-pino

Value-based secret redaction for [pino](https://github.com/pinojs/pino), over
the [Redact Secret](https://github.com/redact-secret/redact-secret) core.

```bash
npm install @redact-secret/core @redact-secret/adapter-pino pino
```

```js
import pino from "pino";
import { createRedactingLogMethod } from "@redact-secret/adapter-pino";

const logger = pino({
  hooks: { logMethod: await createRedactingLogMethod() },
  redact: ["req.headers.authorization"], // pino's own path-based redact still applies, on top
});

logger.info("token is %s", secretValue); // the secret never reaches the transport
```

pino's own `redact` option censors by object *path*. It cannot see a token
inside a message string or an error message. This adapter redacts by *value*,
alongside that mechanism rather than instead of it.

## What is redacted

- The message — joined with its printf-style interpolation values into the
  exact string pino would format, *before* scanning, so a secret split across
  the format string and its arguments is still one leaf.
- Every string field of a merging object, at any depth.
- An `Error` anywhere in the call, including a bare `logger.error(err)`:
  `message` and `stack` are redacted before pino's `err` serializer runs.

A `block` finding replaces the whole leaf with `[REDACTED:BLOCKED]`; any core
failure produces `[REDACTED:ERROR]`. See
[`@redact-secret/adapter`](../adapter#fail-closed-markers) for all markers and
limits.

## Exports

| Export | Purpose |
| --- | --- |
| `createRedactingLogMethod(options?)` | Live: awaits the core's `initialize()`, returns a `hooks.logMethod` |
| `createRedactingLogMethodWith(scanAndRedact, options?)` | Same hook over an injected scanner |
| `formatPinoMessage(fmt, values)` | The port of pino's message formatter the hook joins with |

`options` is `{ policy, limits }`.

## Supported pino versions

`pino ^10.0.0`, verified by a real `pino` logger writing to a captured stream,
run in CI at both ends of that range. pino `9.x` is deliberately not in the
range: it may work; it is not tested, so it is not claimed.

pino is imported as a type only — it never enters this package's runtime graph.

## License

MIT
