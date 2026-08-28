#!/usr/bin/env bash
#
# release.sh -- cut a Corbits Code release and publish every artifact.
#
#   scripts/release.sh X.Y.Z [--notes FILE] [--skip-tap] [--skip-deb] [--no-push]
#
# End to end this:
#   1. bumps "version" in package.json,
#   2. commits "Release corbits X.Y.Z" locally (no tag yet -- see step 5),
#   3. cross-compiles standalone binaries (no runtime required) for
#      macOS arm64/x64 and Linux x64/arm64 with `bun build --compile`,
#   4. smoke-tests the host-native binary, then packages each target as a
#      .tar.gz (+ .sha256) and each Linux target as a .deb (built from stock
#      `ar` + `tar`, so no dpkg is needed),
#   5. lands the release commit on main through an auto-merged PR (a direct
#      push is rejected by the branch ruleset), then tags vX.Y.Z at the merged
#      main and pushes the tag -- both only after artifacts exist,
#   6. creates the GitHub release on corbitsdev/corbits-code with those assets,
#   7. regenerates the Homebrew formula (per-arch url + sha256) in the
#      corbitsdev/homebrew-tap tap and pushes it, so `brew install corbits-code` works.
#
# Every step is idempotent: a stage whose artifact already exists is skipped,
# so a half-finished release can be completed by re-running with the version.
# Push is deferred until after a successful build so a failed compile never
# publishes a tag without binaries.
#
# The release commit reaches main via a PR because main requires status checks
# and a direct push cannot satisfy them. The tag is cut only after that PR
# merges: a squash or rebase merge rewrites the commit SHA, and a tag cut
# earlier would point at a commit that is not in main. The PR is merged with
# --merge for the same reason.
#
# NOTE: do not pipe this script (e.g. `release.sh X.Y.Z | tail -40`) without
# `set -o pipefail` -- you get the pipe's exit code, not this script's, and a
# failed release reads as success.
#
# Requirements: run on a Mac with git, gh (authenticated), bun, jq, ar, tar,
# and shasum available. `bun build --compile` cross-compiles every target
# from here; no Linux host is needed. For the tap step, the corbitsdev/tap
# tap must be tapped (brew tap corbitsdev/tap) or reachable so it can clone.

set -euo pipefail

# ---- configuration ---------------------------------------------------------
MAIN_REPO="corbitsdev/corbits-code"         # source repo (releases + tags)
TAP_REPO="corbitsdev/homebrew-tap"          # tap repo (formula)
TAP_SLUG="corbitsdev/tap"                   # `brew tap' name of TAP_REPO
BINARY="corbits"                            # CLI binary + tarball/deb stem
BREW_FORMULA="corbits-code"                 # `brew install` name (file Formula/$BREW_FORMULA.rb)
FORMULA="$BINARY"                           # legacy alias used in package paths
DESC="Single-process coding agent CLI built on the Interchange runtime"
DOC_FILES=(LICENSE.md README.md CHANGELOG.md GPLv2-AI-Exception.md GPL-2.0.txt)  # shipped with the binary

# Build matrix: "label|bun-target|kind|deb-arch". kind is macos or linux;
# deb-arch is the Debian architecture for linux targets, "-" for macOS.
TARGETS=(
  "macos-arm64|bun-darwin-arm64|macos|-"
  "macos-x64|bun-darwin-x64|macos|-"
  "linux-x64|bun-linux-x64|linux|amd64"
  "linux-arm64|bun-linux-arm64|linux|arm64"
)

# ---- argument parsing ------------------------------------------------------
VERSION=""
NOTES_FILE=""
SKIP_TAP=0
SKIP_DEB=0
DO_PUSH=1
while [ $# -gt 0 ]; do
  case "$1" in
    --notes)    NOTES_FILE=${2:?--notes needs a file}; shift 2 ;;
    --skip-tap) SKIP_TAP=1; shift ;;
    --skip-deb) SKIP_DEB=1; shift ;;
    --no-push)  DO_PUSH=0; shift ;;
    -h|--help)  sed -n '2,28p' "$0"; exit 0 ;;
    -*)         echo "unknown option: $1" >&2; exit 2 ;;
    *)          if [ -z "$VERSION" ]; then VERSION=$1; shift
                else echo "unexpected argument: $1" >&2; exit 2; fi ;;
  esac
