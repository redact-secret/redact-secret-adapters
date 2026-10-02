# Security assurance case

This document argues why the adapters' security requirements are met. It
connects the threat model, trust boundaries, secure design principles, and
common weaknesses countered, each with evidence a reviewer can check. The
core's own case — detection, ReDoS resistance, plaintext-free findings — is
[redact-secret's assurance case](https://github.com/redact-secret/redact-secret/blob/main/docs/assurance-case.md);
this one covers only what the adapters add.

## Claim

An adapter carries host data (log records, span attributes, AI context, MCP
messages) through `@redact-secret/core` and back to the host so that **no
plaintext the core would redact reaches the host through the adapter**, even
when the core errors, a budget is exceeded, or the input is cyclic or
hostile — and the adapter itself performs no network, filesystem,
environment, or telemetry work.

## Threat model

| Asset | Threat | Where handled |
| --- | --- | --- |
| Secrets inside host data | An export path that bypasses the adapter, or a value the walk never reaches | Per-host notes in [ARCHITECTURE.md § Adapter-specific notes](../ARCHITECTURE.md#adapter-specific-notes); real-SDK tests per host |
| Secrets inside host data | The core throws, or input exceeds a budget, and the original value is passed through | [Fail-closed rules](../ARCHITECTURE.md#fail-closed-rules): fixed markers replace the value |
| Adapter availability | Deep, wide, or cyclic input (attacker-shaped log objects, tool results) causing unbounded work | `maxNodes`, width, and depth limits; path-based cycle detection |
| Secrets in diagnostics | An adapter error message or counter that echoes input | Errors produce a fixed marker, never the error's message |
| Published packages | A compromised build or dependency | [Supply chain](#common-weaknesses-countered) below |

**Trust boundaries.** Host data is untrusted. The core is trusted to decide
what is a secret; an adapter never second-guesses it and is never a second
detector. The host SDK is trusted to call the adapter on every export path
the README claims, and that claim is tested against the real SDK at each end
of the declared host range. Masking callbacks supplied by the application are
trusted in-process code. Out of scope:
[SECURITY.md § Scope](../SECURITY.md#scope).

## Secure design principles

| Principle | How it is applied | Evidence |
| --- | --- | --- |
| Economy of mechanism | One shared walker (`packages/adapter`) serves every npm host adapter; host packages are thin wiring. | [ARCHITECTURE.md § The layering](../ARCHITECTURE.md#the-layering) |
| Fail-safe defaults | Core errors, budget overruns, and cycles produce `[REDACTED:ERROR]`, `[REDACTED:LIMIT_EXCEEDED]`, or `[REDACTED:CYCLE]`; `block` replaces the whole leaf; elements past a width limit are dropped, not passed through. | [Fail-closed rules](../ARCHITECTURE.md#fail-closed-rules), `packages/adapter/src/mask-leaf.ts`, `walk.ts` |
| Complete mediation | Each adapter hooks the host's single export or serialization point, so every record passes through it; the claim is tested on the real SDK. | Per-host sections of [ARCHITECTURE.md](../ARCHITECTURE.md#adapter-specific-notes) |
| Least privilege | Adapters have no I/O of their own. CI jobs hold read-only tokens; only release jobs in the `release` environment get `id-token: write`. | [Security boundary](../ARCHITECTURE.md#security-boundary), `.github/workflows/*.yml` |
| Separation of privilege | Detection and policy stay in the core; the adapter only decides how the core's answer reaches the host. | [The core contract](../ARCHITECTURE.md#the-core-contract) |
| Open design | All behavior and tests are public; nothing depends on secrecy of the adapters' logic. | This repository |

## Common weaknesses countered

| Weakness | Countermeasure | Evidence |
| --- | --- | --- |
| Information exposure through logs or errors (CWE-532, CWE-209) | Fixed markers instead of error messages; no adapter logs or attaches matched plaintext. | [Fail-closed rules](../ARCHITECTURE.md#fail-closed-rules); tests under `packages/*/test` and `python/tests` |
| Uncontrolled recursion and resource consumption (CWE-674, CWE-400) | Every visit counts against `maxNodes`; current-path cycle detection; values past a budget never reach the core. | `packages/adapter/src/walk.ts`, `walk-strict.ts`; property tests with fast-check |
| Incomplete mediation of a host path (CWE-638) | Host ranges are only as wide as the tests that run on both range endpoints. | `range-endpoints` and `python-range-endpoints` CI jobs, [compatibility.json](../compatibility.json) |
| Weak tests hiding a fail-open regression | Mutation testing of the security-critical walker and masking code; statement coverage held at 80% or more. | [CONTRIBUTING.md § Mutation testing](../CONTRIBUTING.md#mutation-testing), `npm run coverage` |
| Supply-chain compromise (CWE-1357, CWE-829) | Actions pinned to commit SHAs; Dependabot; CodeQL; OpenSSF Scorecard; hash-pinned Python tool requirements; Trusted Publishing with npm provenance and PyPI attestations. | `.github/dependabot.yml`, `.github/workflows/codeql.yml`, `scorecard.yml`, `release.yml`, [SECURITY.md § Verifying releases](../SECURITY.md#verifying-releases) |

## Verification

Every pull request runs the Vitest and pytest suites on all supported Node
and Python versions and at both ends of each declared host range, Biome,
Ruff, `tsc`, CodeQL, pack-content and install smoke tests, and the coverage
floor. Confirmed vulnerabilities follow
[SECURITY.md § How reports are handled](../SECURITY.md#how-reports-are-handled)
and gain a regression test.
