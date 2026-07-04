#!/usr/bin/env bash
# Fails if a PR changes files under a package (plugins/<id>, agents/<id>)
# without bumping that package's manifest version. Releases tag
# <id>-v<version>; shipping changed content under an already-released version
# either collides with the existing tag or silently re-labels old content.
#
# Usage: scripts/check-version-bump.sh <base-ref>   (e.g. origin/main)
# Requires history for <base-ref> (CI checks out with fetch-depth: 0).
set -euo pipefail

BASE_REF="${1:?usage: check-version-bump.sh <base-ref>}"
fail=0

for manifest in plugins/*/bakin-plugin.json agents/*/bakin-package.json; do
  [ -f "$manifest" ] || continue
  dir=$(dirname "$manifest")
  case "$(basename "$dir")" in _*) continue ;; esac

  changed=$(git diff --name-only "$BASE_REF"...HEAD -- "$dir")
  [ -z "$changed" ] && continue

  base_version=$(git show "$BASE_REF:$manifest" 2>/dev/null | jq -r '.version' || true)
  head_version=$(jq -r '.version' "$manifest")

  if [ -z "$base_version" ] || [ "$base_version" = "null" ]; then
    echo "$dir: new package at $head_version — OK"
  elif [ "$base_version" = "$head_version" ]; then
    echo "::error::$dir changed in this PR but $manifest is still version $head_version — bump it (releases tag <id>-v<version>)"
    echo "  changed files:"
    echo "$changed" | sed 's/^/    /'
    fail=1
  else
    echo "$dir: $base_version -> $head_version — OK"
  fi
done

exit $fail
