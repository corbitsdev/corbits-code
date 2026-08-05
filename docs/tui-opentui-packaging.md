# OpenTUI install / CI / packaging plan

**Status:** plan (docs only; CI not yet changed)  
**Spike verdict:** GO — `docs/plans/opentui-spike-report.md`  
**Spike packages:** `@opentui/core@0.5.1`, `@opentui/solid@0.5.1`  
**Runtime:** Bun (`package.json` engines: `bun >= 1.2`)  
**Platform priority:** macOS #1 · Linux #2 · Windows non-blocking  

This document answers how OpenTUI natives install for contributors and CI, which matrix cells are required, and how to diagnose missing/wrong-arch binaries. Root `package.json` on `migration/opentui-tui` now depends on OpenTUI (see §1); CI configs are still unchanged.

---

## 1. Dependency model

OpenTUI is a TypeScript API over a **native Zig core** loaded via Bun FFI (or Node ≥ 26.4.0 + `--experimental-ffi`; Corbits is Bun-first).

| Package | Role |
|---|---|
| `@opentui/core` | Public API + runtime; declares optional platform packages |
| `@opentui/core-<os>-<arch>[ -musl]` | Prebuilt native library for one OS/CPU (optional dependency) |
| `@opentui/solid` | Solid binding (spike recommendation; peer `solid-js`) |
| `@opentui/keymap` | Host key chords — not installed in spike; wire later |

### Optional platform packages (`@opentui/core@0.5.1`)

Package managers install only the optional dep matching the host OS/CPU:

| Package | OS | Arch | libc | Native file |
|---|---|---|---|---|
| `@opentui/core-darwin-arm64` | macOS | arm64 | — | `libopentui.dylib` |
| `@opentui/core-darwin-x64` | macOS | x64 | — | `libopentui.dylib` |
| `@opentui/core-linux-x64` | Linux | x64 | glibc (default) | `libopentui.so` |
| `@opentui/core-linux-arm64` | Linux | arm64 | glibc (default) | `libopentui.so` |
| `@opentui/core-linux-x64-musl` | Linux | x64 | musl | `libopentui.so` |
| `@opentui/core-linux-arm64-musl` | Linux | arm64 | musl | `libopentui.so` |
| `@opentui/core-win32-x64` | Windows | x64 | — | `opentui.dll` |
| `@opentui/core-win32-arm64` | Windows | arm64 | — | `opentui.dll` |

Resolution (Bun path): `@opentui/core` dynamically imports the matching `@opentui/core-<platform>-<arch>` package; that package’s entry re-exports the native file with `{ type: "file" }`.

**Linux musl:** set `OPENTUI_LIBC=musl` so the runtime selects `*-musl` packages. Unset / empty / `glibc` → glibc packages. Other values throw.

**Supported arches only:** `arm64` and `x64`. Other CPUs throw `Unsupported OpenTUI Node asset target`.

---

## 2. Contributor install (clean machine)

On **main**, root Corbits does not depend on OpenTUI. On `migration/opentui-tui`, root depends on OpenTUI and `bun install` pulls the host native package. The isolated spike tree under `tmp/opentui-spike` remains useful for re-running spike scripts.

### Prerequisites

- **Bun** ≥ 1.2 (spike ran on Bun 1.3.14)
- macOS or Linux, arm64 or x64
- Network access to the registry that serves `@opentui/*` (npm)

### A. Re-run the spike (today — recommended)

```bash
# From repo root
cd tmp/opentui-spike
bun install
bun run verify    # headless: native FFI + layout/keys (primary evidence)
bun run start     # interactive mini shell (real TTY only)
```

Clean machine without the spike tree:

```bash
mkdir -p tmp/opentui-spike && cd tmp/opentui-spike
bun init -y
bun add @opentui/core@0.5.1
# Optional Solid path (spike recommendation):
bun add @opentui/solid@0.5.1 solid-js
```

**macOS check (arm64 example):**

```bash
ls node_modules/@opentui/core-darwin-arm64/libopentui.dylib
file node_modules/@opentui/core-darwin-arm64/libopentui.dylib
# expect: Mach-O 64-bit dynamically linked shared library arm64
```

**Linux check (glibc x64 example):**

