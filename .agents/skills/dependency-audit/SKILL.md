---
name: dependency-audit
description: Scan this repository's npm and Python dependencies for known vulnerabilities and registry-signature problems with OSV-Scanner and npm audit signatures, separating what ships to consumers from dev-only tooling. Use when asked to audit dependencies, before a release, or for "dependency-audit", "/dependency-audit". Report-only.
---

# dependency-audit

Answer one question: does any dependency we ship or build with have a known vulnerability or a bad signature?

## Run

1. `npm ci` from a clean tree.
2. `osv-scanner scan source -L package-lock.json -L .github/npm-tools/package-lock.json --format json`. Add each hash-pinned `.github/requirements/python-*.txt` as `-L requirements.txt:<path>`. Record the OSV-Scanner version and scan time.
3. `npm audit signatures`. This verifies registry signatures and provenance attestations for installed packages.
4. Compare the core against the record: `npm run compat:check` (add `-- --resolve` to re-resolve range endpoints), and `npm view @redact-secret/core@<endpoint> dist.integrity dist.signatures` for both endpoints in `compatibility.json`.
5. Confirm the vendored core fixtures still match `fixtures/core/pins.json` by running `npx vitest run packages/adapter-ai-context/test/core-pins.test.ts`.

## Classify every hit

- **Shipped (npm)**: each package's `dependencies` in `packages/*/package.json` and their transitive trees. Today the adapters keep the core and host SDKs as `peerDependencies`, and `adapter-pino`, `adapter-otel-trace`, and `adapter-ai-context` depend on `@redact-secret/adapter`, while `adapter-otel` depends on `adapter-otel-trace` and `adapter-mcp` on `adapter-ai-context`. Read the manifests rather than trusting this list.
- **Shipped (PyPI)**: `redact-secret` (the core) and the optional `opentelemetry-sdk` extra in `python/pyproject.toml`. The declared ranges are shipped surface, so an advisory inside a range endpoint counts.
- **Peer and host ranges**: an advisory in the core or a host SDK version inside a declared range is a compatibility finding. Report it, and name the range endpoint tests that cover it.
- **Build/test only**: typescript, vitest, biome, fast-check, ajv, the MCP and pino and OpenTelemetry host SDKs installed as devDependencies, `.github/npm-tools`, and `.github/requirements` (build, lint, test).
- **Accepted**: advisories inside npm's own bundle in `.github/npm-tools` that no npm release fixes yet are recorded, with a reachability reason, in `.github/npm-tools/osv-scanner.toml`. OSV-Scanner filters them. List them as accepted, and flag any entry whose `ignoreUntil` has passed or whose fix has since shipped in an npm release.
- **Reachable?** State whether the vulnerable function is used by our code or tests. Say "not assessed" when unsure; never guess "not reachable".

## Output

| Class | Package@version | Advisory (OSV/GHSA/CVE) | Severity | Fixed in | Reachable | Action |
| --- | --- | --- | --- | --- | --- | --- |

Then the `npm audit signatures` summary (verified, missing, invalid), whether the core endpoint integrity matches `compatibility.json`, and whether the fixture pins verify. Verdict: `no known vulnerabilities in shipped dependencies` or the counts.

## Rules

- Do not upgrade anything. Widening or moving a core or host range needs its own test-backed changelog entry (`CONTRIBUTING.md`), so propose it instead.
- Never edit `fixtures/core/`; those files are vendored byte-for-byte at a pinned core commit.
- Never paste tokens. If a registry call needs auth, stop and say so.
