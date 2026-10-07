# Compatibility

What each package supports, how that is tested, and what is not claimed.

The currently published version of each package is on its registry page and
in its `CHANGELOG.md`. A prerelease publishes under the npm dist-tag `alpha`,
never `latest`, so it is opt-in by tag or exact version. pip skips a
pre-release unless asked for one.

## Supported host versions

A published adapter states the host range it supports and runs a test against
a real instance of that host. The range is not a guess: it is what CI installs
and exercises, at both ends of the declared range.

| Adapter | Declared range | Verified by |
| --- | --- | --- |
| `adapter-pino` | `pino ^10.0.0` | a real `pino` logger: captured stream, sonic-boom async destination, worker-thread transport, concurrent loggers, a failing destination |
| `adapter-otel-trace` | `@opentelemetry/sdk-trace-base ^2.0.0` | real spans through `SimpleSpanProcessor` and `BatchSpanProcessor`, the OTLP JSON bytes the exporter sends, concurrent spans, a failing exporter, flush and shutdown. Traces only |
| `adapter-otel-logs` (**beta**: `0.1.0-beta.2` on npm under `beta`; needs `@redact-secret/adapter` `^0.1.7`, published in the next train, so not installable until then) | `@opentelemetry/sdk-logs >=0.200.0 <=0.222.0` | real log records through `SimpleLogRecordProcessor` and `BatchLogRecordProcessor` on a real `LoggerProvider`, the OTLP JSON bytes the exporter sends, structured and byte bodies, exceptions, Unicode, PII off and on on the real core, injected scanner failures, a failing exporter, a record the SDK already made read-only, flush and shutdown. Logs only: not spans, not metrics, not the resource or the instrumentation scope |
| `adapter-otel` (deprecated name) | `@opentelemetry/sdk-trace-base ^2.0.0` | the same export list and objects as `adapter-otel-trace`, and the same OTLP JSON bytes for one span; the clean-install smoke test also compares the release on npm |
| `redact-secret-adapters` (`logging`) | CPython `>=3.10` stdlib | a real `logging.Logger`: filter before formatter, `QueueHandler`/`QueueListener`, threads sharing one handler, a failing handler |
| `redact-secret-adapters[otel]` | `opentelemetry-sdk>=1.16.0,<2` | real spans through simple and batch processors, spans from threads, a failing exporter, flush and shutdown |
| `adapter-ai-context` | `@redact-secret/core ^0.1.0-beta.6` (no host) | the core's AI-context conformance fixture replayed on the real core before and after `initialize()`, and an end-to-end agent turn with every limit |
| `adapter-mcp` | `@modelcontextprotocol/sdk >=1.26.0 <=1.30.1`, `@modelcontextprotocol/client`/`server >=2.0.0 <=2.1.0` | the core's MCP fixture and runner replayed through the public API and over real SDK clients and servers (stdio and Streamable HTTP, protocol 2025-11-25); a host that logs, stores and builds context only from the boundary's output |

Runtimes: Node.js 20.x, 22.x and 24.x; CPython 3.10 through 3.14.

## Platforms and artifacts: tested, versus core-only

The core supports more platforms than these adapters test, and the core's own
CI owns that matrix. What this repository adds is a small set of
adapter-and-host checks per platform and per core artifact, so a statement
here means an adapter ran there, not only that the core did.

