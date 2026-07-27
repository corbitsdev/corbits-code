#!/usr/bin/env bash
# Fail if staged or working-tree changes touch the vendored inference package.
set -euo pipefail
root="$(git rev-parse --show-toplevel)"
cd "$root"
forbidden='^vendor/'

# Tracked edits (staged + unstaged) and untracked paths; dedupe for stable checks.
changed="$(
  {
    git diff HEAD --name-only 2>/dev/null || true
    git ls-files --others --exclude-standard 2>/dev/null || true
  } | sed '/^$/d' | LC_ALL=C sort -u
)"

if [ -z "$changed" ]; then
  echo "OK: no forbidden path changes detected."
  exit 0
fi

violations="$(printf '%s\n' "$changed" | grep -E "$forbidden" || true)"
if [ -n "$violations" ]; then
  echo "SCOPE VIOLATION: changes under vendor/ are not allowed for this wave."
  printf '%s\n' "$violations" | LC_ALL=C sort -u
  exit 1
fi
echo "OK: no forbidden path changes detected."