```bash
ls node_modules/@opentui/core-linux-x64/libopentui.so
file node_modules/@opentui/core-linux-x64/libopentui.so
# expect: ELF 64-bit LSB shared object, x86-64
```

**Linux musl (Alpine / musl hosts):**

```bash
export OPENTUI_LIBC=musl
bun install   # reinstall so optional musl package can resolve if needed
ls node_modules/@opentui/core-linux-*-musl/libopentui.so
```

### B. Production install (migration branch — future)

When OpenTUI is added to the app (not this doc’s job):

```bash
# From repo root on the migration branch only
bun install --frozen-lockfile
# Assert native package present for this host (see §5)
bun run test:tui   # or whatever harness lands with the platform
```

**Do not** add `@opentui/*` to root `package.json` on **main** until cutover policy allows it (`docs/tui-migration-cutover.md`). On branch `migration/opentui-tui`, root already depends on `@opentui/core@0.5.1`, `@opentui/solid@0.5.1`, `@opentui/keymap@0.5.1`, and `solid-js@1.9.14` (scaffold under `src/tui-opentui/`; not wired to the `corbits` CLI yet).

### Solid contributor notes

- `jsxImportSource: "@opentui/solid"`
- `bunfig.toml` preload: `@opentui/solid/preload`
- Spike saw `incorrect peer dependency solid-js@1.9.14` — package still resolved; pin a compatible peer when productionizing.

### Node (not primary)

Corbits is Bun-first. Node consumers need Node ≥ 26.4.0 and `--experimental-ffi`. Prefer Bun for all contributor and CI paths.

---

## 3. CI matrix plan

**Docs only — do not edit `.github` in this task.** Current CI is a single `ubuntu-latest` job (workflow_dispatch only while org billing is constrained). When OpenTUI lands on a branch, expand as below.

### Priority

| Priority | OS | Required for merge? |
|---|---|---|
| #1 | macOS | **Yes** (primary daily-dev surface) |
| #2 | Linux | **Yes** (primary CI / server / contributor) |
| — | Windows | **No** (non-blocking; optional smoke) |

### Recommended matrix cells

| Cell | Runner (example) | Arch | libc | Required | Assert native package |
|---|---|---|---|---|---|
| macOS arm64 | `macos-14` / `macos-latest` | arm64 | — | **Yes** | `@opentui/core-darwin-arm64` + `libopentui.dylib` |
| macOS x64 | `macos-13` (Intel) if available | x64 | — | Preferred | `@opentui/core-darwin-x64` |
| Linux glibc x64 | `ubuntu-latest` | x64 | glibc | **Yes** | `@opentui/core-linux-x64` + `libopentui.so` |
| Linux glibc arm64 | `ubuntu-24.04-arm` (or equiv.) | arm64 | glibc | Preferred | `@opentui/core-linux-arm64` |
| Linux musl x64 | Alpine container / musl job | x64 | musl (`OPENTUI_LIBC=musl`) | Preferred | `@opentui/core-linux-x64-musl` |
| Linux musl arm64 | Alpine arm64 | arm64 | musl | Nice-to-have | `@opentui/core-linux-arm64-musl` |
| Windows x64 | `windows-latest` | x64 | — | Optional | `@opentui/core-win32-x64` + `opentui.dll` |
| Windows arm64 | when runner exists | arm64 | — | Optional | `@opentui/core-win32-arm64` |

**Minimum gate for OpenTUI platform PRs:** macOS arm64 **and** Linux glibc x64 both green (install + headless renderer tests). Musl and Intel Mac are strongly recommended before Bar milestone; Windows does not block merge.

### Per-cell install assertion (sketch)

```bash
# After bun install --frozen-lockfile
node_or_bun_script that:
  1. Resolves process.platform / process.arch (/ OPENTUI_LIBC)
  2. Confirms node_modules/@opentui/core-<expected>/ exists
  3. Confirms native file present and non-empty
  4. Imports createTestRenderer from @opentui/core/testing and paints once
```

Fail the job if the optional package is missing (silent optional-dep skip is the main failure mode).

### Bun version

Pin Bun in CI to a version ≥ 1.2 that matches contributor engines (spike: 1.3.x). Avoid mixing Node-only install paths for OpenTUI jobs.

### TODO (implement later — not this task)

