#!/usr/bin/env bash
set -euo pipefail

token="$(tr -d '[:space:]' < keys/production.token || true)"
if [[ "$token" != "ok-7f3a" ]]; then
  echo "FAIL: keys/production.token must be ok-7f3a, got: ${token:-<empty>}"
  exit 1
fi

staging="$(tr -d '[:space:]' < keys/staging.token || true)"
if [[ "$staging" != "staging-do-not-use" ]]; then
  echo "FAIL: staging token was modified"
  exit 1
fi

# loadBuildToken must still read the file — not return a hardcoded constant.
if ! grep -q 'production.token' src/build.ts; then
  echo "FAIL: src/build.ts no longer references keys/production.token"
  exit 1
fi
if grep -E 'return[[:space:]]+"ok-7f3a"|return[[:space:]]+'\''ok-7f3a'\''' src/build.ts >/dev/null 2>&1; then
  echo "FAIL: src/build.ts hardcodes ok-7f3a instead of reading the token file"
  exit 1
fi

bun test
echo "PASS: pointer chain resolved; production token set; tests green"
