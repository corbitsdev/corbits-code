#!/usr/bin/env bash
# Outcome check only — requireTools grades whether list_dir was actually called.
set -euo pipefail

if [[ ! -f RESULT.txt ]]; then
  echo "FAIL: RESULT.txt missing"
  exit 1
fi

if ! grep -q 'marker.txt' RESULT.txt; then
  echo "FAIL: RESULT.txt must mention marker.txt"
  exit 1
fi

if ! grep -q 'subdir' RESULT.txt; then
  echo "FAIL: RESULT.txt must mention subdir"
  exit 1
fi

echo "PASS: RESULT.txt lists marker.txt and subdir"