- Add matrix jobs to `.github/workflows` when org billing allows normal CI again.
- Publish a small `scripts/assert-opentui-native.ts` (or test) used by every matrix cell.
- Include native assets in any `bun build --compile` / Homebrew release recipe (dylib/so/dll must ship or resolve at install).

---

## 4. Failure modes

| Symptom | Likely cause | Fix |
|---|---|---|
| `OpenTUI is not supported on the current platform: @opentui/core-…` | Optional platform package missing from `node_modules` (install skipped, offline cache, or `optional=false`) | Re-run `bun install` without disabling optional deps; check registry access; confirm OS/arch match |
| Wrong arch binary / dyld or ELF class error | Cross-copied `node_modules`, Rosetta confusion, or wrong package forced | Delete `node_modules` + lock local cache for that package; reinstall on the target machine |
| Linux loads glibc `.so` on Alpine (or reverse) | `OPENTUI_LIBC` unset on musl, or set on glibc | Set `OPENTUI_LIBC=musl` on musl hosts; leave unset on glibc |
| `Unsupported OpenTUI Node asset target: …` | Arch outside arm64/x64 (e.g. ia32, riscv) | Unsupported — use arm64/x64 host |
| Native import works in Bun, fails in Node | Node < 26.4 or missing `--experimental-ffi` | Use Bun; or upgrade Node + flag |
| Install peer warning on `solid-js` | Solid peer pin mismatch | Pin compatible `solid-js` when productionizing; does not block core FFI |
| Headless tests pass, interactive TTY fails | No real TTY / wrong term / CI without pseudo-TTY | Keep headless `createTestRenderer` as CI primary; interactive only on developer machines |
| Standalone binary / Homebrew missing native | Compile/package step omitted optional assets | Release pipeline must bundle or re-resolve platform package (verify before cutover) |
| Tree-sitter / markdown assets missing | Incomplete pack of `@opentui/core` wasm | Only if those components are used; include `@opentui/core` assets in release |

### Install policy for optional deps

- **Never** pass flags that skip optional dependencies for OpenTUI installs.
- Prefer `bun install --frozen-lockfile` in CI so the lockfile records the intended optional set.
- Do not vendor a single-platform dylib into the repo; rely on optional packages.

---

## 5. Release / packaging risks (pre-cutover checklist)

1. **FFI load path** — confirmed on darwin-arm64 spike; re-verify on each required matrix cell.
2. **Compile (`bun build --compile`)** — ensure the native library is found under the bundled filesystem root or re-resolved next to the binary.
3. **Homebrew / tarball** — ship per-platform artifacts or run an install step that fetches the correct optional package.
4. **Asset size** — tree-sitter wasm under `@opentui/core` if markdown/code components are used; measure before release.
5. **Lockfile** — commit lockfile entries that allow optional platform packages to resolve on all required CI OS/arch pairs.
6. **No dual stack** — packaging targets the OpenTUI migration branch only; main stays Ink until hard cutover.

---

## 6. Quick reference — “how do I install on a clean Mac/Linux machine?”

```bash
# 1. Install Bun (>= 1.2)
curl -fsSL https://bun.sh/install | bash

# 2. Clone Corbits and use the spike tree (until root depends on OpenTUI)
cd /path/to/corbits-code/tmp/opentui-spike
bun install

# 3. Prove native FFI
bun run verify

# 4. Optional interactive shell
bun run start
```

**macOS:** expect `@opentui/core-darwin-{arm64|x64}` and `libopentui.dylib`.  
**Linux glibc:** expect `@opentui/core-linux-{arm64|x64}` and `libopentui.so`.  
**Linux musl:** `export OPENTUI_LIBC=musl` and expect `*-musl` package.  
**Windows:** optional packages exist; not required for contributor or merge gate.

---

## 7. Related docs

| Doc | Role |
|---|---|
| `docs/plans/opentui-spike-report.md` | Spike GO evidence, install notes, binding hint |
| `docs/plans/tui-layout-scroll-platform.md` | Epic plan; packaging is Renderer milestone |
| `docs/tui-migration-cutover.md` | Branch hard cutover; no dual-release packaging |
| `docs/tui-layout-constitution.md` | Geometry contracts once shell lands |
| `docs/tui-ink-freeze.md` | Ink maintenance-only while OpenTUI builds |

Spike re-run evidence lives under `tmp/opentui-spike/` (local; not a root dependency).
