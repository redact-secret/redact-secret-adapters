#!/usr/bin/env bash
# One-time (and idempotent) repository setup for the release flow in
# RELEASING.md:
#   - creates develop and release from main if they don't exist
#   - makes develop the default branch (workflow_dispatch workflows such as
#     "Cut release candidate" must exist on the default branch to be run)
#   - lets GitHub Actions open PRs (cut-rc.yml, release-reconcile.yml)
#   - creates or updates every ruleset in .github/rulesets, matched by name
#
#   scripts/apply-rulesets.sh [owner/repo]
set -euo pipefail

repo="${1:-$(gh repo view --json nameWithOwner --jq .nameWithOwner)}"
dir="$(cd "$(dirname "$0")/../.github/rulesets" && pwd)"

main_sha=$(gh api "repos/$repo/git/ref/heads/main" --jq .object.sha)
for branch in develop release; do
  if gh api "repos/$repo/git/ref/heads/$branch" >/dev/null 2>&1; then
    echo "branch $branch: exists"
  else
    gh api "repos/$repo/git/refs" -f ref="refs/heads/$branch" -f sha="$main_sha" >/dev/null
    echo "branch $branch: created at main ($main_sha)"
  fi
done

gh api -X PATCH "repos/$repo" -f default_branch=develop >/dev/null
echo "default branch: develop"

# The organization setting of the same name has to allow this first.
if gh api -X PUT "repos/$repo/actions/permissions/workflow" \
  -f default_workflow_permissions=read -F can_approve_pull_request_reviews=true >/dev/null; then
  echo "actions: may create pull requests"
else
  echo "::warning::could not let Actions create PRs; enable it for the organization first, then re-run" >&2
fi

for file in "$dir"/*.json; do
  name=$(jq -r .name "$file")
  id=$(gh api "repos/$repo/rulesets" --jq ".[] | select(.name == \"$name\") | .id")
  if [ -n "$id" ]; then
    gh api -X PUT "repos/$repo/rulesets/$id" --input "$file" >/dev/null
    echo "ruleset $name: updated ($id)"
  else
    gh api -X POST "repos/$repo/rulesets" --input "$file" >/dev/null
    echo "ruleset $name: created"
  fi
done
