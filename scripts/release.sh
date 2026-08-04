#!/usr/bin/env bash
#
# release.sh -- cut a Corbits Code release and publish every artifact.
#
#   scripts/release.sh X.Y.Z [--notes FILE] [--skip-tap] [--skip-deb] [--no-push]
#
# End to end this:
#   1. bumps "version" in package.json,
#   2. commits "Release corbits X.Y.Z" and tags vX.Y.Z locally (no push yet),
#   3. cross-compiles standalone binaries (no runtime required) for
#      macOS arm64/x64 and Linux x64/arm64 with `bun build --compile`,
#   4. smoke-tests the host-native binary, then packages each target as a
#      .tar.gz (+ .sha256) and each Linux target as a .deb (built from stock
#      `ar` + `tar`, so no dpkg is needed),
#   5. pushes the release commit and tag only after artifacts exist,
#   6. creates the GitHub release on corbitsdev/corbits-code with those assets,
#   7. regenerates the Homebrew formula (per-arch url + sha256) in the
#      corbitsdev/homebrew-tap tap and pushes it, so `brew install corbits` works.
#
# Every step is idempotent: a stage whose artifact already exists is skipped,
# so a half-finished release can be completed by re-running with the version.
# Push is deferred until after a successful build so a failed compile never
# publishes a tag without binaries.
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
FORMULA="corbits"                           # formula / binary name
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
#   --external react-devtools-core  keep the optional dep out of the binary
# Keep this block in sync with package.json "build:bin" when those flags change.
compile_bin() {  # compile_bin BUN_TARGET OUTFILE
  local target=$1 out=$2
  bun build ./src/index.ts --compile --target="$target" --minify \
    --define process.env.NODE_ENV='"production"' \
    --define process.env.DEV='"false"' \
    --external react-devtools-core \
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

# ---- preflight -------------------------------------------------------------
step "Preflight for $TAG"
for t in git gh bun jq ar tar shasum; do command -v "$t" >/dev/null || die "missing tool: $t"; done
gh auth status >/dev/null 2>&1 || die "gh is not authenticated (run: gh auth login)"
info "installing dependencies (bun install)"
bun install >/dev/null 2>&1 || die "bun install failed"
if [ "$SKIP_TAP" != 1 ]; then
  TAP_DIR=$(brew --repository "$TAP_SLUG" 2>/dev/null) || die "brew not found; use --skip-tap"
  if [ ! -d "$TAP_DIR/.git" ]; then
    info "tapping $TAP_SLUG"
    brew tap "$TAP_SLUG" >/dev/null 2>&1 || \
      die "cannot tap $TAP_SLUG. Create https://github.com/$TAP_REPO then: brew tap $TAP_SLUG"
  fi
  info "tap:  $TAP_DIR"
fi
info "repo: $ROOT"

# Resolve release notes: explicit --notes, else scripts/notes/<tag>.md, else
# a generated body with the standard install instructions.
if [ -z "$NOTES_FILE" ] && [ -f "scripts/notes/$TAG.md" ]; then NOTES_FILE="scripts/notes/$TAG.md"; fi
NOTES_TMP=""
if [ -n "$NOTES_FILE" ]; then
  [ -f "$NOTES_FILE" ] || die "notes file not found: $NOTES_FILE"
  info "notes: $NOTES_FILE"
else
  NOTES_TMP=$(mktemp); NOTES_FILE="$NOTES_TMP"
  {
    echo "# $FORMULA $VERSION"; echo
    echo "## Install"; echo
    echo "### macOS (Homebrew)"; echo
    echo '```'
    echo "brew tap $TAP_SLUG && brew install $FORMULA"
    echo '```'; echo
    echo "### Debian / Ubuntu"; echo
    echo '```'
    echo "sudo dpkg -i ${FORMULA}_${VERSION}_amd64.deb   # or _arm64.deb"
    echo '```'; echo
    echo "### Any macOS or Linux (tarball)"; echo
    echo "Download the matching \`$FORMULA-$VERSION-<platform>.tar.gz\` below,"
    echo "extract, and put the \`$FORMULA\` binary on your PATH. It is"
    echo "self-contained; no runtime is required."
  } > "$NOTES_TMP"
  info "notes: (generated -- no scripts/notes/$TAG.md found)"
fi
trap '[ -n "$NOTES_TMP" ] && rm -f "$NOTES_TMP"' EXIT

# ---- 1-2. version bump, commit, tag (local only; push after build) ---------
step "Version, commit, and tag (local)"
if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  skip "tag $TAG already exists"
  cur=$(jq -r .version package.json)
  [ "$cur" = "$VERSION" ] || info "note: package.json says $cur, not $VERSION (tag already cut)"
else
  [ -z "$(git status --porcelain)" ] || die "working tree not clean; commit or stash first"
  jq --arg v "$VERSION" '.version = $v' package.json > package.json.tmp
  mv package.json.tmp package.json
  [ "$(jq -r .version package.json)" = "$VERSION" ] || die "package.json bump failed"
  git add package.json
  git commit -q -m "Release $FORMULA $VERSION"
  git tag -a "$TAG" -m "$FORMULA $VERSION"
  info "committed and tagged $TAG (push deferred until after build)"
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

# ---- 4. push commit + tag only after artifacts exist -----------------------
step "Push release commit and tag"
git_push "$ROOT"
git_push "$ROOT" "$TAG"

# ---- 5. GitHub release on the main repo ------------------------------------
step "GitHub release on $MAIN_REPO"
ASSETS=()
for f in "$STAGE"/*.tar.gz "$STAGE"/*.tar.gz.sha256 "$STAGE"/*.deb "$STAGE"/*.deb.sha256; do
  [ -e "$f" ] && ASSETS+=("$f")
done
if gh release view "$TAG" --repo "$MAIN_REPO" >/dev/null 2>&1; then
  skip "release $TAG exists -- refreshing assets"
  gh release upload "$TAG" "${ASSETS[@]}" --repo "$MAIN_REPO" --clobber
else
  gh release create "$TAG" "${ASSETS[@]}" \
    --repo "$MAIN_REPO" --title "$FORMULA $VERSION" --notes-file "$NOTES_FILE"
  info "created release $TAG with ${#ASSETS[@]} assets"
fi

# ---- 6. regenerate the tap formula -----------------------------------------
if [ "$SKIP_TAP" = 1 ]; then
  step "Homebrew formula (skipped: --skip-tap)"
else
  step "Update $TAP_SLUG formula"
  sha_for() {  # sha_for LABEL -> sha256 of that tarball
    cut -d' ' -f1 "$STAGE/$FORMULA-$VERSION-$1.tar.gz.sha256"
  }
  url_for() {  # url_for LABEL -> download URL for that tarball
    echo "https://github.com/$MAIN_REPO/releases/download/$TAG/$FORMULA-$VERSION-$1.tar.gz"
  }
  class=$(echo "$FORMULA" | awk '{print toupper(substr($0,1,1)) substr($0,2)}')
  mkdir -p "$TAP_DIR/Formula"
  cat > "$TAP_DIR/Formula/$FORMULA.rb" <<EOF
class $class < Formula
  desc "$DESC"
  homepage "https://github.com/$MAIN_REPO"
  version "$VERSION"
  license "GPL-2.0-only"

  on_macos do
    on_arm do
      url "$(url_for macos-arm64)"
      sha256 "$(sha_for macos-arm64)"
    end
    on_intel do
      url "$(url_for macos-x64)"
      sha256 "$(sha_for macos-x64)"
    end
  end

  on_linux do
    on_arm do
      url "$(url_for linux-arm64)"
      sha256 "$(sha_for linux-arm64)"
    end
    on_intel do
      url "$(url_for linux-x64)"
      sha256 "$(sha_for linux-x64)"
    end
  end

  def install
    bin.install "$FORMULA"
  end

  test do
    assert_predicate bin/"$FORMULA", :executable?
  end
end
EOF
  if git -C "$TAP_DIR" rev-parse --verify HEAD >/dev/null 2>&1 \
    && git -C "$TAP_DIR" ls-files --error-unmatch "Formula/$FORMULA.rb" >/dev/null 2>&1 \
    && git -C "$TAP_DIR" diff --quiet -- "Formula/$FORMULA.rb"; then
    skip "formula already at $VERSION"
  else
    # Untracked formula (empty or new tap) is invisible to `git diff`, so we
    # require the file to be tracked before treating "no diff" as up-to-date.
    git -C "$TAP_DIR" add "Formula/$FORMULA.rb"
    git -C "$TAP_DIR" commit -q -m "$FORMULA $VERSION"
    info "committed formula bump"
    git_push "$TAP_DIR"
  fi
fi

# ---- done ------------------------------------------------------------------
step "Done: $TAG released"
info "release: https://github.com/$MAIN_REPO/releases/tag/$TAG"
[ "$SKIP_TAP" = 1 ] || info "install: brew tap $TAP_SLUG && brew install $FORMULA"
info "verify:  brew update && brew upgrade $FORMULA"
