#!/usr/bin/env bash
# Objective grader for simple-health. Runs from the copied fixture workdir.
set -euo pipefail

if ! grep -R --include='*.ts' -E '/health|health' src >/dev/null 2>&1; then
  echo "FAIL: no health route/reference found under src/"
  exit 1
fi

if ! grep -R --include='*.ts' -E 'status.*ok|ok.*status' src tests >/dev/null 2>&1; then
  echo "FAIL: no status ok payload found under src/ or tests/"
  exit 1
fi

bun test
echo "PASS: simple-health"
