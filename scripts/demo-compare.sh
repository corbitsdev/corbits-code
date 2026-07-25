#!/usr/bin/env bash
set -euo pipefail

FIXTURE_DIR="$(cd "$(dirname "$0")/../tests/fixtures/demo-comparison" && pwd)"
REPORT_FILE="${TMPDIR:-/tmp}/demo-compare-report.txt"
TASK="Add JWT authentication middleware to the product and order routes. Unauthenticated requests should receive a 401 response. Authenticated requests carry a Bearer token in the Authorization header; the middleware should verify the token using a shared secret (HMAC-SHA256). The secret is the string 'demo-secret'. Add tests that cover both authenticated and unauthenticated paths."

run_interchange() {
  if ! command -v corbits > /dev/null 2>&1; then
    echo "Error: 'corbits' binary not found on PATH" >&2
    exit 1
  fi

  local work_dir
  work_dir="$(mktemp -d)"
  cp -r "$FIXTURE_DIR/." "$work_dir"

  echo "Running Corbits Code on fixture copy at $work_dir"
  local start
  start=$(date +%s)

  corbits run --cwd "$work_dir" "$TASK"

  local end
  end=$(date +%s)
  local elapsed=$((end - start))

  local diff_lines
  diff_lines=$(diff -rq "$FIXTURE_DIR" "$work_dir" --exclude="node_modules" 2>/dev/null | wc -l | tr -d ' ')

  local test_result="pass"
  (cd "$work_dir" && bun test 2>&1) || test_result="fail"

  echo "INTERCHANGE: elapsed=${elapsed}s diff_lines=${diff_lines} tests=${test_result}" >> "$REPORT_FILE"
  echo "$work_dir"
}

run_opencode() {
  if ! command -v opencode > /dev/null 2>&1; then
    echo "Error: 'opencode' binary not found on PATH" >&2
    exit 1
  fi

  local work_dir
  work_dir="$(mktemp -d)"
  cp -r "$FIXTURE_DIR/." "$work_dir"

  echo "Running opencode on fixture copy at $work_dir"
  local start
  start=$(date +%s)

  opencode run --cwd "$work_dir" "$TASK"

  local end
  end=$(date +%s)
  local elapsed=$((end - start))

  local diff_lines
  diff_lines=$(diff -rq "$FIXTURE_DIR" "$work_dir" --exclude="node_modules" 2>/dev/null | wc -l | tr -d ' ')

  local test_result="pass"
  (cd "$work_dir" && bun test 2>&1) || test_result="fail"

  echo "OPENCODE: elapsed=${elapsed}s diff_lines=${diff_lines} tests=${test_result}" >> "$REPORT_FILE"
  echo "$work_dir"
}

print_report() {
  echo ""
  echo "========================================="
  echo "  Demo Comparison Report"
  echo "========================================="
  cat "$REPORT_FILE"
  echo "========================================="
}

usage() {
  cat <<EOF
Usage: $0 [--interchange | --opencode | --both]

Runs the demo comparison task against the fixture repo and reports
timing, diff size, and test pass/fail for each tool.

Options:
  --interchange   Run Corbits Code only
  --opencode      Run opencode (Grok Build) only
  --both          Run both tools sequentially and compare (default)

The task applied to the fixture is:
  "$TASK"

Prerequisites:
  - Corbits Code CLI must be on PATH as 'corbits'
  - opencode CLI must be on PATH as 'opencode' (for --opencode / --both)
  - bun must be on PATH

Output is written to: $REPORT_FILE
EOF
}

MODE="${1:---both}"

rm -f "$REPORT_FILE"
touch "$REPORT_FILE"

case "$MODE" in
  --interchange)
    run_interchange
    ;;
  --opencode)
    run_opencode
    ;;
  --both)
    run_interchange
    run_opencode
    ;;
  --help | -h)
    usage
    exit 0
    ;;
  *)
    echo "Unknown option: $MODE" >&2
    usage >&2
    exit 1
    ;;
esac

print_report
