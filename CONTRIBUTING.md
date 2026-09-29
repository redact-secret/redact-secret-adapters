# Contributing to Redact Secret adapters

This repository holds host integrations for
[Redact Secret](https://github.com/redact-secret/redact-secret): logging,
tracing, and AI-context adapters that carry text into the deterministic core and
carry its answer back out. Adapters contain no detection logic. Read
[ARCHITECTURE.md](./ARCHITECTURE.md) before opening a change.

## Getting the software

Each package in this repository is versioned and published independently, to npm
(`@redact-secret/adapter*`) or PyPI (`redact-secret-adapters`). The
[README](./README.md#which-package-do-i-need) says which one to install and its
current status. To work from
source, clone this repository and run `npm ci`.

## Reporting bugs and requesting enhancements

- Use [GitHub Issues](https://github.com/redact-secret/redact-secret-adapters/issues)
  for reproducible bugs and focused enhancement requests. Include the package
  and version, the host SDK and version, the expected and observed result, and a
  minimal reproduction using synthetic values. Public support is best-effort; the
  project makes no response-time or long-term-support commitment.
- A false positive or missed detection is a decision of the core, not of an
  adapter. Report it against
  [redact-secret/redact-secret](https://github.com/redact-secret/redact-secret/issues).
- Report suspected vulnerabilities privately through the
  [GitHub security advisory form](https://github.com/redact-secret/redact-secret-adapters/security/advisories/new),
  as described in [SECURITY.md](./SECURITY.md), never in a public issue.
- Never put a real credential in an issue, pull request, log, or screenshot. Use
  unmistakably synthetic or revoked values.

## Contributing a change

1. Branch from `develop` and open a pull request into `develop`. `develop` is the
   default branch. `release` and `main` only accept release-candidate and
   `release` branches respectively; see [RELEASING.md](./RELEASING.md#branches).
2. Explain the observable change, how you verified it, and any compatibility
   impact in the pull request description.
3. The required `CI passed` check must succeed. Pull requests are merged with a
   merge commit.

## Requirements for acceptable contributions

The automated items are enforced by CI on every pull request; the rest are
checked in review.

- **Coding standard.** JavaScript and TypeScript are checked with Biome
  (`npm run lint`) and type-checked with `tsc` (`npm run typecheck`). Python is
  checked with `ruff check` and `ruff format --check`. Format with
  `npm run format` before committing. Fix warnings rather than suppressing them.
- **Tests.** Every behavior change comes with automated tests in the same pull
  request: `packages/*/test` (Vitest) for the npm packages and `python/tests`
  (pytest) for the PyPI package. A bug fix adds a test that fails without the fix.
  A pull request that changes behavior without a test is not ready to merge.
- **Security boundary.** Every change must hold to the
  [Security boundary](./ARCHITECTURE.md#security-boundary): the core stays side
  effect free; an adapter performs no network, filesystem, environment, or
  telemetry work of its own; no adapter logs, attaches, or re-exposes matched
  plaintext, including in its own error paths; and an adapter is never a second
  detector. The
  [fail-closed rules](./ARCHITECTURE.md#fail-closed-rules) and their fixed
  markers are public API and change only in a major version.
- **Synthetic data only.** Fixtures, tests, snapshots, and documentation use
  unmistakably synthetic values. A real credential never enters this repository,
  in any file.
- **Host and core ranges.** A host or core range is only as wide as the tests
  that run against it; an untested version is not a supported version. A change to
  the range a package declares against the core is its own changelog entry that
  names the test backing the new range
  ([ARCHITECTURE.md § Versioning](./ARCHITECTURE.md#versioning)).
- **Changelog.** A user-visible change adds an entry under `Unreleased` in the
  affected package's `CHANGELOG.md` (`packages/<name>/CHANGELOG.md`, or
  `python/CHANGELOG.md`).
- **License.** By contributing, you agree that your contribution is licensed
  under the repository's [MIT License](./LICENSE).

## Running the checks locally

```sh
npm ci
npm run build
npm run typecheck
npm test              # Vitest
npm run lint          # Biome
npm run compat:check
npm run feed:check
```

For the Python package, install the test requirements used by CI and run
`pytest` from the repository root; CI runs `ruff check python` and
`ruff format --check python` as well. The full matrix (supported host and core
range endpoints, pack contents, install smoke tests) runs in
[CI](./.github/workflows/ci.yml).

## Static analysis and dependencies

CodeQL analyzes JavaScript/TypeScript and Python on every push and pull request,
and weekly. Dependabot proposes updates for GitHub Actions, npm, and pip
dependencies. Findings from either are fixed rather than dismissed, unless a
maintainer records why one does not apply.
