---
name: owasp-review
description: Review the current code against OWASP guidance (ASVS 5.0, Top 10, LLM Top 10, relevant Cheat Sheets) and report which requirements it meets, misses, or cannot be judged. Use when asked for an OWASP review or compliance check ("owasp-review", "/owasp-review packages/adapter-mcp", "does this meet OWASP?"). Read-only; changes nothing.
---

# owasp-review

Review code against OWASP guidance. Report findings only; do not edit files.

## Scope

- Target: the path given as an argument, or else the current diff (`git diff develop...HEAD`), or else `packages/` and `python/redact_secret_adapters/`.
- Read `SECURITY.md` (what is in and out of scope), `ARCHITECTURE.md` (§ Security boundary, § Fail-closed rules, and the section for the adapter under review), and `README.md` § Fail-closed behavior first. Judge each control only within that boundary. What counts as a secret is the core's decision, and documented residual risks (for example, text a destination adds after pino's `streamWrite`) are not findings.
- This repository is a library with no users, sessions, or network listeners, so most access-control and authentication areas are `n/a`. Its risk is plaintext reaching a host, and a fail-closed rule not firing.

## Checklist

Map the code to the OWASP areas that apply. Skip areas that do not.

| Area | Source | Check |
| --- | --- | --- |
| Sensitive data exposure | ASVS data-protection chapter, Logging Cheat Sheet | Matched plaintext never appears in output, errors, warnings, findings, or counters. Findings cross as allowlisted safe fields only (`SAFE_FINDING_FIELDS`). The one-time OpenTelemetry warning names a field, never a value |
| Fail-closed error handling | ASVS error-handling and logging chapter, Error Handling Cheat Sheet | Every failure yields a fixed marker (`[REDACTED:BLOCKED]`, `[REDACTED:ERROR]`, `[REDACTED:LIMIT_EXCEEDED]`, `[REDACTED:CYCLE]`) or a fixed `blocked` outcome. Error messages are never read, no `cause` chain carries input, and an uninitialized core fails closed |
| Input validation and resource limits | ASVS validation chapter, Denial of Service Cheat Sheet | `DEFAULT_LIMITS` are honored (depth, array length, object keys, string length, total leaves); elements past a limit are dropped, never passed through. Throwing getters, `toJSON()`, cycles, proxies, and prototype keys are handled. No ReDoS in any pino line lexer or key matcher |
| Business logic and concurrency | ASVS business-logic chapter | AI-context is all-or-nothing (no partial masked value); staged streams release once at a successful `finalize`; re-entrant logging and masking keep per-record attribution (`ARCHITECTURE.md` § pino) |
| Untrusted content handling | OWASP Top 10 for LLM Applications (sensitive information disclosure), LLM Prompt Injection Prevention Cheat Sheet | Tool results, tool arguments, and streamed chunks reaching a model context are scanned; unknown MCP block types and malformed shapes block as `unsupported_value`; binary payloads block by default; a producer is closed when `accepting` turns false |
| Adapter boundary | `ARCHITECTURE.md` § Security boundary | No network, filesystem, environment, or telemetry work; the adapter is not a second detector; the core is injected, never imported outside the live wrapper; only the documented core surface is read (`dependency-surface.test.ts`) |
| Vault token passthrough | `ARCHITECTURE.md` § The vault boundary | No `<rsv_…>` token is parsed, rewritten, or restored; this repository does not depend on `@redact-secret/vault` |
| Supply chain | NPM Security Cheat Sheet, ASVS dependency chapter | `files` allow-list per package (`verify-pack-contents`), no install scripts, `sideEffects: false`, exact-pinned devDependencies where the repo pins, SHA-pinned actions, npm `--provenance`, PyPI trusted publishing |
| Cross-language parity | `ARCHITECTURE.md` § Cross-language contract | The TypeScript and Python adapters agree on every shared fixture in `fixtures/*.json`; a divergence is a bypass in one language |

Cite the requirement text itself. Look up the current ASVS 5.0 requirement number rather than quoting one from memory.

## Output

One table, most severe first:

| Status | Severity | OWASP ref | file:line | Evidence | Fix |
| --- | --- | --- | --- | --- | --- |

- Status: `pass`, `fail`, or `n/a` (with the reason).
- Every `fail` needs a concrete scenario: input → wrong outcome.
- End with a one-line verdict and the requirements that could not be judged without runtime testing. Hand those to `vulnerability-test`.

## Rules

- Use synthetic values only. Never paste real secrets or a finding's plaintext.
- Name the specific requirement or Cheat Sheet for every row.
- Do not claim compliance or certification. Say "meets the reviewed requirements".
