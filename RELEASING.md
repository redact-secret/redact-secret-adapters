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

Package tags: `adapter`, `adapter-pino`, `adapter-otel`,
`adapter-ai-context`, `adapter-mcp`, and `redact-secret-adapters` (PyPI).

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

### Qualifying a new core release

A new `@redact-secret/core` / `redact-secret` release does **not** move a
declared range on its own, and a declared range is never narrowed just to make
the next release simpler. What a new core version changes is the *ceiling CI
exercises*, which is a record, not a range:

1. Run both endpoints locally against the new core and check they pass:
   `npm run range-endpoint -- highest && npm run build && npm run typecheck && npm test`,
   then `npm run range-endpoint -- lowest` and the same again; on the Python
   side, `python scripts/install-range-endpoint.py highest|lowest && pytest`.
   Restore your tree with `npm ci` afterwards — `range-endpoint` rewrites
   `node_modules`.
2. `npm run compat:check -- --resolve` reports what each range now resolves to
   without failing. Record the new `endpoints.highest` and
   `endpointsResolvedAt` in [`compatibility.json`](./compatibility.json) by
   hand, keeping its formatting, and re-run `npm run compat:check`, then
   `npm run feed:generate` to carry the new endpoints into the
   [site release feed](#the-site-release-feed). CI's
   `range-endpoints` and `python-range-endpoints` jobs then install exactly
   those endpoints on every run, which is what makes the record evidence rather
   than a claim.
3. **Raise the declared floor only when something needs it.** A package raises
   its `@redact-secret/core` range when it uses an API a lower core does not
   have, and the `published-combination` job is what catches a floor that is
   too low. Raising it because a newer core exists would drop consumers the
   suite still passes against, and a semver expression alone is not evidence
   that every version inside it was tested — `endpoints` names the two that
   were.
4. A core version that is **announced but not published** qualifies nothing.
   Wait for the real registry artifact: there is nothing to install, nothing
   for CI to exercise, and nothing to record.

The same rule holds for a host SDK: `pino`, `@opentelemetry/sdk-trace-base`,
the MCP SDK lines, `opentelemetry-sdk`.

## Cutting a release

1. **Bump on `develop`.** In a normal PR, bump each package you're
   releasing (`package.json` / `python/pyproject.toml`) and move its
   CHANGELOG `Unreleased` entries under `## [x.y.z] - YYYY-MM-DD`.
   If a package needs a new version of a sibling it depends on
   (`@redact-secret/adapter`, or `adapter-ai-context` for `adapter-mcp`),
   raise its dependency range to that version in the same PR. The
   `published-combination` CI job installs each package with the lowest
   published sibling its range admits and fails when the floor is too low
   (#36). Run `npm run feed:generate` and commit the regenerated
   `site-feed/v1/adapters.json` in the same PR; CI's `lint` job fails while
   it is stale.
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
      because every other npm package depends on it, and
      `adapter-ai-context` before `adapter-mcp`, which depends on it.
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
- **The `release` -> `main` PR won't merge**, reporting `N of N required
  status checks are expected` while `Branch guard` and `CI passed` are green
  on its head: close and reopen it from your own account.

  ```
  gh pr close <n> && gh pr reopen <n>
  ```

  Reconcile opens that PR with `GITHUB_TOKEN`, which fires no `pull_request`
  event, so GitHub records the CI and Branch guard runs but never executes
  them — they end as a startup failure with zero jobs and the required
  contexts stay `expected`. The runs reconcile dispatches onto the head ref
  do go green, but they land in another check suite and don't satisfy the
  ruleset; `main`'s ruleset has no bypass actors, so `--admin` won't force it
  either. Reopening as a user fires a real event, and the checks then count.

A dry run of the whole release (no publish, no tags) is **Release** with
`dry_run` on, from any branch. On a branch with nothing bumped it runs CI
and reports an empty plan.

## The site release feed

[`site-feed/v1/adapters.json`](site-feed/v1/adapters.json) is the adapter
inventory redact-secret-www publishes, so that the site stops asking npm and
PyPI what this repository ships (#61). It is generated, never edited:

```bash
npm run feed:generate   # rewrite it from the manifests
npm run feed:check      # fail if the committed file is stale or schema-invalid (CI, lint job)
```

**Inputs.** `PACKAGES` in [`scripts/release-plan.mjs`](scripts/release-plan.mjs)
(which packages ship, their id and tag prefix), each package's own manifest
(name, declared version, sibling dependencies), and
[`compatibility.json`](compatibility.json) (runtime, core and host ranges and
their tested endpoints, already held equal to the manifests by
`compat:check`). No Markdown, no registry lookup, no network.

**Shape.** One entry per released package, in release-plan order:

```json
{
  "schemaVersion": "redact-secret-adapters.release-feed/v1",
  "generatedAt": "2026-09-28T00:00:00Z",
  "repository": "https://github.com/redact-secret/redact-secret-adapters",
  "sources": ["scripts/release-plan.mjs", "compatibility.json", "packages/adapter/package.json", "..."],
  "packages": [
    {
      "id": "adapter-pino",
      "ecosystem": "npm",
      "name": "@redact-secret/adapter-pino",
      "version": "0.1.2",
      "channel": "latest",
      "prerelease": false,
      "gitTag": "adapter-pino@0.1.2",
      "sourcePath": "packages/adapter-pino",
      "registryUrl": "https://www.npmjs.com/package/@redact-secret/adapter-pino",
      "runtime": { "name": "node", "range": "20.x || 22.x || 24.x", "tested": ["20", "22", "24"] },
      "core": { "name": "@redact-secret/core", "range": "^0.1.0-beta.6", "kind": "peerDependency", "optional": false,
                "tested": { "lowest": "0.1.0-beta.6", "highest": "0.1.0-beta.10" } },
      "hosts": [{ "name": "pino", "range": "^10.0.0", "kind": "peerDependency", "optional": false,
                  "tested": { "lowest": "10.0.0", "highest": "10.3.1" } }],
      "dependsOn": [{ "name": "@redact-secret/adapter", "range": "^0.1.3" }]
    }
  ]
}
```

The schema, [`site-feed/v1/adapters.schema.json`](site-feed/v1/adapters.schema.json)
(JSON Schema draft 2020-12), defines every field. `channel` is the npm
dist-tag (`distTagFor`), or for PyPI `latest` / `alpha` / `beta` / `rc` /
`dev` from the PEP 440 version.

**Determinism.** The file is a pure function of its inputs. `generatedAt` is
`compatibility.json`'s `endpointsResolvedAt` at midnight UTC, not the time the
generator ran, so regenerating an unchanged tree reproduces the committed bytes
exactly; that equality is what `feed:check` tests. The feed does not carry its
own revision or digest, because a file cannot name the commit it is in.

**Consuming it.** Fetch the file at a full commit SHA,
`https://raw.githubusercontent.com/redact-secret/redact-secret-adapters/<40-hex sha>/site-feed/v1/adapters.json`,
record that SHA as the source revision, and compute the SHA-256 of the bytes
received. Resolve the SHA from **`main`**: `version` is the version the
manifest *declares*, and only `main` (and `release`) are guaranteed to declare
published versions, since reconcile verifies every one is on its registry
before it opens `release → main`. On `develop` a version may be bumped ahead
of the next train and not installable yet. Refuse a `schemaVersion` you do not
recognise, and validate against the schema fetched at the same SHA: the schema
is closed (`additionalProperties: false`), so it describes exactly the file
beside it.

**Compatibility policy.** Within `v1`, fields may be *added* (a consumer
ignores what it does not know; the schema here is updated in the same PR), and
packages may appear or disappear as the release plan changes. Removing or
renaming a field, changing a field's type or meaning, or changing the
determinism rule above is a breaking change: it ships as a new
`site-feed/v2/adapters.json` and `adapters.schema.json` with
`schemaVersion` `redact-secret-adapters.release-feed/v2`, and `v1` keeps being
generated unchanged until its consumers have moved.

**What it may say.** Only what the manifests and the compatibility record
already publish: names, versions, ranges and the endpoints CI tests. No
registry state (publish dates, download counts), no benchmark numbers, nothing
secret-shaped.

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
refuses it even by hand. Wiring it in means dropping `"private"` and the
steps above; `@redact-secret/adapter-ai-context` and
`@redact-secret/adapter-mcp` were wired in this way for their first
release, `0.1.0-alpha` (`adapter-mcp` depends on `adapter-ai-context`, so
that one publishes first).

PRs that cut and reconcile open use `GITHUB_TOKEN`, which fires no
`pull_request` event; those workflows dispatch CI, Branch guard and
Rehearsal onto the PR's head ref instead, which is what the required checks
match on.