| Combination | Status | Evidence |
| --- | --- | --- |
| Node 20, 22, 24 on Linux x64 (glibc), native addon | Tested | The whole suite and both range endpoints, every push (`ci.yml`: `node`, `range-endpoints`) |
| Node 22 on Linux x64, **WebAssembly fallback** | Tested | `npm run smoke-test:platform -- parity`: a clean install of the packed packages with `omit=optional`, so no platform addon is installed and `initialize()` falls back. The probe asserts `core.artifact() === "wasm"` (and `"addon"` in the addon lane), then compares the sanitized outputs of both lanes document for document, PII off and on |
| macOS (arm64 runner) and Windows (x64 runner), Node 24, native addon | Tested | `platform-smoke` in `ci.yml`: the packed packages installed outside the workspace, every public factory run against its real host (pino, `sdk-trace-base`, `sdk-logs`, the MCP boundary), `artifact() === "addon"` asserted |
| `adapter-ai-context` bundled for a browser | Tested, narrowly | `npm run smoke-test:browser`: a clean install bundled with esbuild (`platform: "browser"`), run on Node's WebAssembly engine with the core's `.wasm` served as an application would serve it; `artifact() === "wasm"` asserted; Unicode, key-aware values, every stream split, limits, block, PII off and on |

The equivalence the parity check holds for the shared synthetic cases: the
same findings with the same code-unit offsets, the same redacted text, the
same `blocked` and `limit_exceeded` outcomes and fixed error codes, for Unicode
ranges (Korean, astral emoji, combining marks, right-to-left text, a NUL, an
invisible character inside a token), key-aware structured values, and an
incremental stream split at every position (a split inside a surrogate pair is
the one boundary the core refuses, with `UNPAIRED_SURROGATE`, in both lanes).

**Not qualified** (the adapters may work; nothing here shows it, and no claim
is made):

- the WebAssembly fallback on macOS or Windows, on Node 20 or 22 for the
  platform legs, or via a cause other than the missing addon package (an
  unloadable addon, an unsupported platform such as an old glibc or musl);
- Linux arm64, musl, and Windows arm64 for any adapter, and macOS x64;
- Node 20 and 22 on macOS and Windows, which the core supports;
- a real browser (Chrome, Firefox, Safari), any bundler other than esbuild
  (Vite, webpack, Rollup), Cloudflare Workers, Deno, Bun, and a framework's SSR
  build, for `adapter-ai-context` and for every other package;
- the browser for `adapter`, `adapter-pino`, `adapter-otel-trace`,
  `adapter-otel-logs` and `adapter-mcp`: they are Node integrations and are not
  claimed for a browser. (`adapter-ai-context` imports nothing from Node and is
  the only package intended for a browser bundle; it is what the check above
  qualifies.)

CI cost is deliberately bounded: Windows and macOS each run one job once per
pull request on the newest Node, in the addon lane only; the WebAssembly and
browser checks are two extra steps in the existing Ubuntu install-smoke job;
and the core's own native-artifact matrix is not repeated.

[`compatibility.json`](../compatibility.json) is the machine-readable form of
this table: every declared range, the endpoints CI installs, the runtimes it
exercises, and the test files that qualify each package.
`npm run compat:check` fails CI when the record, the manifests, and `ci.yml`
disagree.

## Core versions

Every package declares `@redact-secret/core` / `redact-secret` `0.1.0-beta.6`
or later. `0.1.0-beta.12` / `0.1.0b12` is the newest, and is what the examples
are verified against. `0.1.0-beta.6` is the floor, and CI runs the real-host
tests at both.

- Passing `pii` to a factory needs `0.1.0-beta.10` or later, the release that
  added opt-in PII detection. Everything else works at the floor.
- From beta.11 the core loads its PII runtime only when `initialize({ pii })`
  names a selector, which needs nothing from the adapters.

The core is released in lockstep across Rust, npm, PyPI and the CLI. These
packages are not part of that lockstep: a new pino release moves
`adapter-pino` and nothing else.

## A range and a tested endpoint are different claims

The range says what installs. `endpoints` in `compatibility.json` names the
two versions CI actually installs and runs the real-host tests against, and
the semver expression between them is **not** evidence that every version
inside it was tested. As of 2026-10-07 the core endpoints are `0.1.0-beta.6`
and `0.1.0-beta.14` (`0.1.0b6` and `0.1.0b14` on PyPI).