done
[ -n "$VERSION" ] || { echo "usage: $0 X.Y.Z [--notes FILE] [--skip-tap] [--skip-deb] [--no-push]" >&2; exit 2; }
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo "version must be X.Y.Z, got: $VERSION" >&2; exit 2; }

TAG="v$VERSION"
# main requires status checks, so the release commit lands via a PR, not a
# direct push. Matches the existing convention (release-0.2.104 -> PR #548).
RELEASE_BRANCH="release-$VERSION"
ROOT=$(git -C "$(dirname "$0")" rev-parse --show-toplevel)
cd "$ROOT"
STAGE="$ROOT/dist/release"
MAINTAINER="$(git config user.name) <$(git config user.email)>"

step()  { printf '\n\033[1;34m==>\033[0m \033[1m%s\033[0m\n' "$*"; }
info()  { printf '    %s\n' "$*"; }
skip()  { printf '    \033[2m(skip) %s\033[0m\n' "$*"; }
die()   { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Push a repo's HEAD (and optionally a ref) to origin. HTTPS remotes authenticate
# via `gh auth git-credential` (token never lands in argv/URLs/process lists).
# SSH remotes push directly.
git_push() {  # git_push DIR [REFSPEC...]
  local dir=$1; shift
  if [ "$DO_PUSH" != 1 ]; then skip "would: git -C $dir push origin ${*:-HEAD}"; return; fi
  local url; url=$(git -C "$dir" remote get-url origin)
  case "$url" in
    https://github.com/*|https://x-access-token:*@github.com/*)
      local slug
      slug=${url#*github.com/}; slug=${slug%.git}
      # Clear inherited helpers, then use only gh — keeps the token out of the
      # remote URL and out of `ps` argv.
      git -C "$dir" \
        -c credential.helper= \
        -c credential.helper='!gh auth git-credential' \
        push "https://github.com/${slug}.git" \
        "${@:-HEAD:$(git -C "$dir" symbolic-ref --short HEAD)}" ;;
    *) git -C "$dir" push origin "${@:-HEAD}" ;;
  esac
}

# Host-native release label (empty when uname is unrecognized). Used so we only
# smoke-test a binary we can actually exec.
host_label() {
  case "$(uname -s):$(uname -m)" in
    Darwin:arm64)          echo macos-arm64 ;;
    Darwin:x86_64)         echo macos-x64 ;;
    Linux:x86_64|Linux:amd64) echo linux-x64 ;;
    Linux:aarch64|Linux:arm64) echo linux-arm64 ;;
    *)                     echo "" ;;
  esac
}

# Compile one target. Flags match package.json "build:bin" (compile + minify +
# NODE_ENV=production) and add:
#   --target               cross-compile from the Mac host
#   --define DEV=false     dead-code-eliminate Ink's optional devtools import
# Do NOT --external react-devtools-core: standalone binaries have no
# node_modules; leaving it external makes first TUI load fail with
# "Cannot find package 'react-devtools-core'".
# Keep this block in sync with package.json "build:bin" when those flags change.
compile_bin() {  # compile_bin BUN_TARGET OUTFILE
  local target=$1 out=$2
  bun build ./src/index.ts --compile --target="$target" --minify \
    --define process.env.NODE_ENV='"production"' \
    --define process.env.DEV='"false"' \
    --outfile "$out" >/dev/null
}

# Smoke-test a freshly compiled native binary before packaging. Cross-compiled
# targets are skipped (cannot exec). Prefer --version/--help; otherwise any
# argv that loads the binary without entering the TUI is enough to prove the
# compile linked (unrecognized flags error after startup).
smoke_bin() {  # smoke_bin LABEL BINARY
  local label=$1 bin=$2
  local host; host=$(host_label)
  [ -n "$host" ] || return 0
  [ "$label" = "$host" ] || return 0
  info "smoke-testing $label"
  [ -x "$bin" ] || die "smoke: $label binary is not executable"
  if "$bin" --version >/dev/null 2>&1; then return 0; fi
  if "$bin" --help >/dev/null 2>&1; then return 0; fi
  local rc=0
  "$bin" --__release_smoke__ >/dev/null 2>&1 || rc=$?
  # 126 = cannot execute, 127 = not found — real link/exec failures.
  if [ "$rc" -eq 126 ] || [ "$rc" -eq 127 ]; then
    die "smoke: cannot execute $label binary (rc=$rc)"
  fi
  # Non-zero from "unrecognized flag" (or similar) still proves the binary ran.
  return 0
}

