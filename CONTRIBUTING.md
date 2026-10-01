# Contributing to Redact Secret adapters

Thanks for wanting to help. You do not need to understand the whole codebase
to contribute: a typo fix, a clearer sentence in a README, a failing test that
shows a bug, or a new test for an untested case are all welcome.

This page gets you from zero to an open pull request. The first three
sections are all you need for a first change.

## 1. Set up (about two minutes)

You need [Node.js](https://nodejs.org/) 20, 22 or 24 and git. Python 3.10 or
later is needed only if you touch the Python package.

```sh
git clone https://github.com/redact-secret/redact-secret-adapters.git
cd redact-secret-adapters
npm ci
npm test
```

`npm test` builds every package first, then runs the whole JavaScript suite.
If it passes, your setup works.

For the Python package, from the repository root:

```sh
python -m venv .venv && source .venv/bin/activate
pip install -e "./python[otel,test]"
pytest
```

## 2. Find your way around

```text
packages/
  adapter/              shared base: mask one string, walk a value tree
  adapter-pino/         pino hooks
  adapter-otel-trace/   OpenTelemetry JS span processor
  adapter-otel/         deprecated name, re-exports adapter-otel-trace
  adapter-ai-context/   AI-context boundary
  adapter-mcp/          MCP boundary, built on adapter-ai-context
python/                 the PyPI package: logging filter, OpenTelemetry, walker
fixtures/               test cases shared by the TypeScript and Python suites
scripts/                smoke tests, compatibility checks, benchmarks
docs/                   compatibility, PII, performance, decisions
```

Each package has `src/`, `test/`, a `README.md` and a `CHANGELOG.md`.

Two ideas explain most of the code:

- **Adapters detect nothing.** The core decides what a secret is. An adapter
  hands text to the core and puts the answer back. A missed or false detection
  is therefore a core issue, not an adapter one.
- **Fail closed.** When anything goes wrong, an adapter writes a fixed marker
  such as `[REDACTED:ERROR]` instead of the original text. It never falls back
  to plaintext, and never puts an error's message on the wire.

[ARCHITECTURE.md](./ARCHITECTURE.md) has the full picture. Read it before a
change to how an adapter behaves; you can skip it for docs and small fixes.

## 3. Make a change

1. **Branch from `develop`.** It is the default branch, and pull requests go
   into it. (`release` and `main` are for releases only; see
   [RELEASING.md](./RELEASING.md#branches).)
2. **Change the code and add a test** in the same package. A bug fix needs a
   test that fails without the fix.
3. **Run the checks** for what you touched:

   ```sh
   npx vitest run packages/adapter-pino   # one package's tests
   npm run format                         # auto-format
   npm run lint                           # Biome
   npm run typecheck
   ```

   For Python: `pytest`, `ruff check python` and `ruff format python`
   (`pip install ruff`).
4. **Add a changelog line** under `Unreleased` in the package's `CHANGELOG.md`
   if users will notice the change.
5. **Open the pull request.** Say what changes, how you verified it, and any
   compatibility impact. The template has a short checklist. The `CI passed`
   check must be green; maintainers merge with a merge commit.

Not sure where to start, or whether an idea fits? Open an
[issue](https://github.com/redact-secret/redact-secret-adapters/issues) and
ask. That is a fine first step.

### The one hard rule: no real secrets

Never put a real credential in code, a test, a fixture, a snapshot, a log, an
issue, a pull request, or a screenshot. Use values that are obviously fake,
like the one the examples use:

```text
ghp_SYNTHETICREVOKED00000000000000000000
```

## Reporting bugs and requesting enhancements

- Use [GitHub Issues](https://github.com/redact-secret/redact-secret-adapters/issues)
  for reproducible bugs and focused enhancement requests. Include the package
  and version, the host SDK and version, the expected and observed result, and
  a minimal reproduction using synthetic values. Public support is
  best-effort; the project makes no response-time or long-term-support
  commitment.
- A false positive or missed detection is a decision of the core, not of an
  adapter. Report it against
  [redact-secret/redact-secret](https://github.com/redact-secret/redact-secret/issues).
- Report suspected vulnerabilities privately through the
  [GitHub security advisory form](https://github.com/redact-secret/redact-secret-adapters/security/advisories/new),
  as described in [SECURITY.md](./SECURITY.md), never in a public issue.

## Getting the software

Each package in this repository is versioned and published independently, to
npm (`@redact-secret/adapter*`) or PyPI (`redact-secret-adapters`). The
[README](./README.md#which-package-do-i-need) says which one to install. To
work from source, clone this repository and run `npm ci`.

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
  New functionality is accepted only with tests that exercise it, and
  statement coverage of `packages/*/src` and of the Python package
  `redact_secret_adapters` must each stay at or above 80% (`npm run coverage`
  and `pytest --cov`, enforced in CI).
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
- **Documentation examples.** The `js` block after
  `<!-- smoke-test:example -->` in a package README is executed verbatim by
  `npm run smoke-test`. If you edit one, keep the marker directly above the
  block and keep the block runnable.
- **License and origin.** Contributions are licensed under the repository's
  [MIT License](./LICENSE). By opening a pull request you certify the
  [Developer Certificate of Origin 1.1](https://developercertificate.org/):
  you wrote the change or otherwise have the right to submit it under that
  license. The pull request template asks you to confirm this; a
  `Signed-off-by` trailer is welcome but not required.
- **Conduct.** Follow the [code of conduct](./CODE_OF_CONDUCT.md). How changes
  are decided is described in [GOVERNANCE.md](./GOVERNANCE.md).

## Running every check locally

What CI runs on a pull request, in one place:

```sh
npm ci
npm run build
npm run typecheck
npm test              # Vitest
npm run coverage      # Vitest with the 80% statement-coverage floor
npm run lint          # Biome
npm run compat:check
npm run feed:check
```

| Command | Checks |
| --- | --- |
| `npm test` | Every package's tests, after a build |
| `npm run coverage` | The same, failing under 80% statement coverage |
| `npm run lint` / `npm run format` | Biome: report / fix |
| `npm run typecheck` | `tsc` in every package |
| `npm run compat:check` | `compatibility.json`, the package manifests and `ci.yml` agree |
| `npm run feed:check` | The generated release feed in `site-feed/` is up to date |
| `npm run smoke-test` | Packs every package, installs it outside the repository, and runs the README examples against the real core |

For the Python package, install the test requirements used by CI and run
`pytest` from the repository root. For the 80% statement-coverage floor CI
enforces on one Python version, `pip install pytest-cov` and add
`--cov=redact_secret_adapters --cov-report=term-missing --cov-fail-under=80`.
CI runs `ruff check python` and `ruff format --check python` as well. The full
matrix (supported host and core range endpoints, pack contents, install smoke
tests) runs in [CI](./.github/workflows/ci.yml).

## Mutation testing

[Stryker](https://stryker-mutator.io/) is configured in `stryker.config.json`
and runs Vitest against mutated source. It is not part of CI, and you do not
need it for a normal contribution. Mutate one package, or one file, per run,
from any checkout or worktree:

```sh
npm ci
npm run build
npx stryker run --mutate 'packages/<pkg>/src/**/*.ts'
npx stryker run --mutate 'packages/adapter/src/walk.ts' --concurrency 2
```

- Stryker runs Vitest through `vitest.stryker.config.ts`: the same tests as
  `vitest.config.ts`, in Vitest's `related` mode, so only the tests that import
  the mutated file run. The sandbox in `.stryker-tmp/` symlinks `node_modules`
  back to the checkout, so `@redact-secret/adapter` and
  `@redact-secret/adapter-otel-trace` resolve to the checkout's `dist/`, not the
  sandbox's. Without a build, Vitest cannot resolve them and Stryker stops with
  "No tests were executed". `vitest.stryker-setup.ts` builds the checkout when a
  package has no `dist/`, but it does not rebuild a stale one, so run
  `npm run build` after changing another package's source. Mutants in one
  package are therefore not seen by another package's tests; each package's own
  tests are what a run measures.
- `disableTypeChecks` is limited to `packages/*/{src,test}`. Stryker's default
  adds `// @ts-nocheck` to every script in the sandbox, including the vendored
  `fixtures/core/*.mjs`, which breaks their byte-for-byte digests in
  `core-pins.test.ts` whenever that test runs (for example with
  `"vitest": { "related": false }`).
- Each run writes `reports/mutation/mutation.json` and overwrites the previous
  report; copy it elsewhere to keep it. `reports/` and `.stryker-tmp/` are
  ignored by git.
- The config uses 4 workers; lower it with `--concurrency <n>`. Two runs in the
  same checkout share `.stryker-tmp/` and the report file, so run concurrent
  jobs from separate worktrees.
- No type checker runs (`"checkers": []`). `@stryker-mutator/typescript-checker`
  needs the TypeScript JS API, which the native TypeScript 7 compiler used here
  does not provide, so mutants that would not type-check still run (Vitest
  strips types) instead of being skipped.
- `@stryker-mutator/core` 10.0.0 pins `typed-rest-client`, which pins a `qs`
  version with two moderate advisories. They appear in `npm audit` but not in
  `npm audit --omit=dev`: the dependency is dev-only and never ships.

## Static analysis and dependencies

CodeQL analyzes JavaScript/TypeScript and Python on every push and pull request,
and weekly. Dependabot proposes updates for GitHub Actions, npm, and pip
dependencies. Findings from either are fixed rather than dismissed, unless a
maintainer records why one does not apply.