A newer core does not narrow the floor: a range is raised only when a package
needs an API a lower core lacks, which the `published-combination` job
enforces. A core version that is announced but not yet on the registry
qualifies nothing;
[RELEASING.md § Qualifying a new core release](../RELEASING.md#qualifying-a-new-core-release)
is the procedure.

`qualifiedBy` in that record lists the tests that make an endpoint evidence,
and it is deliberately narrower than "the tests that cover this package". A
test that injects or mocks the core proves nothing about either endpoint, so
it is not listed there however thorough it is. Most of the activation tests
are exactly that: a real core's PII selection is process-wide and one-shot, so
a single test worker can exercise one ordering against it. The two that do run
against a real core, one ordering per spawned process
(`packages/adapter/test/activation-live.test.ts` and
`python/tests/test_pii_activation.py`), are listed.

## Combinations that are not claimed

| Combination | Status |
| --- | --- |
| Core between the two endpoints, e.g. `0.1.0-beta.8` or `0.1.0-beta.10` | Installs; inside the declared range but not an endpoint CI runs. Not claimed. |
| Core below `0.1.0-beta.6` | Refused at install (`ERESOLVE`, or pip). |
| A factory's `pii` option on a core below `0.1.0-beta.10` | Refused at runtime with a fixed code. Omitting `pii` works at the floor. |
| `@redact-secret/vault` `0.1.0-beta.1` with core `0.1.0-beta.11` or later | Peer conflict: the vault pins `0.1.0-beta.10` exactly. Its own bump is tracked in the vault repository. |
| pino `9.x` | Deliberately not in the declared range. It may work; it is not tested, so it is not claimed. |

An unqualified host is either refused at install time or listed as
unqualified:

- **Refused.** An out-of-range `pino`, `@opentelemetry/sdk-trace-base` or
  `@redact-secret/core` stops `npm install` with `ERESOLVE`, unless you
  override it with `--legacy-peer-deps` or `--force`. pip refuses an
  `opentelemetry-sdk` or `redact-secret` outside the declared range, and any
  CPython older than 3.10.
- **Documented, not refused.** Node.js outside 20.x, 22.x and 24.x (`engines`
  only warns) and CPython 3.15 or later install but are not tested.

## The vault

`@redact-secret/vault` `0.1.0-beta.1`, from the sibling
[`redact-secret-vault`](https://github.com/redact-secret/redact-secret-vault)
repository, pins the core to `0.1.0-beta.10` exactly. An application that
installs it alongside these adapters and moves to a newer core hits a peer
conflict, not because either range is wrong but because the pins have not yet
met. Nothing here depends on the vault, and an adapter release does not wait
on it.

How the two compose at runtime (capture first, adapters after, never route a
restored value to a log or span):
[ARCHITECTURE.md § The vault boundary](../ARCHITECTURE.md#the-vault-boundary).

## What the adapters use from the core

The logging and tracing packages depend on a deliberately small part of the
core: `initialize()`, `scanAndRedact()` and its result shape, and whether a
finding's action is `block` or `warn`. They also pass through, only when the
caller asks, the core's own `scanAndRedact` options `limits` (as `scanLimits`),
`ruleset`, `placeholderFormatter` and the declarative `actionPolicy`, and in that
case read the core's `VERSION` once to check it against the version each option
was verified against (`0.1.0-beta.6` for the first three, the declared floor;
`0.1.0-beta.14` for `actionPolicy`, the first published core that accepts it),
so an older core rejects the option instead of ignoring it, and every other
option keeps working there; with none of them asked, nothing extra is read
or passed. The AI-context package also uses the
whole-input `policy`/`limits` options, the incremental session,
`SecretScanError.code`, and the safe finding fields
([ARCHITECTURE.md § The core contract](../ARCHITECTURE.md#the-core-contract)).

That surface is what the declared range protects. Because these packages are
written in TypeScript against the core's own exported types, a change to it
fails the build rather than degrading silently.
