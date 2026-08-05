# TUI cutover readiness (Wave 7)

**Branch:** `migration/opentui-tui`  
**Date:** 2026-05-08  
**Policy:** `docs/tui-migration-cutover.md` — hard cutover only; this doc lists blockers, it does **not** authorize merge or Ink deletion.

## Status summary

| Wave | Status | Commit (approx) |
|------|--------|-----------------|
| 1 Constitution + spike | done | earlier |
| 2 Platform kit | done | earlier |
| 3 Fake product skin | done | `d6853c7` |
| 4 Runtime bridge | done | `dd60ff5` |
| 5 Primary overlays | done | `d55702d` |
| 6 Palette / long-log / chrome / copy | done | `77c8a90` |
| 7 Residuals + readiness | done | this wave |


**Production entry:** Ink (`src/tui`) remains the CLI default. OpenTUI lives under `src/tui-opentui/**` only.

## Acceptance corpus (§10) — pass/fail

Scenarios from `docs/plans/tui-layout-scroll-platform.md` §10, evaluated against the OpenTUI platform on this branch (headless + geometry pure tests). **No silent skips.**

| # | Scenario | Result | Evidence |
|---|----------|--------|----------|
| 1 | Sticky stream + pin-on-scroll-up | **PASS** | `shell.test.ts` sticky/pin; Wave 2 shell integration |
| 2 | Permissions list keep-active-visible + wheel scoped + Esc → prompt | **PASS** | `overlays.test.ts` permissions |
| 3 | Operator question long body + choices; no status overpaint | **PASS** | `overlays.test.ts` operator |
| 4 | Model/provider picker shared scroll kit | **PASS** | `overlays.test.ts` model picker |
| 5 | Agents strip thin; observe intentional; Esc leaves | **PASS** | `wave6.test.ts` chrome; `wave7.test.ts` observe |
| 6 | Goal/task chrome measured (zone registry) | **PASS** | `wave6.test.ts` chrome zones |
| 7 | Queue/steer/interrupt keys → adapter | **PASS** | `runtime-bridge.test.ts` + shell product keys |
| 8 | Palette open → action → Esc restores | **PASS** | `wave6.test.ts` palette |
| 9 | Long log windowed; no unbounded paint tree | **PASS** | `wave6.test.ts` long-log; `long-log.test.ts` |
| 10 | Resize mid-overlay holds floors; 80×24 idle floor when closed | **PASS** | `overlays.test.ts` resize; geometry tests |
| 11 | Settings / help open/close; no residual absolute paint | **PASS** | `wave7.test.ts` residual surfaces |
| 12 | Plugins / resume / mentions on shared kit | **PASS** | `wave7.test.ts` residual surfaces |
| 13 | Keyboard copy path (message/tool/diff) | **PASS** | `wave6.test.ts` + `copy-path.test.ts` |
| 14 | Subagent observe independent scroll; Esc → parent lease | **PASS** | `wave7.test.ts` observe |

**Notes**

- “PASS” means platform-kit headless coverage on this branch — **not** production CLI wiring.
- Streaming markdown host, full keymap settings editor, and live reactor integration remain out of Wave 7 scope (see blockers).

## Size matrix harness notes

| Platform | Role | How to run |
|----------|------|------------|
| **macOS (darwin)** | Primary interactive | `bun src/tui-opentui/demo.ts` in a real TTY; exercise 80×24 and larger (e.g. 120×40) |
| **Linux CI** | Headless gate | `bun test ./src/tui-opentui` — uses `@opentui/core` test renderer (no real TTY) |
| Geometry pure | Any | `geometry.test.ts` — no process.stdout; inputs are explicit columns/rows |

**Floors (constitution)**

- Idle closed overlay: transcript ≥ 12 on 80×24
- Inset overlay open: transcript ≥ 8
- Residual rows accrue to transcript, not chrome

Manual size matrix checklist (operator, pre-merge):

- [ ] 80×24 idle: status visible; prompt not clipped
- [ ] 80×24 permissions open: list scrollable; Esc restores
- [ ] 80×24 palette over permissions: Esc ×2 restores prompt
- [ ] 120×40: extra rows in transcript
- [ ] Observe enter/leave: parent stream restored

## Blockers before delete-Ink merge

Do **not** merge or delete Ink until each item is cleared:

1. **Production entry swap** — wire `corbits` CLI to OpenTUI shell (today: Ink only). No dual-ship flag; cutover is the merge that removes Ink.
2. **Live reactor integration** — fixture/runtime-bridge is adapter-shaped; real session stream + queue drain at tool boundary must be production-wired and smoke-tested.
3. **Permission gate UI** — OpenTUI permissions list is fixture-driven; must call real authz ask/approve paths.
4. **Operator question** — same: real `ask_operator` / reactor ask surface.
5. **Model/provider picker** — bind to real model registry / settings store.
6. **Settings / plugins / resume** — residual panes are catalogs only; need real data + actions.
7. **Mentions** — wire to real path completion / file picker.
8. **Subagent observe** — real child session stream + agents strip, not fixture lines.
9. **Streaming markdown / tool expand** — product transcript fidelity (not just role labels).
10. **Keymap parity** — full table vs Ink (`src/tui/keymap-table.ts`); tool-expand chord rebinding complete in production path.
11. **Clipboard** — real OS clipboard port (tests use recording port).
12. **Linux CI size matrix** — optional interactive job or documented headless equivalence sign-off.
13. **Acceptance re-run on production path** — re-score §10 after entry swap (platform PASS ≠ ship PASS).
14. **Ink freeze** — only P0 Ink patches until cutover; no new Ink chrome features.

## Explicit non-goals of this doc

- No merge to `main`
- No deletion of `src/tui` Ink tree
- No renderer product flag / dual-ship
- No claim that the CLI “uses OpenTUI now”

## Related

- Plan: `docs/plans/tui-layout-scroll-platform.md` (§5, §7, §10, §12)
- Cutover policy: `docs/tui-migration-cutover.md`
- Constitution: `docs/tui-layout-constitution.md`
- Interaction: `docs/tui-interaction-contract.md`
- Code: `src/tui-opentui/**`
