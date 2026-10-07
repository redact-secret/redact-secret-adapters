# AI-context quickstart

Builds a model context from a user message and a tool result without letting a
synthetic token through. No model is called, so no key or account is involved.

- Runtime: Node.js 22 or 24 (ESM).
- Installs: `@redact-secret/adapter-ai-context` 0.1.5, `@redact-secret/core` 0.1.0-beta.14.
- Files: `app.mjs` is the whole quickstart. `check.mjs` runs it and checks what it printed.

## Run it

Copy this folder out of the repository first (see [how](../README.md#run-one)), then:

```sh
npm install
npm start
```

## The code

<!-- snippet: examples/ai-context/app.mjs -->
```js
import { createAiContextBoundary } from "@redact-secret/adapter-ai-context";

// Synthetic, revoked-shaped values only. Never put a real credential in an example.
const userText = "deploy with API_KEY=ghp_SYNTHETICREVOKED00000000000000000000";
const toolResult = { content: [{ type: "text", text: "build ok" }], exitCode: 0 };

const boundary = await createAiContextBoundary();
const context = boundary.buildContext([
  { role: "user", boundary: "user-input", text: userText },
  { role: "tool", boundary: "tool-result", value: toolResult },
]);

if (context.outcome !== "ok") {
  // `reason` and `code` are fixed labels, safe to log. There is no value to use.
  throw new Error(`context refused: ${context.outcome} ${context.reason ?? ""}`);
}

// context.value is the only thing that may go to a model. This example prints it instead of calling one.
console.log(JSON.stringify(context.value));
```

The result is `ok` with a sanitized `value`, or `blocked` / `aborted` with **no**
value at all. Only ever use `context.value` from an `ok` result. If you get
`blocked`, see [troubleshooting](../../docs/troubleshooting.md#ai-context-and-mcp-outcomes).

## Expected output

<!-- expected-output -->
```text
[{"role":"user","content":"deploy with API_KEY=<SECRET_1>"},{"role":"tool","content":{"content":[{"type":"text","text":"build ok"}],"exitCode":0}}]
OK: the synthetic token never reached the model context
```

The first line is the context you would send to a model. The last line is the
success indicator. On failure it prints `FAIL: ...` with no context content and
exits 1.

## Next

- The full outcome contract: [adapter-ai-context guide](../../packages/adapter-ai-context#readme).
- The same input with PII on, and with a policy: [`policy-js`](../policy-js).
