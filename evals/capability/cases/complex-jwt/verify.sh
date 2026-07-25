#!/usr/bin/env bash
# Objective grader for complex-jwt. Runs from the copied fixture workdir.
set -euo pipefail

# Middleware or auth helper must exist somewhere under src/
if ! grep -R --include='*.ts' -E 'JWT|Bearer|Authorization|demo-secret|hmac|HMAC' src >/dev/null 2>&1; then
  echo "FAIL: no JWT/auth-related implementation found under src/"
  exit 1
fi

# 401 handling must appear (routes or middleware)
if ! grep -R --include='*.ts' -E '\b401\b' src >/dev/null 2>&1; then
  echo "FAIL: no 401 status handling found under src/"
  exit 1
fi

# Tests should mention auth or 401
if ! grep -R --include='*.ts' -E '401|Bearer|auth|unauth' tests >/dev/null 2>&1; then
  echo "FAIL: no auth-related coverage found under tests/"
  exit 1
fi

bun test
echo "PASS: complex-jwt"
