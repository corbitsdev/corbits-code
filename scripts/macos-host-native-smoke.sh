#!/usr/bin/env bash
#
# Host-native OpenTUI smoke for a signed macOS release binary.
#
#   scripts/macos-host-native-smoke.sh LABEL BINARY
#
# Exit codes:
#   0 — host architecture matched and the signed binary initialized OpenTUI
#   2 — LABEL is not the host architecture (caller must not count native smoke)
#   1 — host architecture matched but smoke failed
#
# Opposite-arch artifacts are never executed and never reported as smoked.

set -euo pipefail

fail() {
  printf 'macOS host-native smoke failed: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 2 ] || fail "usage: $0 LABEL BINARY"
label=$1
artifact=$2

host_label() {
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64) echo macos-arm64 ;;
    Darwin:x86_64) echo macos-x64 ;;
    *) echo "" ;;
  esac
}

host=$(host_label)
[ -n "$host" ] || fail "host architecture is unrecognized; cannot run native smoke"
if [ "$label" != "$host" ]; then
  exit 2
fi

[ -f "$artifact" ] || fail "artifact does not exist"
[ -x "$artifact" ] || fail "artifact is not executable"
"$artifact" --__release_native_smoke__ >/dev/null 2>&1 \
  || fail "signed $label binary could not initialize OpenTUI native library"
