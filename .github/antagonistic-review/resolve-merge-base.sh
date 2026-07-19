#!/usr/bin/env bash
# Resolve the PR's true divergence point — the merge base of the LIVE base ref and the
# PR head — so the panel reviews exactly the change a merge would introduce. The frozen
# event sha is only a fallback: a base frozen at PR creation makes the panel judge
# content that has since landed on the base branch (the wrong-diff failure this script
# exists to prevent). Runs from the BASE checkout, so a PR cannot alter its own gate.
#
# Env in: BASE_REF (live base branch), BASE_SHA (frozen event sha, fallback only),
# HEAD_SHA, GITHUB_ENV (file to export MERGE_BASE into). Fails closed (non-zero) when
# no merge base exists or the diff would be empty.
set -euo pipefail

: "${BASE_REF:?}" "${BASE_SHA:?}" "${HEAD_SHA:?}" "${GITHUB_ENV:?}"

if command -v timeout >/dev/null 2>&1; then bounded() { timeout "$@"; }; else bounded() { shift; "$@"; }; fi

# The fetch must not fail the script (set -e): a deleted/renamed base ref is exactly
# the case the frozen-sha fallback below exists for.
bounded 60 git fetch --no-tags origin "$BASE_REF" \
  || echo "base ref '$BASE_REF' not fetchable — falling back to the frozen event sha"
mb="$(git merge-base "origin/$BASE_REF" "$HEAD_SHA" 2>/dev/null \
  || git merge-base "$BASE_SHA" "$HEAD_SHA" 2>/dev/null || true)"
if [ -z "$mb" ]; then
  echo "::error title=No merge base::Neither the live base ref nor the frozen event sha yields a merge base with HEAD — the diff range cannot be established. Failing closed."
  exit 1
fi
if [ "$mb" = "$HEAD_SHA" ]; then
  echo "::error title=Nothing to review::HEAD is already contained in the live base ref — the diff is empty and a review would be a vacuous pass. Failing closed."
  exit 1
fi
echo "MERGE_BASE=$mb" >>"$GITHUB_ENV"
echo "merge base: $mb (divergence point of live '$BASE_REF' and head)"
