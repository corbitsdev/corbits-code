# OpenTUI spike report — GO / NO-GO

**Verdict: GO**

**Date:** 2026-08-05  
**Runtime:** Bun 1.3.14 on darwin arm64  
**Packages:** `@opentui/core@0.5.1`, `@opentui/solid@0.5.1`  
**Spike tree (local only):** `tmp/opentui-spike/`  
**Root `package.json`:** unchanged (no OpenTUI dependency added)

This report is the committed evidence artifact for the TUI layout/scroll platform plan. Final binding ADR remains a downstream decision; this spike supplies inputs only.

---

## 1. What was proven

| Checkpoint | Result | Evidence |
|---|---|---|
| Install under Bun (isolated tree) | PASS | `bun add @opentui/core` → 0.5.1; native `@opentui/core-darwin-arm64` / `libopentui.dylib` |
| Native renderer via FFI | PASS | `createTestRenderer` from `@opentui/core/testing` paints memory buffer |
| Mini shell layout (header + ScrollBox + prompt) | PASS | Flex column; no manual row math; resize 60×20 → 80×12 keeps HEADER + STATUS |
| Sticky stream bottom | PASS | Seeded lines 1–50; viewport shows ~034–050 only |
| Scroll-up pin (sticky pause) | PASS | `scrollTop` held at 21 after append while scrolled up |
| Return-to-bottom | PASS | `scrollTo(MAX)` reveals appended line |
| Focus lease (prompt vs scroll) | PASS | `InputRenderable.focus()` / `ScrollBoxRenderable.focus()` both succeed |
| Enter / Alt+Enter / Ctrl+C distinct | PASS | See key shapes below |
| Input ENTER submit path | PASS | `InputRenderableEvents.ENTER` value `hello-spike` |
| Solid package loads | PASS | `@opentui/solid` exports `render` / `testRender` |
| Windows | Untested | Non-blocking for this spike |
| Linux / musl | Untested on host | Optional deps declared for x64/arm64 musl |

Headless verifier: `tmp/opentui-spike/verify.ts` — **16/16 PASS**.  
Interactive shell: `tmp/opentui-spike/index.ts` (`bun run start` on a real TTY).

---

## 2. Key event shapes (actionable)

Observed via `createTestRenderer` mock input → `renderer.keyInput` `keypress`:

| Chord | `name` | `ctrl` | `meta` | `option` | `sequence` / `raw` |
|---|---|---|---|---|---|
| Enter | `return` | false | false | false | `\r` |
| Alt+Enter | `return` | false | **true** | false | `\u001b\r` |
| Ctrl+C | `c` | **true** | false | false | `\u0003` |

Notes for Corbits steering/interrupt design:

- Canonical identity for Enter is **`return`**, not `enter`. Component keybindings alias `enter` → `return`; raw `keyInput` handlers must check `return` (or both).
- Alt+Enter is cleanly separable as `name === "return" && (meta || option)`.
- On this mock/mac path Alt surfaces as **`meta: true`**, not `option: true`. Real Kitty-protocol terminals may also set `option`; match either.
- Ctrl+C is `name === "c" && ctrl`. Renderer supports `exitOnCtrlC: true` (default) or manual handling when false.
- `InputRenderable` consumes Enter for submit (`ENTER` event) when focused; app-level Alt+Enter should be handled on `keyInput` (or keymap) before/around input so it is not treated as submit.

---

## 3. Binding recommendation inputs (not an ADR)

| Binding | Spike result | DX notes |
|---|---|---|
| **Core** | Full mini shell + headless suite green | Class API (`*Renderable`) is reliable for scroll/focus. Construct factories (`ScrollBox({…})`) paint fine but VNode proxies broke `scrollTop` access in one path — prefer class API for imperative scroll control. |
| **Solid** | Install + import green; OpenCode peer uses Solid | Needs `jsxImportSource: "@opentui/solid"` + `bunfig.toml` preload `@opentui/solid/preload`. Install warned `incorrect peer dependency solid-js@1.9.14` but package resolved. Fine-grained reactivity fits stream-heavy UIs. |
| **React** | Not exercised in this spike | Docs: `createRoot(renderer)` + `@opentui/react` jsxImportSource. Closest to current Corbits Ink/React muscle memory; higher render-cost risk than Solid for dense streams. |

**Recommended binding hint:** **Solid + core + keymap** (OpenCode-aligned), with core class API for low-level scroll/focus leases. Revisit if team velocity strongly favors React reuse; do not block GO on React sample.

**Binding ADR (downstream of this report):** `docs/adr/opentui-binding.md` — decision **Solid + core + keymap**.


`@opentui/keymap` not installed in this spike; treat as next packaging/spike item when wiring host key chords.

---

## 4. Packaging / FFI / platform risks

- **Native Zig core via Bun FFI** — works on this host. Node path needs Node ≥ 26.4.0 + `--experimental-ffi` (Corbits is Bun-first; low risk).
- **Optional platform packages** ship per OS/arch including **musl** (`core-linux-*-musl`) and Windows. CI matrix should assert the correct optional dep resolves (darwin arm64/x64, linux glibc + musl arm64/x64).
- **Standalone / Homebrew packaging** — native dylib must be included or resolved at install; verify Corbits release pipeline before cutover.
- **Tree-sitter wasm assets** ship under `@opentui/core` (markdown/code components); size/packaging impact if those components are used.
- **Solid peer pin** — install warning on solid-js 1.9.14; pin compatible peer when productionizing.
- **Construct vs class API** — document team convention early (class for imperative scroll/focus).

---

## 5. Mini shell shape (reference)

```
┌─ header (flexShrink: 0) ─────────────────────────────┐
│ OpenTUI spike · …                                    │
├─ ScrollBox stickyScroll + stickyStart: "bottom" ─────┤
│   flexGrow: 1  ·  no manual row budget               │
│   stream lines …                                     │
├─ prompt region (flexShrink: 0) ──────────────────────┤
│ status / focus lease                                 │
│ Input prompt                                         │
└──────────────────────────────────────────────────────┘
```

Sticky behavior matches product need: auto-follow until operator scrolls up; return-to-bottom resumes follow.

---

## 6. Explicit GO / NO-GO

### GO — proceed with OpenTUI as TUI substrate

Reasons:

1. Clean install on Bun with native renderer in under ~1s.
2. Flex layout + sticky ScrollBox eliminate the current chrome-row-math failure class.
3. Focus and key distinguishability cover queue-vs-interrupt chords.
4. Headless `createTestRenderer` enables automated layout/key regression tests without a host TTY.
5. Solid binding installs and matches the OpenCode production peer stack.

### Not claimed (out of scope / residual risk)

- Production wiring into Corbits entry or root deps
- Full React binding exercise
- Windows interactive run
- Linux/musl CI green
- Keymap host integration
- Performance under multi-hour stream load
- Migration of existing Ink surfaces

---

## 7. How to re-run

```bash
cd tmp/opentui-spike
bun install
bun run verify    # headless evidence (primary)
bun run start     # interactive mini shell (real TTY)
```

Local evidence JSON: `tmp/opentui-spike/verify-evidence.json`  
Task logs (dispatch): `verification.log`, `spike-run.log` under the OpenTUI spike task directory.
