# @redact-secret/adapter

The shared base for [Redact Secret](https://github.com/redact-secret/redact-secret)
host adapters: mask one string, or walk a value tree and mask every string in
it, failing closed on every error path.

It contains no detection. The scanner is **injected**: this package has no
dependencies of its own, and `@redact-secret/core` is a peer dependency — the
one copy your application installs and initializes. Its type declarations
import the core's types, so the peer is required, not optional.

Install it directly only when building your own integration;
`@redact-secret/adapter-pino` pulls it in automatically.

```bash
npm install @redact-secret/core @redact-secret/adapter
```

## Masking callbacks (Langfuse and similar)

```js
import { createMaskSecrets } from "@redact-secret/adapter";

const maskSecrets = await createMaskSecrets();
const langfuse = new Langfuse({ mask: ({ data }) => maskSecrets(data) });
```

`createMaskSecrets` is the one export that loads `@redact-secret/core` at
runtime. It imports the core on call, awaits `initialize()`, and returns
`(data) => masked`.

## Injected API

```js
import { initialize, scanAndRedact } from "@redact-secret/core";
import { maskLeafWith, maskSecretsWith, maskLogValueWith } from "@redact-secret/adapter";

await initialize();
maskLeafWith(scanAndRedact, "one string");
maskSecretsWith(scanAndRedact, { any: ["plain", "tree"] });
maskLogValueWith(scanAndRedact, { err: new Error("also walks Errors") });
```

| Export | Purpose |
| --- | --- |
| `maskLeafWith(scan, text, { policy, maxStringLength })` | Mask one string |
| `maskSecretsWith(scan, data, { policy, limits })` | Walk a value tree and mask every string in it (see below) |
| `maskLogValueWith(scan, data, { policy, limits })` | The same walk, under its logging-side name |
| `createMaskSecrets({ policy, limits })` | Live wrapper over the real core |
| `ScanAndRedact` | The injected scanner's type |

The walk returns a masked copy of everything JSON serialization would emit:

- plain objects and arrays, recursively;
- an `Error` as `{ type, message, stack, ...ownProps, cause }`, every string
  in it masked (an axios error's `config.headers` included);
- an object with a `toJSON()` method (`Date`, `URL`, `Buffer`, …) as its
  masked `toJSON()` result;
- any other object (class instances, `IncomingMessage`, …) as a plain object
  of its masked own enumerable properties.

Numbers, booleans, `null`, `undefined`, bigints and functions pass through. A
getter or `toJSON()` that throws becomes `[REDACTED:ERROR]` for that value; the
walk itself never throws.

## Fail-closed markers

Public API; they change only in a major version.

| Marker | When |
| --- | --- |
| `BLOCK_MARKER` `[REDACTED:BLOCKED]` | A `block` finding — the **entire** leaf is replaced |
| `ERROR_MARKER` `[REDACTED:ERROR]` | Any throw or malformed result from the core, or a value that cannot be read. Never the input, never the error's message |
| `LIMIT_MARKER` `[REDACTED:LIMIT_EXCEEDED]` | A value past a walk budget; never scanned, never passed through |
| `CYCLE_MARKER` `[REDACTED:CYCLE]` | A self-referencing object |

`DEFAULT_LIMITS`: `maxDepth` 8, `maxArrayLength` 1000, `maxObjectKeys` 200,
`maxStringLength` 200000, `maxTotalLeaves` 5000. Elements and keys beyond a
limit are dropped, not passed through.

## License

MIT
