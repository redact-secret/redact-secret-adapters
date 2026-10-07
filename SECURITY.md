# Security policy

## Scope

This repository is host integrations — wiring only. It contains no
detection logic, no policy, and no redaction algorithm; every adapter calls
into [`@redact-secret/core`](https://github.com/redact-secret/redact-secret)
and carries its answer back out, never second-guessing it.

**In scope:**

- Plaintext reaching a host (a log line, a span attribute, an exporter)
  through an adapter, bypassing redaction.
- A fail-closed rule not firing: an error path, a budget overrun, or a cycle
  that should produce `[REDACTED:ERROR]` / `[REDACTED:LIMIT_EXCEEDED]` /
  `[REDACTED:CYCLE]` instead leaking the original value.
- An adapter silently becoming a no-op — for example a host SDK freezing an
  object an adapter assumes is mutable, as described in
  [ARCHITECTURE.md](./ARCHITECTURE.md#opentelemetry).
- An adapter performing network, filesystem, environment, or telemetry work
  of its own, or logging/attaching/re-exposing matched plaintext in its own
  error paths.

**Out of scope — this is the core's decision, not this repository's:**

- What counts as a secret, detector accuracy, false positives/negatives, or
  any change to `scanAndRedact`'s findings. Report those against
  [redact-secret/redact-secret](https://github.com/redact-secret/redact-secret/security)
  instead.

## Supported versions

Each package in this repository — `@redact-secret/adapter`,
`@redact-secret/adapter-pino`, `@redact-secret/adapter-otel-trace`,
`@redact-secret/adapter-otel` (its deprecated name, a re-export),
`@redact-secret/adapter-otel-logs` (beta), `@redact-secret/adapter-ai-context`, `@redact-secret/adapter-mcp` (npm), and
`redact-secret-adapters` (PyPI) — is versioned and released independently;
see [ARCHITECTURE.md § Versioning](./ARCHITECTURE.md#versioning). Security
fixes target the latest published version of each package. Older versions
are not backported. A fix may require upgrading `@redact-secret/core` /
`redact-secret` as well, since these packages carry a compatibility range
against the core rather than vendoring it — the fix isn't complete until
both sides of that range are upgraded.

A security fix ships like any other change: a PR into `develop`, released
by the next train ([RELEASING.md](./RELEASING.md)). A fix for a train that
is still open can go in as a PR into its `rc/<train>` branch instead.
Nothing is fixed on `main` directly; it only ever receives `release`.

## Reporting a vulnerability

**Never include a real credential, token, or other live secret in a report**
— in the text, a reproduction, a log, or a screenshot. Use synthetic or
already-revoked values, as the repository's own fixtures do
([ARCHITECTURE.md § Security boundary](./ARCHITECTURE.md#security-boundary)).

Report suspected vulnerabilities privately through this repository's
[GitHub security advisory form](https://github.com/redact-secret/redact-secret-adapters/security/advisories/new),
not a public issue. Include:

- the affected package and version, and the host SDK/version in use;
- the expected and observed result, without plaintext secret values;
- a minimal, deterministic reproduction using synthetic input; and
- the potential impact — what actually reaches the host, and through which
  export path.

We aim to acknowledge a report within **5 business days** and to agree on a
disclosure timeline once the issue is confirmed. Fixed response or
remediation times beyond that acknowledgement are not promised. Please do
not publicly disclose the issue until a fix and disclosure timeline have
been coordinated with the maintainers.

## How reports are handled

The project has a small maintainer team ([GOVERNANCE.md](./GOVERNANCE.md#roles)),
so the times below are targets, not guarantees.

1. **Acknowledge** the report in the advisory thread within 5 business days.
2. **Triage**: reproduce it with synthetic input and decide whether it is in
   [scope](#scope). A detection issue is moved to the core repository's
   advisory form with the reporter's agreement. The reporter is told the
   outcome either way.
3. **Fix** in a private fork of the advisory, with a test that fails without
   the fix ([CONTRIBUTING.md](./CONTRIBUTING.md#requirements-for-acceptable-contributions)).
4. **Release** the fix in the next release train ([RELEASING.md](./RELEASING.md)),
   and request a CVE through the GitHub advisory when a published version is
   affected.
5. **Disclose** by publishing the advisory and an entry in the affected
   package's `CHANGELOG.md`. The target is public disclosure within 90 days of
   the report, sooner once a fix is released, or later only by agreement with
   the reporter.

## Credit

Reporters are credited by name or handle in the published advisory and its
changelog entry unless they ask to stay anonymous. The
[security advisories page](https://github.com/redact-secret/redact-secret-adapters/security/advisories)
records every credited report.

## Verifying releases

Releases are signed by the registries' keyless signing through Trusted
Publishing, not by a long-lived project key, so there is no public key to
download:

- **npm**: every `@redact-secret/adapter*` package is published from
  `release.yml` with `--provenance`, a Sigstore-signed attestation bound to
  the workflow's GitHub OIDC identity. After installing, run
  `npm audit signatures` to verify registry signatures and provenance; the
  package page on npmjs.com links the exact workflow run and commit.
- **PyPI**: `redact-secret-adapters` is uploaded with Trusted Publishing,
  which attaches PEP 740 attestations signed with the same workflow identity.
  They are shown on each file's page on pypi.org and can be checked with
  `pypi-attestations verify pypi --repository https://github.com/redact-secret/redact-secret-adapters <file-url>`.
- Every release train is tagged, and its GitHub Release names the exact
  source commit.