# tar a tree with root ownership (for reproducible .deb payloads). GNU tar and
# bsdtar spell the ownership override differently.
tar_root() {  # tar_root OUTPUT.tgz DIR PATH...
  local out=$1 dir=$2; shift 2
  if tar --version 2>&1 | grep -qi bsdtar; then
    ( cd "$dir" && tar --uid 0 --gid 0 --uname root --gname root -czf "$out" "$@" )
  else
    ( cd "$dir" && tar --owner=root:0 --group=root:0 -czf "$out" "$@" )
  fi
}

# Build a Debian package by hand: a .deb is an `ar` archive of debian-binary,
# control.tar.gz, and data.tar.gz (in that order). `ar rcS` keeps that order
# and skips the symbol table macOS `ar` would otherwise prepend.
build_deb() {  # build_deb BINARY DEB-ARCH OUTPUT.deb
  local bin=$1 arch=$2 out=$3
  local wd; wd=$(mktemp -d)
  mkdir -p "$wd/data/usr/bin" "$wd/data/usr/share/doc/$FORMULA" "$wd/ctrl"
  install -m 0755 "$bin" "$wd/data/usr/bin/$FORMULA"
  for f in "${DOC_FILES[@]}"; do cp "$ROOT/$f" "$wd/data/usr/share/doc/$FORMULA/"; done
  if [ -d "$ROOT/plugins" ]; then
    cp -R "$ROOT/plugins" "$wd/data/usr/bin/plugins"
  fi
  local kb; kb=$(( ( $(wc -c < "$bin") + 1023 ) / 1024 ))
  cat > "$wd/ctrl/control" <<EOF
Package: $FORMULA
Version: $VERSION
Architecture: $arch
Maintainer: $MAINTAINER
Installed-Size: $kb
Section: devel
Priority: optional
Homepage: https://github.com/$MAIN_REPO
Description: $DESC
 Corbits Code is a local-first coding agent that runs in your terminal and works
 with whatever model you point it at. The binary is self-contained; no
 separate runtime is required.
EOF
  tar_root "$wd/data.tar.gz" "$wd/data" ./usr
  tar_root "$wd/control.tar.gz" "$wd/ctrl" ./control
  printf '2.0\n' > "$wd/debian-binary"
  rm -f "$out"
  ( cd "$wd" && ar rcS "$out" debian-binary control.tar.gz data.tar.gz )
  rm -rf "$wd"
}

