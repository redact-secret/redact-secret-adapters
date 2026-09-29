---
name: ci-hardening
description: Audit this repository's GitHub Actions workflows, release automation, and repo rulesets for supply-chain weaknesses with zizmor and OpenSSF Scorecard, then propose exact patches. Use when asked to harden or review CI/CD, before changing a release or publish workflow, or for "ci-hardening", "/ci-hardening". Report-only unless asked to apply.
---

# ci-hardening

Find ways CI or release automation could be abused. Propose patches; apply only when asked.

## Run

- `uvx zizmor --format plain .github/workflows/` (or `pipx run zizmor`). Record the zizmor version.
- `scorecard --repo=github.com/redact-secret/redact-secret-adapters --format json`. This needs `GITHUB_AUTH_TOKEN`; skip it and say so if the token is unavailable. `scorecard.yml` already runs it in CI, so compare with the latest run.
- Read every workflow in `.github/workflows/` yourself: `ci`, `codeql`, `scorecard`, `branch-guard`, `sync-develop`, `cut-rc`, `release-rehearsal`, `release`, `release-reconcile`. The tools miss repo-specific intent.
- Read `RELEASING.md` for the intended branch and train flow, then check the workflows enforce it.

## Checks

| Check | Pass when |
| --- | --- |
| Action pinning | Every `uses:` is pinned to a full commit SHA with a version comment |
| Token permissions | Top-level `permissions: {}`; each job declares only what it needs (`contents: read` for build and test jobs) |
| Publish jobs | `id-token: write` only on the npm and PyPI publish jobs, each bound to `environment: release`; npm uses `--provenance` and an explicit `--tag "$DIST_TAG"` from the release plan, never a hard-coded `latest`; PyPI uses `pypa/gh-action-pypi-publish` (trusted publishing) |
| Publisher tooling | The npm CLI used to publish is pinned via `.github/npm-tools/package-lock.json`, not `@latest`; Python build and twine inputs are hash-pinned in `.github/requirements/*.txt` |
| Idempotent publish | A publish never overwrites or re-publishes an existing version; the release plan (`scripts/release-plan.mjs`) decides what to publish |
| Injection | No `${{ github.event.* }}`, `github.head_ref`, PR titles, or branch names inside `run:`; values pass through `env:`. No `pull_request_target` that checks out PR code |
| Credentials | `persist-credentials: false` on checkout unless a later step pushes (`sync-develop`, `cut-rc`, `release-reconcile`); no `NPM_TOKEN` or PyPI token secret anywhere, since OIDC is in use |
| GITHUB_TOKEN-opened PRs | PRs opened by `cut-rc` and `release-reconcile` fire no `pull_request` event, so `branch-guard` runs by `workflow_dispatch`. Check the dispatch input cannot be used to skip the guard |
| Rulesets | The live rulesets match `.github/rulesets/*.json` (`develop`, `main`, `release-candidates`, `release-tags`, `release`): no bypass actors, no force-push or deletion, required `CI passed` check. Read via `gh api repos/redact-secret/redact-secret-adapters/rulesets` and diff against the committed files |
| Artifacts | Nothing secret-bearing uploaded; overhead and footprint outputs carry only the `overhead-v1` and `footprint-v1` shapes |
| Dependabot | `.github/dependabot.yml` covers github-actions, npm (root and `.github/npm-tools`), and pip |

## Output

| Severity | Workflow:line or setting | Finding | Exploit path | Patch |
| --- | --- | --- | --- | --- |

Give each patch as a minimal diff. End with the Scorecard score, if run, and a one-line verdict.

## Rules

- Never print, create, or move secrets. Do not change repo settings, rulesets, or push unless asked.
- A finding in a release workflow needs a `release-rehearsal` consideration: say whether the patch can be checked by the rehearsal before a real release.
