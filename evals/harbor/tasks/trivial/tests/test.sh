#!/bin/bash
set -euo pipefail

mkdir -p /logs/verifier

if [ -f /app/hello.txt ] && [ "$(cat /app/hello.txt)" = "hello" ]; then
  echo 1 > /logs/verifier/reward.txt
  exit 0
fi

echo 0 > /logs/verifier/reward.txt
exit 1
