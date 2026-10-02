# Examples

Small projects you can run with nothing but Node.js or Python. Each one installs
**released** packages from the registry at exact versions, uses only synthetic
values, and needs no API key, account, model or network service beyond the
package registry.

| Example | Shows | Runtime |
| --- | --- | --- |
| [`pino`](./pino) | The quickstart: a synthetic token never reaches a pino log line | Node.js 20, 22 or 24 |
| [`python-logging`](./python-logging) | The quickstart: a synthetic token never reaches a Python `logging` handler | Python 3.10+ |
| [`ai-context`](./ai-context) | The quickstart: a model context built without calling a model | Node.js 20, 22 or 24 |
| [`placement-js`](./placement-js) | Verify **your** pino and OpenTelemetry output path, with negative controls | Node.js 20, 22 or 24 |
| [`placement-python`](./placement-python) | Verify **your** Python handlers and OpenTelemetry output path, with negative controls | Python 3.10+ |
| [`policy-js`](./policy-js) | The same input under credentials-only, PII activated, and an explicit policy | Node.js 20, 22 or 24 |
| [`policy-python`](./policy-python) | The same comparison for Python `logging` | Python 3.10+ |

## Run one

An example is a consumer project, not a workspace package. Copy it out of the
repository and run it there, so it installs from the registry and never from
this checkout:

```sh
git clone --depth 1 https://github.com/redact-secret/redact-secret-adapters.git
cp -r redact-secret-adapters/examples/pino my-example
cd my-example
npm install        # Python examples: python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
npm start          # Python examples: .venv/bin/python check.py   (or main.py, as the example says)
```

Do not run `npm install` inside the clone: the repository root links its own
packages, which is contributor setup, not what a consumer gets.

Every example ends with a line starting `OK:` and exits 0 on success. On failure
it prints a line starting `FAIL:` and exits non-zero. The failure message names
what failed and never includes the log line, span or context it checked.

## Which versions, and why

The pins are the latest **released** combination that was verified, not the
newest code in this repository:

- npm: `@redact-secret/core` `0.1.0-beta.12` (a beta; the core has no stable
  release yet, so it is pinned explicitly), `@redact-secret/adapter-pino`
  `0.1.3`, `@redact-secret/adapter-otel-trace` `0.1.1`,
  `@redact-secret/adapter-ai-context` `0.1.2`, `pino` `10.3.1`,
  `@opentelemetry/sdk-trace-base` `2.11.0`.
- PyPI: `redact-secret` `0.1.0b12` (a beta, so `pip` needs the exact pin),
  `redact-secret-adapters` `0.1.3`, `opentelemetry-sdk` `1.45.0`.

Newer repository features are not used here until they are published. The
[policy examples](./policy-js#options-this-example-does-not-use) say which.

## How CI keeps them true

- `npm run examples:check` fails when a code block in a README differs from the
  executable source it is marked with (`<!-- snippet: path#region -->`), when a
  manifest is not pinned to exact versions, or when the root README imports a
  package that no install line in it installs.
- `npm run examples:run` copies each example to a fresh directory outside the
  checkout, installs from the registry, runs it, and compares its output with
  the expected output printed in its README.
