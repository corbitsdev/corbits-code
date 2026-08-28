#!/usr/bin/env bash
#
# Download one @opentui/core-* native package and unpack it only after the
# tarball matches the sha512 integrity recorded in bun.lock.
#
#   scripts/fetch-opentui-native.sh PACKAGE VERSION DEST_DIR [LOCKFILE]
#
# PACKAGE is the short name after @opentui/, e.g. core-darwin-arm64.

set -euo pipefail

fail() {
  printf 'OpenTUI native fetch failed: %s\n' "$1" >&2
  exit 1
}

[ "$#" -eq 3 ] || [ "$#" -eq 4 ] || fail "usage: $0 PACKAGE VERSION DEST_DIR [LOCKFILE]"
pkg=$1
version=$2
dest=$3
lockfile=${4:-bun.lock}

[[ "$pkg" =~ ^core-[A-Za-z0-9_-]+$ ]] || fail "unsupported OpenTUI package name: $pkg"
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][A-Za-z0-9.-]+)?$ ]] || fail "invalid package version: $version"
[ -f "$lockfile" ] || fail "lockfile not found: $lockfile"

for tool in curl openssl tar awk mkdir rm; do
  command -v "$tool" >/dev/null 2>&1 || fail "missing tool: $tool"
done

# Match the packages-array entry ("@opentui/pkg": [ ... "sha512-..." ]), not a
# nested optionalDependencies version pin that shares the same package name on
# @opentui/core's line and would otherwise yield core's integrity hash.
integrity=$(awk -v key="\"@opentui/${pkg}\": [" '
  index($0, key) && match($0, /"sha512-[^"]+"/) {
    print substr($0, RSTART + 1, RLENGTH - 2)
    exit
  }
' "$lockfile")
[ -n "$integrity" ] || fail "no bun.lock integrity for @opentui/$pkg"

temporary_directory=$(mktemp -d)
trap 'rm -rf "$temporary_directory"' EXIT
tarball="$temporary_directory/$pkg-$version.tgz"
url="https://registry.npmjs.org/@opentui/$pkg/-/$pkg-$version.tgz"

curl -fsSL "$url" -o "$tarball" || fail "could not download @opentui/$pkg@$version"
actual="sha512-$(openssl dgst -sha512 -binary "$tarball" | openssl base64 -A)"
[ "$actual" = "$integrity" ] || fail "bun.lock integrity mismatch for @opentui/$pkg (checksum)"

rm -rf "$dest"
mkdir -p "$dest"
tar -xz -C "$dest" --strip-components=1 -f "$tarball" \
  || fail "could not unpack @opentui/$pkg@$version"
