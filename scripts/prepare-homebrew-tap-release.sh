#!/usr/bin/env bash

set -euo pipefail

TAP_DIR=${1:?tap directory is required}
VERSION=${2:?version is required}

git -C "$TAP_DIR" add -A -- Formula/ formula_renames.json
if ! git -C "$TAP_DIR" diff --cached --quiet -- Formula/ formula_renames.json; then
  git -C "$TAP_DIR" commit -q -m "corbits-code $VERSION"
fi

UPSTREAM=$(git -C "$TAP_DIR" rev-parse --abbrev-ref --symbolic-full-name '@{upstream}')
if [ "$(git -C "$TAP_DIR" rev-list --count "$UPSTREAM..HEAD")" -gt 0 ]; then
  printf 'push-required\n'
else
  printf 'current\n'
fi
