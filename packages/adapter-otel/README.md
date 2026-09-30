# @redact-secret/adapter-otel

> **Deprecated name.** This package is now
> [`@redact-secret/adapter-otel-trace`](https://www.npmjs.com/package/@redact-secret/adapter-otel-trace).
> It only ever covered OpenTelemetry **traces**; it does not protect
> OpenTelemetry Logs. Existing imports keep working — this package re-exports
> the new one unchanged — but new code should use the new name.

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
^0.1.0-beta.6`). Swap the dependency and the import specifier; nothing else
changes.

```sh
npm uninstall @redact-secret/adapter-otel
npm install @redact-secret/adapter-otel-trace
```

```diff
-import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel";
+import { createRedactingSpanProcessor } from "@redact-secret/adapter-otel-trace";
```

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
