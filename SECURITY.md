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
`@redact-secret/adapter-pino`, `@redact-secret/adapter-otel` (npm), and
`redact-secret-adapters` (PyPI) — is versioned and released independently;
see [ARCHITECTURE.md § Versioning](./ARCHITECTURE.md#versioning). Security
fixes target the latest published version of each package. Older versions
are not backported. A fix may require upgrading `@redact-secret/core` /
`redact-secret` as well, since these packages carry a compatibility range
against the core rather than vendoring it — the fix isn't complete until
both sides of that range are upgraded.

Before the first publish of a package, any reported issue is fixed directly
on `main`; there is no "supported version" yet to patch separately.

## Reporting a vulnerability

**Never include a real credential, token, or other live secret in a report**
— in the report text, a reproduction, a fixture, a log, or a screenshot. Use
unmistakably synthetic or already-revoked values only, the same standard
this repository holds its own fixtures to (see
[ARCHITECTURE.md § Security boundary](./ARCHITECTURE.md#security-boundary)).

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
