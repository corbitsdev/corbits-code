#!/usr/bin/env bash
set -euo pipefail

if grep -R --include='*.ts' -n 'addNumbers' src tests >/dev/null 2>&1; then
  echo "FAIL: addNumbers still present:"
  grep -R --include='*.ts' -n 'addNumbers' src tests || true
  exit 1
fi

if ! grep -R --include='*.ts' -n 'sumExact' src >/dev/null 2>&1; then
  echo "FAIL: sumExact not found in src"
  exit 1
fi

bun test
echo "PASS: addNumbers fully renamed to sumExact; tests green"
