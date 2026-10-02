# Preparing a support summary

Reporting a problem goes faster with the versions in front of you. The support
summary is a local command that prints them, in a fixed shape, for you to
review and paste into an issue. It uploads nothing, sends no telemetry and
opens no issue for you.

```sh
# From the project that has the packages installed:
node path/to/support-summary.mjs --adapter adapter-ai-context --outcome blocked --outcome core_error
```

The tool is [`scripts/support-summary.mjs`](../scripts/support-summary.mjs), a
single file with no dependencies, plus its schema
[`scripts/support-summary.schema.json`](../scripts/support-summary.schema.json).
In a clone of this repository, `npm run support-summary -- --help` runs it too.

**Why a script and not a published package or a `bin`.** Every package here is
a runtime dependency of someone's logging, tracing or AI path, and the
[security boundary](../ARCHITECTURE.md#security-boundary) forbids an adapter
from doing filesystem or environment work. A support tool has to read
`node_modules`, so it does not belong inside one. Repository scripts
(`scripts/`) are where the repo keeps its other operator tools, and a single
copyable file keeps it out of anyone's dependency tree. If demand shows a
published form is worth the cost, it would be its own package, not a function
in an adapter.

## What it prints

| Field | Source |
| --- | --- |
| `runtime` | Node version, platform and architecture, from `process` |
| `installed` | the `version` of `node_modules/<name>/package.json` for a fixed list of `@redact-secret/*`, pino, OpenTelemetry and MCP packages, found from the current directory upwards; `not_found` when absent |
| `python` | with `--python`, the Python version and two package versions from `importlib.metadata` |
| `adapter` | `--adapter`, one of a fixed list of ids |
| `outcomes` | `--outcome`, fixed codes only: `ok`/`blocked`/`aborted`, block reasons, readiness statuses and core error codes |
| `activation` | `--activation`, the core's PII activation identity, if you have it. Never read for you: the tool does not load or initialize the core |
| `reference` | release versions from the generated `site-feed/v1/adapters.json`, with its `generatedAt` date |

Every value is validated (SemVer strings, enums, fixed code lists) before it is
printed, and anything else is dropped. The tool never reads environment
variables into the output, and never prints input, logs, exception messages,
paths, hostnames, raw configuration or any serialized object. An invalid
argument is refused with a fixed message that does not repeat it. The schema is
explicit and closed (`additionalProperties: false`).

`reference` is generated release data, not your install. It shows which versions
this repository last released and when that data was generated; the summary
sets it beside what you have (`same_as_reference`, `differs_from_reference`,
`no_reference`). It does not say a combination is supported or tested. It works
offline; when the script was copied out of the repository the feed is simply
`unavailable`.

To get the activation identity and a fixed status for AI-context, use the
[readiness check](../packages/adapter-ai-context/README.md#is-it-ready-an-explicit-readiness-check)
and pass the `status` as `--outcome`. This tool does not run it.

## Where to send it

| Your problem | Report it to |
| --- | --- |
| A secret was missed, or text was masked that should not have been | [redact-secret/redact-secret](https://github.com/redact-secret/redact-secret/issues) |
| An adapter failed to initialize, blocked unexpectedly, or misbehaved in its host | [this repository](https://github.com/redact-secret/redact-secret-adapters/issues) |
| A benchmark result is disputed | [redact-secret-benchmarks](https://github.com/redact-secret/redact-secret-benchmarks/issues) |
| A suspected vulnerability | privately, via the [security advisory form](https://github.com/redact-secret/redact-secret-adapters/security/advisories/new); see [SECURITY.md](../SECURITY.md) |

Use the repository's issue form where it has one, and keep this summary as the
environment section. Reproduce with synthetic values only; never paste a real
credential, a production log or customer data.

## Example

```sh
node scripts/support-summary.mjs --adapter adapter-ai-context --outcome blocked --outcome core_error
```

A copyable issue for a fail-closed AI-context boundary, filed against this
repository because it is an integration failure:

````markdown
**Title:** ai-context: every operation returns blocked / core_error after startup

**Problem:** `createAiContextBoundary()` resolves, but `sanitizeText` returns
`blocked` / `core_error`. `checkAiContextReady()` reports `initialization_failed`.

**Environment:**
```json
{ "schema": "redact-secret-adapters.support-summary/v1", "adapter": "adapter-ai-context", "outcomes": ["blocked", "core_error"], "...": "paste the full output" }
```

**Reproduction (synthetic only):** `sanitizeText("ghp_SYNTHETICREVOKED00000000000000000000")`
````
