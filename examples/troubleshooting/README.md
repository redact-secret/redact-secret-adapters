# Fail-closed outcomes, reproduced and corrected

Each case below triggers one fail-closed outcome of the AI-context boundary (or a pino marker)
with a synthetic input, then applies the smallest safe correction and shows the `ok` result.
The reference is [docs/troubleshooting](../../docs/troubleshooting.md); this folder is the
proof that its corrections work against released packages.

- Runtime: Node.js 22 or 24 (ESM).
- Installs: `@redact-secret/adapter-ai-context` 0.1.6, `@redact-secret/adapter-pino` 0.1.7, `@redact-secret/core` 0.1.0-beta.14, `pino` 10.3.1.
- Needs no network service and no credentials. Nothing here is a secret.

## Run it

Copy this folder out of the repository first (see [how](../README.md#run-one)), then:

```sh
npm install
npm start
```

## Expected output

<!-- expected-output -->
```text
ok   Date value                         blocked/unsupported_value  Input held a value that is not JSON-shaped.
ok   Date as ISO string                 ok                         Sanitized value available.
ok   Input over maxInputBytes           blocked/limit_exceeded     Input is over a configured limit. (INPUT_LIMIT_EXCEEDED)
ok   Same input, a roomier limit        ok                         Sanitized value available.
ok   Partial limit set                  blocked/core_error         The redaction core failed, is not initialized, or rejected an option. (INVALID_OPTIONS)
ok   Lone surrogate                     blocked/core_error         The redaction core failed, is not initialized, or rejected an option. (UNPAIRED_SURROGATE)
ok   Well-formed text                   ok                         Sanitized value available.
ok   Stream over its input limit        blocked/limit_exceeded     Input is over a configured limit. (INPUT_LIMIT_EXCEEDED)
ok   Stopped reading at the failure     2 of 3 chunks read
ok   First finalize                     ok                         Sanitized value available.
ok   Second finalize                    blocked/lifecycle          A stream was reused or misused.
ok   Already-aborted signal             aborted                    The operation was cancelled.
ok   Core throws                        blocked/core_error         The redaction core failed, is not initialized, or rejected an option.
ok   Error message is suppressed        not in the outcome
ok   pino: over maxStringLength         marker, then a bounded field
ok   Unknown reason                     We could not process this request.
OK: every outcome matched its documented cause and correction
```

Each row is `ok` when the outcome matched its documented cause. The last line is the success
indicator. On failure the script prints `FAIL:` and exits 1, without printing any input.
The third column is the application-facing message from [`messages.mjs`](./messages.mjs), made
only of fixed labels and an allowlisted `code`.

## Unsupported value

A value that is not JSON-shaped is refused, never converted for you.

<!-- snippet: examples/troubleshooting/index.mjs#unsupported -->
```js
check("Date value", boundary.sanitizeValue({ when: new Date(0) }), "blocked/unsupported_value");
// Fix: convert deliberately, so what is scanned is exactly what you send. Omit `undefined` fields.
check("Date as ISO string", boundary.sanitizeValue({ when: new Date(0).toISOString() }), "ok");
```

## A limit is exceeded

Nothing is truncated and nothing passes through. Send less; if the default really is too small,
replace the complete set, starting from the defaults.

<!-- snippet: examples/troubleshooting/index.mjs#limits -->
```js
const tight = await createAiContextBoundary({
  wholeInputLimits: { maxInputBytes: 16, maxFindings: 8 }, // a COMPLETE set; see the next case
});
check("Input over maxInputBytes", tight.sanitizeText("x".repeat(100)), "blocked/limit_exceeded");
// Fix: send less (split the input, drop what the model does not need). If the default really is too
// small, replace the WHOLE set, starting from the defaults:
const roomier = await createAiContextBoundary({
  wholeInputLimits: { ...AI_CONTEXT_DEFAULT_LIMITS.wholeInputLimits, maxInputBytes: 131072 },
});
check("Same input, a roomier limit", roomier.sanitizeText("x".repeat(100)), "ok");
```

## A partial limit set

A set you pass is used exactly as given. It is not merged with the defaults.

<!-- snippet: examples/troubleshooting/index.mjs#partial -->
```js
const partial = await createAiContextBoundary({ wholeInputLimits: { maxInputBytes: 1024 } });
check("Partial limit set", partial.sanitizeText("hello"), "blocked/core_error");
```

## A lone surrogate

<!-- snippet: examples/troubleshooting/index.mjs#surrogate -->
```js
const lone = "a\ud800b";
check("Lone surrogate", boundary.sanitizeText(lone), "blocked/core_error");
// Fix: make the text well formed before scanning. The replacement character is what is scanned and sent.
check("Well-formed text", boundary.sanitizeText(lone.toWellFormed()), "ok");
```

## A stream that fails

A stream releases nothing before `finalize`. Read `accepting` after every `append`.

<!-- snippet: examples/troubleshooting/index.mjs#stream -->
```js
const stream = boundary.openStream({ boundary: "user-input" });
const chunks = ["ok ", "x".repeat(1_048_577), "never read"];
let read = 0;
for (const chunk of chunks) {
  stream.append(chunk);
  read += 1;
  if (!stream.accepting) break; // stop pulling from the producer: later chunks would be discarded
}
const streamed = stream.finalize(); // the reason arrives here, and only here
```

## Streams are single use

<!-- snippet: examples/troubleshooting/index.mjs#single-use -->
```js
const once = boundary.openStream({ boundary: "user-input" });
once.append("hello");
check("First finalize", once.finalize(), "ok");
check("Second finalize", once.finalize(), "blocked/lifecycle"); // open a new stream instead
```

## Cancellation

<!-- snippet: examples/troubleshooting/index.mjs#abort -->
```js
const controller = new AbortController();
controller.abort();
check("Already-aborted signal", boundary.sanitizeText("hello", { signal: controller.signal }), "aborted");
```

## The core throws

<!-- snippet: examples/troubleshooting/index.mjs#core-error -->
```js
const failing = {
  scanAndRedact() {
    throw new Error("a message that must never be forwarded");
  },
  createIncrementalSanitizer() {
    throw new Error("unused");
  },
};
const broken = createAiContextBoundaryWith(failing, AI_CONTEXT_DEFAULT_LIMITS);
const coreFailure = broken.sanitizeText("hello");
check("Core throws", coreFailure, "blocked/core_error");
// The outcome holds a fixed reason and no message. Treat it as a failure, never as ok.
```

## A logging marker

<!-- snippet: examples/troubleshooting/index.mjs#marker -->
```js
const small = captureLogger(await createRedactingHooks({ limits: { maxStringLength: 20 } }));
small.logger.info({ payload: "x".repeat(50) }, "received");
// Fix: do not log the whole payload. Log what you need to diagnose, which is bounded by nature.
small.logger.info({ payloadLength: 50 }, "received");
```

## Messages you can show

<!-- snippet: examples/troubleshooting/messages.mjs#messages -->
```js
// Fixed labels only. Nothing from the input, the error, a path or a key ever reaches these strings,
// and an outcome this table does not know falls back to the generic entry.
const FIXED = {
  ok: ["Sanitized value available.", ""],
  "blocked/policy": ["Blocked by redaction policy.", "We could not process this request."],
  "blocked/limit_exceeded": ["Input is over a configured limit.", "This request is too large to process safely."],
  "blocked/unsupported_value": ["Input held a value that is not JSON-shaped.", "We could not process this request."],
  "blocked/lifecycle": ["A stream was reused or misused.", "Something went wrong. Please try again."],
  "blocked/core_error": [
    "The redaction core failed, is not initialized, or rejected an option.",
    "Something went wrong. Please try again.",
  ],
  aborted: ["The operation was cancelled.", "The request was cancelled."],
};
const GENERIC = ["Unrecognised outcome; treated as blocked.", "We could not process this request."];

/** `internal` is for your logs and metrics (a trusted reader). `user` is safe to show to anyone. */
export function describeOutcome(outcome) {
  const key = outcome.outcome === "blocked" ? `blocked/${outcome.reason}` : outcome.outcome;
  const [internal, user] = Object.hasOwn(FIXED, key) ? FIXED[key] : GENERIC;
  // `code` is a fixed label from the core's registry, but only an allowlisted shape is forwarded.
  const code = typeof outcome.code === "string" && /^[A-Z_]{1,40}$/.test(outcome.code) ? ` (${outcome.code})` : "";
  return { internal: `${internal}${code}`, user };
}
```