# The OpenTUI renderer ships its native core as one optional package per
# platform, and an install only ever lands the host's own. A cross-compile for
# any other target then fails to resolve it, so every target's package is
# fetched straight from the registry into node_modules before the build.
# Nothing is written to package.json: these are already declared there as
# optionalDependencies, and this only makes the ones bun skipped present.
fetch_native_modules() {
  local version platform pkg dir url variants bun_target _label _kind _deb
  version=$(jq -r '.optionalDependencies["@opentui/core-darwin-arm64"] // empty' package.json)
  [ -n "$version" ] || die "no @opentui/core-* version in package.json optionalDependencies"
  for entry in "${TARGETS[@]}"; do
    IFS='|' read -r _label bun_target _kind _deb <<< "$entry"
    platform=${bun_target#bun-}
    # A Linux binary picks glibc or musl at runtime, so both variants have to
    # resolve at compile time.
    variants="core-$platform"
    [ "$_kind" = linux ] && variants="$variants core-$platform-musl"
    for pkg in $variants; do
      dir="node_modules/@opentui/$pkg"
      [ -d "$dir" ] && continue
      url="https://registry.npmjs.org/@opentui/$pkg/-/$pkg-$version.tgz"
      info "fetching @opentui/$pkg@$version (cross-compile target)"
      mkdir -p "$dir"
      curl -fsSL "$url" | tar -xz -C "$dir" --strip-components=1 \
        || die "could not fetch @opentui/$pkg@$version from the registry"
    done
  done
}

# ---- preflight -------------------------------------------------------------
step "Preflight for $TAG"
for t in git gh bun jq ar tar shasum; do command -v "$t" >/dev/null || die "missing tool: $t"; done
gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"
info "installing dependencies (bun install)"
bun install >/dev/null 2>&1 || die "bun install failed"
fetch_native_modules
if [ "$SKIP_TAP" != 1 ]; then
  TAP_DIR=$(brew --repository "$TAP_SLUG" 2>/dev/null) || die "brew not found; use --skip-tap"
  if [ ! -d "$TAP_DIR/.git" ]; then
    info "tapping $TAP_SLUG"
    brew tap "$TAP_SLUG" >/dev/null 2>&1 || \
      die "cannot tap $TAP_SLUG. Create https://github.com/$TAP_REPO then: brew tap $TAP_SLUG"
  fi
  [ -z "$(git -C "$TAP_DIR" status --porcelain)" ] || \
    die "tap has local changes; clean $TAP_DIR before releasing"
  git -C "$TAP_DIR" pull --ff-only --quiet
  info "tap:  $TAP_DIR (fast-forwarded)"
fi
info "repo: $ROOT"

# Resolve release notes: explicit --notes, else the matching CHANGELOG.md
# section plus a standard Install footer. CHANGELOG is the only product-notes
# source — do not reintroduce scripts/notes/ or docs/release-notes-* copies.
NOTES_TMP=$(mktemp)
trap 'rm -f "$NOTES_TMP"' EXIT
if [ -n "$NOTES_FILE" ]; then
  [ -f "$NOTES_FILE" ] || die "notes file not found: $NOTES_FILE"
  info "notes: $NOTES_FILE (override)"
  cat "$NOTES_FILE" > "$NOTES_TMP"
else
  [ -f CHANGELOG.md ] || die "CHANGELOG.md missing at repo root"
  # Body of ## [X.Y.Z] … until the next ## [ header (header line itself omitted).
  SECTION=$(awk -v ver="$VERSION" '
    BEGIN { keep = 0 }
    /^## \[/ {
      if (index($0, "[" ver "]") > 0) { keep = 1; next }
      if (keep) exit
      next
    }
    keep { print }
  ' CHANGELOG.md)
  if [ -z "$(printf '%s' "$SECTION" | sed '/^[[:space:]]*$/d')" ]; then
    die "no ## [$VERSION] section in CHANGELOG.md — rename [Unreleased] first"
  fi
  {
    printf '%s\n\n' "$SECTION"
    echo "## Install"
    echo
    echo "### macOS (Homebrew)"
    echo
    echo '```'
    echo "brew install $TAP_SLUG/$BREW_FORMULA"
    echo '```'
    echo
    echo "### Debian / Ubuntu"
    echo
    echo '```'
    echo "sudo dpkg -i ${BINARY}_${VERSION}_amd64.deb   # or _arm64.deb"
    echo '```'
    echo
    echo "### Any macOS or Linux (tarball)"
    echo
    echo "Download the matching \`$BINARY-$VERSION-<platform>.tar.gz\` below,"
    echo "extract, and put the \`$BINARY\` binary on your PATH. It is"
    echo "self-contained; no runtime is required."
  } > "$NOTES_TMP"
  info "notes: CHANGELOG.md ## [$VERSION] + install footer"
fi
NOTES_FILE="$NOTES_TMP"

# ---- 1-2. version bump and release commit (local; tagged after the merge) --
# The tag is deliberately NOT cut here. The release commit reaches main through
# a PR (step 4), and a squash or rebase merge would rewrite its SHA and leave
# the tag pointing at a commit that is not in main. Nothing before step 4b
# needs the tag to exist, so it is created once the commit is actually on main.
step "Version and release commit (local)"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  skip "tag $TAG already exists"
  cur=$(jq -r .version package.json)
  [ "$cur" = "$VERSION" ] || info "note: package.json says $cur, not $VERSION (tag already cut)"
elif [ "$(jq -r .version package.json)" = "$VERSION" ]; then
  skip "package.json already at $VERSION (release commit exists or is merged)"
else
  [ -z "$(git status --porcelain)" ] || die "working tree not clean; commit or stash first"
  jq --arg v "$VERSION" '.version = $v' package.json > package.json.tmp
  mv package.json.tmp package.json
  [ "$(jq -r .version package.json)" = "$VERSION" ] || die "package.json bump failed"
  git add package.json
  git commit -q -m "Release $FORMULA $VERSION"
  info "committed release $VERSION (PR and tag deferred until after build)"
fi

# ---- 3. build binaries, smoke, tarballs, and debs --------------------------
step "Build standalone binaries and packages"
mkdir -p "$STAGE"
for entry in "${TARGETS[@]}"; do
  IFS='|' read -r label target kind debarch <<< "$entry"
  pkg="$FORMULA-$VERSION-$label"
  tarball="$STAGE/$pkg.tar.gz"
  if [ -f "$tarball" ] && [ -f "$tarball.sha256" ]; then
    skip "$pkg.tar.gz already built"
  else
    info "compiling $label ($target)"
    bin="$STAGE/$FORMULA-$label.bin"
    compile_bin "$target" "$bin"
    [ -s "$bin" ] || die "compile produced no binary for $label"
    smoke_bin "$label" "$bin"
    rm -rf "$STAGE/$pkg"; mkdir -p "$STAGE/$pkg"
    cp "$bin" "$STAGE/$pkg/$FORMULA"; chmod 755 "$STAGE/$pkg/$FORMULA"
    for f in "${DOC_FILES[@]}"; do cp "$ROOT/$f" "$STAGE/$pkg/"; done
    # First-party plugins sit next to the binary (discoverRepoPlugins execPath).
    if [ -d "$ROOT/plugins" ]; then
      cp -R "$ROOT/plugins" "$STAGE/$pkg/plugins"
    fi
    tar -C "$STAGE" -czf "$tarball" "$pkg"
    ( cd "$STAGE" && shasum -a 256 "$pkg.tar.gz" > "$pkg.tar.gz.sha256" )
    rm -rf "$STAGE/$pkg"
    info "packaged $pkg.tar.gz ($(cd "$STAGE" && du -h "$pkg.tar.gz" | cut -f1))"
  fi

  # Debian package for the Linux targets.
  if [ "$kind" = "linux" ] && [ "$SKIP_DEB" != 1 ]; then
    deb="$STAGE/${FORMULA}_${VERSION}_${debarch}.deb"
    if [ -f "$deb" ] && [ -f "$deb.sha256" ]; then
      skip "$(basename "$deb") already built"
    else
      bin="$STAGE/$FORMULA-$label.bin"
      [ -s "$bin" ] || {  # tarball was cached: recompile the raw binary for the deb
        info "recompiling $label for .deb"
        compile_bin "$target" "$bin"
        [ -s "$bin" ] || die "recompile produced no binary for $label"
        smoke_bin "$label" "$bin"
      }
      build_deb "$bin" "$debarch" "$deb"
      ( cd "$STAGE" && shasum -a 256 "$(basename "$deb")" > "$(basename "$deb").sha256" )
      info "packaged $(basename "$deb") ($(du -h "$deb" | cut -f1))"
    fi
  fi
  rm -f "$STAGE/$FORMULA-$label.bin"
done

# ---- 4. land the release commit on main via PR, then tag ------------------
# A direct push to main is rejected by the branch ruleset ("N of N required
# status checks are expected"), so the commit goes through a PR that GitHub
# auto-merges once those same checks pass. --merge (never --squash/--rebase)
# keeps the release commit's SHA intact. Idempotent at every stage so a
# re-run after a failure resumes rather than duplicating.
step "Land release commit on $MAIN_REPO main"
remote_version() { git show origin/main:package.json 2>/dev/null | jq -r .version 2>/dev/null || echo ""; }
if [ "$DO_PUSH" != 1 ]; then
  skip "would: push $RELEASE_BRANCH, open+merge its PR, then tag $TAG"
else
  git fetch origin main --quiet --no-tags
  if [ "$(remote_version)" = "$VERSION" ]; then
    skip "release commit for $VERSION is already on main"
  else
    git_push "$ROOT" "HEAD:refs/heads/$RELEASE_BRANCH"
    PR_NUM=$(gh pr list --repo "$MAIN_REPO" --head "$RELEASE_BRANCH" --state open \
      --json number --jq '.[0].number // empty')
    if [ -z "$PR_NUM" ]; then
      gh pr create --repo "$MAIN_REPO" --head "$RELEASE_BRANCH" --base main \
        --title "Release $FORMULA $VERSION" \
        --body "Version bump to $VERSION. Release notes are the CHANGELOG.md \`## [$VERSION]\` section." >/dev/null
      PR_NUM=$(gh pr list --repo "$MAIN_REPO" --head "$RELEASE_BRANCH" --state open \
        --json number --jq '.[0].number // empty')
      [ -n "$PR_NUM" ] || die "could not create or find the release PR for $RELEASE_BRANCH"
      info "opened release PR #$PR_NUM"
    else
      info "reusing open release PR #$PR_NUM"
    fi
    # Auto-merge lets the required checks be the gate without polling them here.
    gh pr merge "$PR_NUM" --repo "$MAIN_REPO" --merge --auto --delete-branch >/dev/null \
      || die "could not arm auto-merge on PR #$PR_NUM"
    info "waiting for required checks and auto-merge on #$PR_NUM"
    merged=0
    for _ in $(seq 1 160); do   # 160 * 15s = 40 min ceiling
      state=$(gh pr view "$PR_NUM" --repo "$MAIN_REPO" --json state --jq .state 2>/dev/null || echo "")
      case "$state" in
        MERGED) merged=1; break ;;
        CLOSED) die "release PR #$PR_NUM was closed without merging" ;;
      esac
      sleep 15
    done
    [ "$merged" = 1 ] || die "release PR #$PR_NUM did not merge in time; check its status checks, then re-run"
    info "PR #$PR_NUM merged"
    git fetch origin main --quiet --no-tags
    [ "$(remote_version)" = "$VERSION" ] || die "main is not at $VERSION after merge; aborting before tag"
  fi
