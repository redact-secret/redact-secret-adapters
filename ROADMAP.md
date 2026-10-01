# Roadmap

What the adapters intend to do over the next year, and what they intend not
to do. Dates are targets, not promises. Issues are the authoritative
tracking; this page is reviewed with every release train. Last reviewed:
2026-10-01.

## Near term (Q4 2026)

- **Follow the core to stable `v0.1.0`.** Widen each package's declared
  `@redact-secret/core` range to the stable release once the range-endpoint
  CI qualifies it, and drop prerelease-only core pins
  ([core roadmap](https://github.com/redact-secret/redact-secret/blob/main/ROADMAP.md)).
- **Graduate the prerelease adapters.** Move `adapter-ai-context` and
  `adapter-mcp` from the `alpha` dist-tag to `latest` once their contracts
  have stayed unchanged through a stable core release.
- **Plan the retirement of `@redact-secret/adapter-otel`**, the deprecated
  re-export of `adapter-otel-trace`, and announce it ahead of time.

## Later in the year

- **Keep host ranges current**: qualify new pino, OpenTelemetry, and MCP SDK
  releases as they ship; a range only widens when CI tests it.
- **OpenTelemetry logs**: `adapter-otel-logs`, a `LogRecordProcessor`, is
  implemented and qualified against a real SDK on `develop` but unreleased;
  releasing it (and a Python equivalent, which is a separate scope) is the
  remaining work ([#178](https://github.com/redact-secret/redact-secret-adapters/issues/178)).
- **MCP beyond `tools/call` and `resources/read`**, as the core's MCP
  contract grows to cover more message types.
- **Python**: track the core's Python binding and keep `logging` parity with
  the npm packages.
- **Supply chain**: keep OpenSSF Best Practices and Scorecard results
  current, and keep every published package signed.

## Not planned

Detection logic of any kind (it belongs to the core), restoration (it belongs
to `@redact-secret/vault`), model-vendor client wrappers, LangChain, and a
Langfuse package. [ARCHITECTURE.md § Deliberate exclusions](ARCHITECTURE.md#deliberate-exclusions)
gives the reason for each.

## Proposing changes

Open an issue. Roadmap changes are decided as described in
[GOVERNANCE.md](GOVERNANCE.md#how-decisions-are-made).
