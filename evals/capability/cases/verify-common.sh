#!/usr/bin/env bash
# Shared prelude sourced by the tier grader verify.sh scripts. Sets strict
# mode and provides the locked-contract guard plus the visible-suite runner.
# Per-tier assertions stay inline in each verify.sh.
set -euo pipefail

# check_contract <contract-test-path>: fail unless the file exists and is
# byte-identical to $TEST_SHA (set by the caller before calling).
check_contract() {
  local contract="$1"
  [[ -f package.json ]] || { echo "FAIL: package.json missing in workdir"; exit 1; }
  [[ -f "$contract" ]] || { echo "FAIL: $contract is gone"; exit 1; }

  local actual_sha setup_sha
  actual_sha=$(shasum -a 256 "$contract" | cut -d' ' -f1)
  if [[ "$actual_sha" != "$TEST_SHA" ]]; then
    # A stale TEST_SHA is indistinguishable from an agent edit above, so check
    # the fixture's own hash at setup before blaming the agent: the workdir is
    # a git repo committed before the run, so HEAD holds the pristine file.
    setup_sha=$(git show "HEAD:$contract" 2>/dev/null | shasum -a 256 | cut -d' ' -f1 || true)
    if [[ -n "$setup_sha" && "$actual_sha" == "$setup_sha" ]]; then
      echo "FAIL: $contract is unchanged from the fixture at setup ($setup_sha) but does not match TEST_SHA ($TEST_SHA): the case's locked hash is stale (broken case), not an agent edit"
      exit 1
    fi
    echo "FAIL: $contract was modified (contract file must be byte-unchanged)"
    exit 1
  fi
}

# run_visible_suite <log-file> <fail-message>: fail (after printing the log)
# unless `bun test` passes in the workdir. Callers pass a full `FAIL: ...`
# line; this helper prints it as-is.
run_visible_suite() {
  local log="$1"
  local fail_message="$2"
  if ! bun test >"$log" 2>&1; then
    cat "$log"
    echo "$fail_message"
    exit 1
  fi
}
