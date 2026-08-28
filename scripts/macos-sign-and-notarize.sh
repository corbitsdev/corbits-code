#!/usr/bin/env bash

set -euo pipefail

fail() {
  printf 'macOS release validation failed: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 3 ] || fail "usage: $0 sign|notarize|verify ARTIFACT arm64|x86_64"
operation=$1
artifact=$2
expected_arch=$3

case "$operation" in
  sign|notarize|verify) ;;
  *) fail "unknown operation: $operation" ;;
esac
case "$expected_arch" in
  arm64|x86_64) ;;
  *) fail "unsupported architecture: $expected_arch" ;;
esac

[ "$(uname -s)" = Darwin ] || fail "signing and validation must run on macOS"
[ -f "$artifact" ] || fail "artifact does not exist"
[ -x "$artifact" ] || fail "artifact is not executable"

for tool in codesign ditto jq lipo plutil spctl xcrun; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool"
done
xcrun --find notarytool >/dev/null 2>&1 || fail "notarytool is unavailable"

: "${MACOS_SIGNING_IDENTITY:?MACOS_SIGNING_IDENTITY must name a Developer ID Application identity}"
: "${MACOS_TEAM_ID:?MACOS_TEAM_ID must contain the expected Apple Team ID}"
: "${MACOS_NOTARY_PROFILE:?MACOS_NOTARY_PROFILE must name a notarytool Keychain profile}"

case "$MACOS_SIGNING_IDENTITY" in
  "Developer ID Application: "*) ;;
  *) fail "MACOS_SIGNING_IDENTITY must name a Developer ID Application certificate" ;;
esac
[[ "$MACOS_TEAM_ID" =~ ^[A-Z0-9]{10}$ ]] || fail "MACOS_TEAM_ID must be a 10-character Team ID"

script_dir=$(cd "$(dirname "$0")" && pwd)
entitlements="$script_dir/macos-entitlements.plist"
[ -f "$entitlements" ] || fail "source-controlled entitlements are missing"

temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT

verify_artifact() {
  local assess_with_gatekeeper=$1
  local details actual_entitlements expected_entitlements architectures

  codesign --verify --strict --verbose=2 "$artifact" >/dev/null 2>&1 || fail "strict code-signature verification failed"
  details=$(codesign -dv --verbose=4 "$artifact" 2>&1) || fail "could not inspect code signature"
  grep -Fqx "Authority=$MACOS_SIGNING_IDENTITY" <<< "$details" || fail "signer identity does not match"
  grep -Fqx "TeamIdentifier=$MACOS_TEAM_ID" <<< "$details" || fail "Team ID does not match"

  actual_entitlements="$temporary_directory/actual-entitlements.plist"
  expected_entitlements="$temporary_directory/expected-entitlements.plist"
  codesign -d --entitlements :- "$artifact" >"$actual_entitlements" 2>/dev/null || fail "could not read signed entitlements"
  plutil -convert xml1 -o "$actual_entitlements.normalized" "$actual_entitlements" >/dev/null || fail "signed entitlements are malformed"
  plutil -convert xml1 -o "$expected_entitlements" "$entitlements" >/dev/null || fail "release entitlements are malformed"
  cmp -s "$actual_entitlements.normalized" "$expected_entitlements" || fail "signed entitlements do not exactly match the release entitlements"

  architectures=$(lipo -archs "$artifact" 2>/dev/null) || fail "could not inspect Mach-O architecture"
  [ "$architectures" = "$expected_arch" ] || fail "artifact architecture is not exactly $expected_arch"
  if [ "$assess_with_gatekeeper" = 1 ]; then
    spctl -a -t exec -vv "$artifact" >/dev/null 2>&1 || fail "Gatekeeper assessment failed"
  fi
}

if [ "$operation" = sign ]; then
  codesign --force --options runtime --timestamp --entitlements "$entitlements" \
    --sign "$MACOS_SIGNING_IDENTITY" "$artifact" >/dev/null || fail "code signing failed"
  verify_artifact 0
elif [ "$operation" = notarize ]; then
  verify_artifact 0
  archive="$temporary_directory/notarization.zip"
  result="$temporary_directory/notary-result.json"
  ditto -c -k --keepParent "$artifact" "$archive" || fail "could not create notarization archive"
  xcrun notarytool submit "$archive" --keychain-profile "$MACOS_NOTARY_PROFILE" \
    --wait --output-format json >"$result" || fail "notary submission failed"
  status=$(jq -er '.status | select(type == "string")' "$result" 2>/dev/null) || fail "notarytool returned malformed JSON"
  [ "$status" = Accepted ] || fail "notary status was not Accepted"
  verify_artifact 1
else
  verify_artifact 1
fi
