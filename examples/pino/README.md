# pino quickstart

Keeps a synthetic token out of a [pino](https://github.com/pinojs/pino) log line.
No model, exporter, account or key is involved.

- Runtime: Node.js 20, 22 or 24 (ESM).
- Installs: `@redact-secret/adapter-pino` 0.1.3, `@redact-secret/core` 0.1.0-beta.12, `pino` 10.3.1.
- Files: `app.mjs` is the whole quickstart. `check.mjs` runs it and checks the bytes it wrote.

## Run it

Copy this folder out of the repository first (see [how](../README.md#run-one)), then:

```sh
npm install
npm start
```

## The code

<!-- snippet: examples/pino/app.mjs -->
```js
import { createRedactingHooks } from "@redact-secret/adapter-pino";
import pino from "pino";

// Synthetic, revoked-shaped value only. Never put a real credential in an example.
const token = "ghp_SYNTHETICREVOKED00000000000000000000";

const logger = pino({ base: null, timestamp: false, hooks: await createRedactingHooks() });

logger.child({ session: token }).info("deploy with token %s", token);
```

`base: null` and `timestamp: false` only keep the output short and stable. The one
line that matters is `hooks: await createRedactingHooks()`.

## Expected output

<!-- expected-output -->
```text
{"level":30,"session":"<SECRET_1>","msg":"deploy with token <SECRET_1>"}
OK: the synthetic token never reached the log output
```

The first line is what pino wrote to stdout. The last line is the success
indicator: `check.mjs` found the exact redacted line and no trace of the token. On
failure it prints `FAIL: ...` with no log content and exits 1.

## Next

- Check **your own** logger and destination: [`placement-js`](../placement-js).
- Something other than the output above, such as `[REDACTED:ERROR]`:
  [troubleshooting](../../docs/troubleshooting.md).
- All options: [adapter-pino guide](../../packages/adapter-pino#readme).