fi

# ---- 4b. tag the merged release commit ------------------------------------
step "Tag $TAG"
if git ls-remote --exit-code --tags origin "refs/tags/$TAG" >/dev/null 2>&1; then
  skip "tag $TAG already on origin"
else
  if ! git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
    if [ "$DO_PUSH" = 1 ]; then
      git tag -a "$TAG" -m "$FORMULA $VERSION" "origin/main"
      info "tagged $TAG at origin/main"
    else
      git tag -a "$TAG" -m "$FORMULA $VERSION"
      info "tagged $TAG at HEAD (--no-push)"
    fi
  fi
  git_push "$ROOT" "$TAG"
fi

# ---- 5. GitHub release on the main repo ------------------------------------
step "GitHub release on $MAIN_REPO"
ASSETS=()
# Only this version — dist/release keeps prior builds for local caching.
for f in \
  "$STAGE"/"$BINARY-$VERSION"-*.tar.gz \
  "$STAGE"/"$BINARY-$VERSION"-*.tar.gz.sha256 \
  "$STAGE"/"${BINARY}_${VERSION}_"*.deb \
  "$STAGE"/"${BINARY}_${VERSION}_"*.deb.sha256
do
  [ -e "$f" ] && ASSETS+=("$f")
done
[ "${#ASSETS[@]}" -gt 0 ] || die "no assets for $VERSION in $STAGE"
if [ "$DO_PUSH" != 1 ]; then
  skip "would: create/refresh release $TAG on $MAIN_REPO with ${#ASSETS[@]} assets"
