# Releasing

Every package in this repository carries its own SemVer and is released
independently ([ARCHITECTURE.md § Versioning](ARCHITECTURE.md#versioning)).
Releases ship as **trains**: a train is cut from `develop` and publishes
exactly the packages whose declared version is not on its registry yet.
A package nobody bumped rides along untouched.

## Branches

```
feature ──PR──▶ develop ──cut──▶ rc/<train> ──PR──▶ release ──PR──▶ main
                   ▲                  ▲                  │
                   │                  └── fix PRs        │
                   └──────────── sync/<train> ◀──────────┘
```

| Branch | Holds | Accepts |
|---|---|---|
| `develop` | the default branch; everything merged, released or not | PRs from any branch |
| `rc/<train>` | a release candidate, cut from `develop` | fix PRs for that train |
| `release` | what the last train published | PRs from `rc/<train>` only |
| `main` | the same, once reconciled | PRs from `release` only |
| `sync/<train>` | `release`, on its way back to `develop` | — (opened by reconcile) |

The `Branch guard` workflow enforces the Accepts column; repository rulesets
([.github/rulesets](.github/rulesets)) require a PR and the checks on
`develop`, `release` and `main`.

## Trains

A train is named for the UTC date it was cut: `YYYY.MM.DD`, then
`YYYY.MM.DD.2`, `.3`, … for a second cut the same day. It is a label, not a
version: package versions stay per package.

| Name | Format | Example |
|---|---|---|
| RC branch | `rc/<train>` | `rc/2026.09.22` |
| Package tag | `<package>@<version>` | `adapter-pino@0.2.0` |
| Train tag + GitHub Release | `train/<train>` | `train/2026.09.22` |

Package tags: `adapter`, `adapter-pino`, `adapter-otel`, and
`redact-secret-adapters` (PyPI).

## Cutting a release

1. **Bump on `develop`.** In a normal PR, bump each package you're
   releasing (`package.json` / `python/pyproject.toml`) and move its
   CHANGELOG `Unreleased` entries under `## [x.y.z] - YYYY-MM-DD`.
   If `adapter-pino` or `adapter-otel` needs a new `@redact-secret/adapter`,
   raise its dependency range in the same PR.
2. **Cut the train.** Run **Cut release candidate** (Actions → *Cut release
   candidate* → Run workflow, on `develop`). It computes the plan
   (`node scripts/release-plan.mjs` shows the same thing locally), pushes
   `rc/<train>`, and opens its PR into `release`. It refuses to cut when:
   nothing is bumped, a bumped package has no CHANGELOG heading for its
   version, another train is still open, or `release` has commits `develop`
   doesn't (merge the open `sync/*` PR first).
3. **Stabilise.** Fixes for the train go in as PRs into `rc/<train>`. Every
   push re-runs CI, Branch guard and the **Rehearsal** (plan, CHANGELOG check,
   builds, `npm publish --dry-run`, `twine check`).
4. **Merge the rc PR** into `release` with a merge commit. That runs
   **Release**:
   1. **CI** — the full matrix again, on the merged commit.
   2. **Rehearsal** — as above; it also fixes the plan the publish uses.
   3. **Publish** — each planned package, npm then PyPI, with npm provenance
      and PyPI trusted publishing. `@redact-secret/adapter` goes first
      because the other two npm packages depend on it.
   4. **Tag and report** — a `<package>@<version>` tag per published
      package, then `train/<train>` and a GitHub Release whose notes are each
      shipped package's CHANGELOG section.
   5. **Reconcile** — verifies every declared version is on its registry and
      tagged, then opens `release → main` and `sync/<train> → develop`.
5. **Merge the reconcile PRs.** Merge both with a merge commit, never
   squash — `develop` has to contain `release`'s commits, and the next train
   can't be cut until it does.

## When something fails

- **Before publishing** (CI or rehearsal on the merged commit): nothing
  shipped. Fix it with a PR into a new train, or re-run.
- **Partway through publishing**: the report lists what reached each
  registry. Nothing is ever overwritten, so re-run **Release** on `release`
  (Run workflow, `dry_run` off): the plan now excludes what shipped, and
  only the rest is published and tagged. The train's GitHub Release notes
  are regenerated to cover everything it shipped.
- **Reconcile**: re-run **Release reconcile** on `develop` with the train
  name. It is idempotent: it skips PRs that are already open and branches
  that already contain `release`.

A dry run of the whole release (no publish, no tags) is **Release** with
`dry_run` on, from any branch.

## One-time setup

- npm (per package) and PyPI trusted publishers point at this repository and
  the workflow file `release.yml`.
- *Settings → Actions → General*: "Allow GitHub Actions to create and approve
  pull requests" on (cut and reconcile open PRs).
- Rulesets from [.github/rulesets](.github/rulesets), applied with
  `scripts/apply-rulesets.sh`.

PRs that cut and reconcile open use `GITHUB_TOKEN`, which fires no
`pull_request` event; those workflows dispatch CI, Branch guard and
Rehearsal onto the PR's head ref instead, which is what the required checks
match on.
