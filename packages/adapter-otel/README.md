# @redact-secret/adapter-otel

[![npm version](https://img.shields.io/npm/v/@redact-secret/adapter-otel)](https://www.npmjs.com/package/@redact-secret/adapter-otel)
[![deprecated](https://img.shields.io/badge/status-deprecated-orange)](https://www.npmjs.com/package/@redact-secret/adapter-otel-trace)
[![npm downloads](https://img.shields.io/npm/dm/@redact-secret/adapter-otel)](https://www.npmjs.com/package/@redact-secret/adapter-otel)
[![Node.js](https://img.shields.io/node/v/@redact-secret/adapter-otel)](https://www.npmjs.com/package/@redact-secret/adapter-otel)
[![types included](https://img.shields.io/npm/types/@redact-secret/adapter-otel)](https://www.npmjs.com/package/@redact-secret/adapter-otel)
[![CI](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml/badge.svg?branch=develop)](https://github.com/redact-secret/redact-secret-adapters/actions/workflows/ci.yml)
[![OpenSSF Scorecard](https://api.scorecard.dev/projects/github.com/redact-secret/redact-secret-adapters/badge)](https://scorecard.dev/viewer/?uri=github.com/redact-secret/redact-secret-adapters)
[![License: MIT](https://img.shields.io/npm/l/@redact-secret/adapter-otel)](https://github.com/redact-secret/redact-secret-adapters/blob/main/LICENSE)

> **Deprecated name.** This package is now
> [`@redact-secret/adapter-otel-trace`](https://www.npmjs.com/package/@redact-secret/adapter-otel-trace).
> Existing imports keep working, because this package re-exports the new one
> unchanged. New code should use the new name.

It only ever covered OpenTelemetry **traces**. It does not protect
OpenTelemetry Logs, under either name.

## Switch in two steps

```sh
npm uninstall @redact-secret/adapter-otel
npm install @redact-secret/adapter-otel-trace
```

```diff
-import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel";
+import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";
```

Nothing else changes. Usage stays the same:

```js
import { NodeTracerProvider, BatchSpanProcessor } from "@opentelemetry/sdk-trace-node";
import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";

const provider = new NodeTracerProvider({
  spanProcessors: [await createRedactingSpanProcessor(new BatchSpanProcessor(exporter))],
});
```

Documentation, options, outcome counters and supported versions:
[`@redact-secret/adapter-otel-trace`](https://github.com/redact-secret/redact-secret-adapters/tree/main/packages/adapter-otel-trace#readme).

## Migrating to `@redact-secret/adapter-otel-trace`

The new package's `0.1.0` is the code this package shipped as `0.1.2`: the same
`createRedactingSpanProcessor`, `RedactingSpanProcessorWith`,
`redactAttributesWith`, options, outcome shape, fail-closed markers and peer
ranges (`@opentelemetry/sdk-trace-base ^2.0.0`, `@redact-secret/core
^0.1.0-beta.6`). Swap the dependency and the import specifier as shown above.

## What this package still does

Every release of this package after `0.1.2` depends on
`@redact-secret/adapter-otel-trace` `^0.1.0` and re-exports it:

- The same functions and the same `RedactingSpanProcessorWith` class object, so
  `instanceof` holds across both names and a processor built through one works
  anywhere the other is expected.
- Every export is marked `@deprecated` in its type declarations, which editors
  show as a strikethrough. Nothing is printed at import or call time; the
  package stays side-effect free.
- The same peer ranges, so an install that resolved before still resolves.

`test/compat-shim.test.ts` checks the export list and identity against the new
package and runs a real `BasicTracerProvider` span through both names, reading
the OTLP JSON bytes the exporter would send. The clean-install smoke test
(`npm run smoke-test`) does the same from packed tarballs outside the
repository, and against the `@redact-secret/adapter-otel` release currently on
npm.

## License

MIT
