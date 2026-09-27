# @redact-secret/adapter-pino

Value-based secret redaction for [pino](https://github.com/pinojs/pino), over
the [Redact Secret](https://github.com/redact-secret/redact-secret) core.

```bash
npm install @redact-secret/core @redact-secret/adapter-pino pino
```

`createRedactingHooks` is new in `0.1.2`; `0.1.1` exports the two hooks
separately (install both), and `0.1.0` has no `streamWrite` hook at all.

## Example

<!-- smoke-test:example -->
```js
import pino from "pino";
import { createRedactingHooks } from "@redact-secret/adapter-pino";

// Synthetic, revoked-shaped values only — never a real credential.
const token = "ghp_SYNTHETICREVOKED00000000000000000000";

const logger = pino(
  {
    base: null,
    timestamp: false,
    hooks: await createRedactingHooks(), // both hooks: the complete boundary
    redact: ["req.headers.authorization"], // pino's own path-based redact still applies, on top
    mixin: () => ({ requestId: "req-42" }),
    serializers: { req: (req) => ({ auth: req.auth }) },
  },
  { write: (line) => void process.stdout.write(line) },
);

logger.child({ session: token }).info({ req: { auth: `Bearer ${token}` } }, "deploy with token %s", token);
// {"level":30,"session":"<SECRET_1>","requestId":"req-42","req":{"auth":"Bearer <SECRET_1>"},"msg":"deploy with token <SECRET_1>"}
```

The clean-install smoke test (`npm run smoke-test`) runs this block verbatim
from a throwaway project outside the repository, against the real core, and
inspects the bytes that reach the destination.

pino's own `redact` option censors by object *path*. It cannot see a token
inside a message string or an error message. This adapter redacts by *value*,
alongside that mechanism rather than instead of it.

An `ok`-looking line is not proof the input held no secret: detection belongs
to the core and is not complete.

## Why both hooks

`createRedactingHooks` installs `hooks.logMethod` **and**
`hooks.streamWrite`, because neither covers the other's input:

| Hook | Sees | Does not see |
| --- | --- | --- |
| `logMethod` | a call's own arguments — message, interpolation values, merging object, `Error`s — before pino merges, serializes, formats or writes anything | child-logger bindings (`logger.child({ … })`, `setBindings`), `mixin()` output |
| `streamWrite` | the finished JSON line: every string value in it, whatever produced it (bindings, `mixin()`, serializers, `base`) | a value before the host's own serializers, `formatters` and `redact` run on it |

With `logMethod` alone, a secret in a child binding or in `mixin()` output
reaches the destination **in plaintext**: pino serializes bindings once when
the child is created, and merges `mixin()` after the hook returns. With
`streamWrite` alone, raw values still reach the host's own serializers and
formatters first, and object *keys* are never scanned by either hook.

The cost of the pair is that each line's strings are scanned twice — once as
call arguments, once as line values. That is deliberate and is why the hooks
stay separately exported: an application that knowingly uses no child
bindings, `mixin()` or `base`, and wants one scan, can install
`createRedactingLogMethod()` alone and own that boundary.

## Composing with your own hooks

Pass the `hooks` object the application would otherwise have given `pino()`:

```js
const logger = pino({
  hooks: await createRedactingHooks({ hooks: myHooks }), // composed, not replaced
});
```

**Redaction always runs last, closest to the bytes.** Your `logMethod` runs
first and the redacting hook runs immediately before pino's own `method`, so
arguments your hook adds or rewrites are scanned too; a hook that never calls
`method` still drops the record, exactly as before. Your `streamWrite` runs
first on pino's line and the redacting hook masks what it returns, so fields
your hook adds are scanned too.

Only `logMethod` and `streamWrite` are composed. Any other key on the object
is forwarded to pino unchanged — not covered, and not silently dropped. A
`hooks.logMethod` or `hooks.streamWrite` that is not a function is a
`TypeError` at setup rather than a silent replacement.

Two things still run after the last scan and are outside this boundary: a
`destination` or transport that adds text of its own, and a hook you wrap
*around* the composed pair by hand. A custom hook placed there can introduce
new plaintext after sanitation.

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
failure produces `[REDACTED:ERROR]`. A line `streamWrite` cannot lex fails
closed to `{"msg":"[REDACTED:ERROR]"}` rather than being written as is. See
[`@redact-secret/adapter`](../adapter#fail-closed-markers) for all markers and
limits.

## Exports

| Export | Purpose |
| --- | --- |
| `createRedactingHooks(options?)` | Live: awaits the core's `initialize()`, returns `{ logMethod, streamWrite }` for `pino({ hooks })` — the complete boundary in one step |
| `createRedactingHooksWith(scanAndRedact, options?)` | The same pair over an injected scanner |
| `createRedactingLogMethod(options?)` | Live: one `hooks.logMethod`. Not the complete boundary on its own |
| `createRedactingStreamWrite(options?)` | Live: one `hooks.streamWrite`. Not the complete boundary on its own |
| `createRedactingLogMethodWith(scanAndRedact, options?)` | The `logMethod` hook over an injected scanner |
| `createRedactingStreamWriteWith(scanAndRedact, options?)` | The `streamWrite` hook over an injected scanner |
| `formatPinoMessage(fmt, values)` | Internal: the port of pino's message formatter the hook joins with. Kept for compatibility, not a supported API |

`options` is `{ policy, limits }` for the single-hook factories, and
`{ policy, limits, hooks }` for the pair.

## Supported pino versions

`pino ^10.0.0`, verified by a real `pino` logger writing to a captured stream,
run in CI at both ends of that range. pino `9.x` is deliberately not in the
range: it may work; it is not tested, so it is not claimed.

pino is imported as a type only — it never enters this package's runtime graph.

## License

MIT