elif gh release view "$TAG" --repo "$MAIN_REPO" >/dev/null 2>&1; then
  skip "release $TAG exists -- refreshing assets"
  gh release upload "$TAG" "${ASSETS[@]}" --repo "$MAIN_REPO" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" \
    --repo "$MAIN_REPO" --title "$BINARY $VERSION" --notes-file "$NOTES_FILE"
  info "created release $TAG with ${#ASSETS[@]} assets"
fi

# ---- 6. regenerate the tap formula -----------------------------------------
if [ "$SKIP_TAP" = 1 ]; then
  step "Homebrew formula (skipped: --skip-tap)"
else
  step "Update $TAP_SLUG formula ($BREW_FORMULA)"
  sha_for() {  # sha_for LABEL -> sha256 of that tarball
    cut -d' ' -f1 "$STAGE/$BINARY-$VERSION-$1.tar.gz.sha256"
  }
  bun "$ROOT/scripts/generate-homebrew-tap.ts" \
    "$TAP_DIR" \
    "$VERSION" \
    "$(sha_for macos-arm64)" \
    "$(sha_for macos-x64)" \
    "$(sha_for linux-arm64)" \
    "$(sha_for linux-x64)"

  tap_status=$(bash "$ROOT/scripts/prepare-homebrew-tap-release.sh" "$TAP_DIR" "$VERSION")
  case "$tap_status" in
    push-required)
      info "formula and rename metadata ready to push"
      git_push "$TAP_DIR" ;;
    current) skip "formula and rename metadata already at $VERSION" ;;
    *) die "unexpected tap preparation status: $tap_status" ;;
  esac
fi

# ---- done ------------------------------------------------------------------
step "Done: $TAG released"
info "release: https://github.com/$MAIN_REPO/releases/tag/$TAG"
[ "$SKIP_TAP" = 1 ] || info "install: brew install $TAP_SLUG/$BREW_FORMULA"
info "verify:  brew update && brew upgrade $BREW_FORMULA"
