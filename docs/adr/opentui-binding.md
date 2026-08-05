# ADR: OpenTUI binding — Solid + core + keymap

**Status:** Accepted  
**Date:** 2026-08-05  
**Evidence:** `docs/plans/opentui-spike-report.md`  
**Spike packages:** `@opentui/core@0.5.1`, `@opentui/solid@0.5.1` (Bun 1.3.14, darwin arm64)

---

## Decision

**Use Solid + core + keymap** as the OpenTUI binding stack for the Corbits TUI migration:

| Layer | Package / API | Role |
|---|---|---|
| **UI composition** | `@opentui/solid` | Declarative shell, chrome zones, stream surfaces |
| **Imperative control** | `@opentui/core` class API (`*Renderable`) | Scroll, focus leases, headless test renderer |
| **Key chords** | `@opentui/keymap` (next packaging step) | Host mapping for Enter / Alt+Enter / Ctrl+C and app chords |

Do **not** adopt React/`@opentui/react` as the production binding. Do **not** ship dual long-term bindings (Solid and React). Core-only without a component binding is rejected for application UI.

---

## Context

Corbits Code’s interactive surface is Ink/React today. The layout/scroll platform plan locks OpenTUI as the substrate after a GO spike. The spike proved install, native FFI render, flex mini-shell, sticky ScrollBox, focus leases, and distinct key shapes under Bun. Binding choice was explicitly deferred to this ADR.

Constraints that shape the choice:

- Migration is a **branch hard cutover** — no dual-release Ink + OpenTUI, and no dual OpenTUI component bindings long-term.
- Product needs dense streaming UIs (transcript working set, sticky follow, scroll-up pin) and reliable focus leases (prompt vs scroll).
- Queue / steer / interrupt chords are locked product behavior: Enter = queue, Alt+Enter = steer, Ctrl+C = interrupt. Binding must preserve distinguishable key events.
- OpenCode (peer production stack) uses Solid on OpenTUI; aligning reduces unknown surface area.
- Spike did **not** exercise the React binding; any React claim would be unevidenced.

---

## Options

### A. Solid + core + keymap (chosen)

**Spike evidence**

- `@opentui/solid` installs and exports `render` / `testRender`.
- Core mini-shell + headless suite green (16/16): sticky stream, scroll-up pin, return-to-bottom, focus leases, Enter submit path.
- Key shapes proven on core `keyInput`: Enter = `return`; Alt+Enter = `return` + `meta`; Ctrl+C = `c` + `ctrl`.
- Class API reliable for imperative scroll/focus; construct/VNode path broke `scrollTop` once — prefer class API for those leases.
- Aligns with OpenCode’s production peer stack.
- Install warned `incorrect peer dependency solid-js@1.9.14` but resolved; pin a compatible peer when productionizing.

**Tradeoffs**

- Team leaves Ink/React muscle memory for application UI (acceptable under hard cutover).
- Needs `jsxImportSource: "@opentui/solid"` and Bun preload (`@opentui/solid/preload` via `bunfig.toml`).
- `@opentui/keymap` was **not** installed in the spike; treat as the next packaging/wiring item when host chords land — not a reason to pick React or core-only.

### B. React + core (`@opentui/react`)

**Spike evidence**

- **Not exercised.** Docs-only path: `createRoot(renderer)` + `@opentui/react` jsxImportSource.
- Closest to current Corbits Ink/React habits; higher render-cost risk than Solid for dense streams (spike note, not measured here).

**Why rejected**

- No spike pass/fail for layout, sticky scroll, focus, or keys under React.
- Choosing React would reopen the binding without evidence and diverge from the OpenCode-aligned path the GO verdict already validated for Solid.
- Revisit only if a future spike proves React parity and team velocity clearly favors React reuse; do not block migration on that sample.

### C. Core-only (no Solid/React component binding)

**Spike evidence**

- Core alone proved the mini shell and all headless checkpoints via class renderables.

**Why rejected for application UI**

- Application shell, chrome zones, and stream surfaces need a component model and fine-grained updates; hand-building the full product UI on bare renderables is a maintainability dead end.
- Core remains **required** underneath Solid for scroll/focus leases and headless tests — core-only is wrong as the sole application binding, not as a dependency.

---

## Consequences

### For implementers (migration branch)

1. **Default stack:** compose UI in Solid; reach for `@opentui/core` class renderables when controlling scroll position, sticky pause/resume, and focus leases.
2. **Package setup (migration branch only — not root until cutover policy says so):**
   - `@opentui/core`, `@opentui/solid`, and (when wiring chords) `@opentui/keymap`
   - Compatible `solid-js` peer pin (resolve the 1.9.x peer warning at productionize time)
3. **TypeScript / Bun:**
   - `jsxImportSource: "@opentui/solid"`
   - Preload `@opentui/solid/preload` in `bunfig.toml` for the migration package/app entry
4. **Imperative scroll convention:** use the class API (`ScrollBoxRenderable`, etc.). Avoid construct-factory / VNode proxy paths for `scrollTop` and related control after the spike regression.
5. **Keys:** identity for Enter is `return` (not `enter`) on raw `keyInput`. Alt+Enter = `return` with `meta` or `option`. Ctrl+C = `c` with `ctrl`. Prefer keymap for host chords once packaged; keep Alt+Enter on the key path so focused `InputRenderable` does not treat it as submit.
6. **Tests:** continue using core headless `createTestRenderer` for layout/key regression without a host TTY.

### Non-goals

- No dual long-term bindings (Solid application UI and React application UI).
- No production React binding without a new spike that exercises layout, sticky scroll, focus, and keys.
- No OpenTUI install at repo root as part of this decision record; packaging lands on the migration branch per cutover plan.
- No Windows or Linux/musl certification in this ADR (spike residual risk; CI matrix later).

### Skills / docs impact

- Migration and TUI skills should teach Solid + OpenTUI patterns, not Ink/React component APIs, for new shell work.
- Layout constitution and interaction contract remain binding for geometry and chords; this ADR only locks the renderer binding stack.

### Residual risks (from spike, not reopened here)

- `@opentui/keymap` not yet installed or proven in-tree.
- Solid peer pin warning.
- Native dylib packaging for standalone/Homebrew and CI optional-deps matrix (darwin, linux glibc + musl).
- Multi-hour stream performance not measured.

---

## References

- Spike report (GO): `docs/plans/opentui-spike-report.md`
- Layout/scroll platform plan: `docs/plans/tui-layout-scroll-platform.md`
- Layout constitution: `docs/tui-layout-constitution.md`
- Interaction contract: `docs/tui-interaction-contract.md`
- Product brief: `briefs/tui-rebuild-opentui.md`
