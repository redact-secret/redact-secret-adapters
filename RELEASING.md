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
`develop`, `release` and `main`, and allow only merge commits on all three.
A squash-merged `sync/<train>` PR would leave `develop` without `release`'s
commits, and cut-rc would refuse every later train.

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

### Prereleases and npm dist-tags

Every npm publish passes `--tag`, taken from the plan
(`distTagFor` in `scripts/release-plan.mjs`): `latest` for a release version,
and the first prerelease identifier for a prerelease, so `0.1.0-alpha` and
`0.1.0-alpha.2` publish under `alpha`, `1.0.0-rc.1` under `rc`. A prerelease
never moves `latest`, and npm 11 refuses to publish (or dry-run) a prerelease
without `--tag` anyway. A prerelease whose first identifier can't be a tag
(`1.0.0-0`, `1.0.0-latest`) fails the plan. A consumer installs a prerelease
by its exact version or tag (`npm install <package>@alpha`). The PyPI package
has no dist-tags: pip skips a pre-release unless it is asked for one.

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
   4. **Tag and report** — a `<package>@<version>` tag for every package
      whose declared version is on its registry and not yet tagged (whether
      this run published it or it was published out of band), then
      `train/<train>` and a GitHub Release whose notes are each shipped
      package's CHANGELOG section.
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
- **After publishing** (a tag push or the GitHub Release failed): re-run
  **Release** on `release` the same way. The rehearsal plans nothing to
  publish, which is allowed inside **Release**, and **Tag and report** tags
  whatever is published but untagged and refreshes the GitHub Release.
- **Reconcile**: if it failed on a missing tag, re-run **Release** as above.
  Otherwise re-run **Release reconcile** on `develop` with the train name.
  It is idempotent: it skips PRs that are already open and branches that
  already contain `release`.

A dry run of the whole release (no publish, no tags) is **Release** with
`dry_run` on, from any branch. On a branch with nothing bumped it runs CI
and reports an empty plan.

## One-time setup

- npm (per package) and PyPI trusted publishers point at this repository,
  the workflow file `release.yml`, and the environment `release`. Every
  publish job runs in that environment. The environment field is optional
  on both registries, but a trusted publisher that names it only accepts
  tokens from jobs in it, so set it.
- The `release` environment (*Settings → Environments*) has a deployment
  branch policy that allows only the `release` branch:

  ```bash
  gh api -X PUT repos/redact-secret/redact-secret-adapters/environments/release \
    --input - <<<'{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
  gh api -X POST repos/redact-secret/redact-secret-adapters/environments/release/deployment-branch-policies \
    -f name=release -f type=branch
  ```
- *Settings → Actions → General*: "Allow GitHub Actions to create and approve
  pull requests" on (cut and reconcile open PRs).
- Rulesets from [.github/rulesets](.github/rulesets), applied with
  `scripts/apply-rulesets.sh`.

### A brand-new npm package

npm only lets you configure a trusted publisher on a package that already
exists, so the first version of a new npm package can't come from
`release.yml`: its publish fails with `E404`. (PyPI doesn't have this
problem: a *pending* trusted publisher can be registered before the project
exists.) Wire the package in on `develop` first (`PACKAGES` in
`scripts/release-plan.mjs`, `CHANGELOGS` in `scripts/release-notes.mjs`, a
publish job in `release.yml`), then bootstrap it once by hand:

1. Cut the train as usual. On the `rc/<train>` head, build and publish the
   new package from your machine:
   `npm ci && npm run build && npm publish --workspace <package> --access public --tag <dist-tag>`,
   where `<dist-tag>` is the package's entry in the plan (`node scripts/release-plan.mjs`
   prints it: `latest`, or `alpha` for a `-alpha` prerelease).
   This version has no provenance attestation; later ones will.
2. On npmjs.com, add the package's trusted publisher (this repository,
   `release.yml`, environment `release`), then under *Publishing access*
   disallow tokens.
3. Merge the rc PR. The plan skips the version you published, publishes
   the rest, and **Tag and report** tags the hand-published version too, so
   reconcile's tag check passes. If the rc PR was already merged and the
   publish failed with `E404`, do steps 1–2 from `release` instead and
   re-run **Release**.

A new package lands on `develop` unreleased: `"private": true` in its
manifest and absent from `PACKAGES`, so no train plans it and `npm publish`
refuses it even by hand. `@redact-secret/adapter-ai-context` and
`@redact-secret/adapter-mcp` are in that state; each CHANGELOG lists what its
first release has to change (`adapter-mcp` depends on `adapter-ai-context`,
so that one ships first).

PRs that cut and reconcile open use `GITHUB_TOKEN`, which fires no
`pull_request` event; those workflows dispatch CI, Branch guard and
Rehearsal onto the PR's head ref instead, which is what the required checks
match on.
