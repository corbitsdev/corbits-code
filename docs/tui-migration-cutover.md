# TUI migration cutover policy

**Status:** locked  
**Source of truth:** `docs/plans/tui-layout-scroll-platform.md` (migration strategy and locked cutover decision)  
**Product brief:** `briefs/tui-rebuild-opentui.md`

This document is the operator-facing cutover policy for moving Corbits Code from Ink to OpenTUI. It does not invent product direction; it restates the locked plan decisions so merge and scrap rules are unambiguous.

---

## 1. Policy statement

Migration is a **branch hard cutover**.

- One migration branch carries the full OpenTUI shell, platform, and primary surfaces.
- Main stays on Ink until the whole epic is ready to ship.
- Merge only when the acceptance corpus and Bar gates are green.
- On failure before merge: **scrap the branch**; do not land half.
- **No dual-release.** Do not ship two paint paths (Ink and OpenTUI) as product modes.
- **No dual-entry product flag.** Runtime flags that select Ink vs OpenTUI for end users are not a ship path.
- Remove Ink as part of the same cutover merge — not a later flag flip on main.

---

## 2. Branch lifecycle

| Phase | What happens | Exit |
|---|---|---|
| **Spike** | OpenTUI on Bun (FFI, install, binding). Spike starts the migration-branch attempt. | Go / no-go written |
| **Constitution** | Lock budget, focus, scroll, palette, queue/steer/interrupt (docs + acceptance scenarios). | Reviewed and locked |
| **Full epic on branch** | Platform (shell, geometry, list kit, focus/scroll lease, harness) + all primary surfaces + Quiet UI after geometry rules exist. | Surfaces complete on branch |
| **Bar** | Size matrix, peer pass, long-session smoke on the branch. | Bar minimum green |
| **Merge or scrap** | Merge only when gates pass; otherwise scrap and stay on Ink. | Ship OpenTUI or remain Ink |

### Strangler order (on the migration branch only)

```
app chrome shell
  → transcript + scroll lease + long-log window
  → prompt + queue/steer/interrupt
  → overlay host (permissions, operator, model)
  → palette
  → agents strip / goal / task zones
  → settings / help / residual
  → delete Ink path
  → merge only when acceptance corpus green
```

Main does not receive partial OpenTUI surfaces. Work lands on the migration branch; cutover is the merge that deletes Ink.

---

## 3. Merge checklist

Do not merge until every item is true:

### Acceptance corpus

All scenarios in the plan acceptance corpus pass on OpenTUI (automated harness where possible; manual for terminal-specific paint). Summary of required classes:

1. Starved chrome on 24 rows (transcript floor held; expand/collapse works)
2. Permission list (keep-active-visible; wheel scoped; close restores prompt)
3. Operator question (long text + many choices; no overpaint into status)
4. Prompt expand (multi-line paste; transcript does not vanish)
5. Stream follow (auto-follow; pin on scroll up; jump-to-bottom)
6. Queue mid-run (Enter queues; Alt+Enter steers; Ctrl+C interrupts)
7. Palette open → permissions → Esc restores prompt focus
8. Keyboard copy path without mouse drag-select
9. Subagent observe (independent scroll; Esc restores parent lease)
10. Resize mid-session (no ghost lines; prompt row stable)
11. Settings / help open/close without residual absolute paint
12. Long log remains interactive under multi-thousand-line load

Full scenario text lives in `docs/plans/tui-layout-scroll-platform.md` (acceptance corpus section).

### Bar gates

- **Size matrix** green on **macOS** (primary) and **Linux** (required for CI/server users). Run continuously on migration PRs, not only at the end.
- **Peer pass** complete (Amp feel, OpenCode stack notes, Claude Code / pi interaction baselines as comparison — not copy targets).
- **Long-session smoke** clean (ghosting, overpaint, resize under sustained stream).

### Cutover completeness

- Ink path removed on the migration branch (same merge as OpenTUI ship).
- No product-facing Ink fallback or dual paint mode remains.
- Packaging/install path for OpenTUI is documented and CI-green on required platforms.

---

## 4. Rollback and failure modes

| When | Action | Outcome |
|---|---|---|
| **Before merge** | Scrap the migration branch | Main stays Ink; no half-landed OpenTUI |
| **After merge (catastrophic)** | Normal git revert of the merge commit | Return to Ink; do not leave a permanent dual paint path |
| **Never** | Ship “OpenTUI shell with Ink fallback” as a product mode | Forbidden |

Scrap means: abandon the branch work as the ship vehicle; do not merge incomplete surfaces “behind a flag.” Lessons from the spike and constitution docs may still inform a later attempt; the incomplete paint path does not ship.

---

## 5. Platform gates

| Priority | Platform | Role at cutover |
|---|---|---|
| **#1** | **macOS** | Must pass; primary development target |
| **#2** | **Linux** | Must pass (CI and server users) |
| — | **Windows** | Non-blocking for v1; best-effort only if free |

Windows failures do not block merge. macOS or Linux acceptance/Bar failures do.

---

## 6. Explicit non-goals

- Dual-release Ink + OpenTUI in production
- Dual-entry product flag as the migration vehicle
- Shipping OpenTUI before the whole epic is ready
- Landing half the surfaces on main “to de-risk”
- Treating Windows as a v1 must-pass platform

Ink policy until cutover: only true P0 daily-use blockers get minimal patches; no new chrome features on Ink. That freeze is separate from this cutover doc; see the plan and constitution.

---

## 7. Related docs

| Doc | Role |
|---|---|
| `docs/plans/tui-layout-scroll-platform.md` | Plan source of truth (migration strategy, acceptance corpus, locked decisions) |
| `briefs/tui-rebuild-opentui.md` | Product brief (cutover locked with platform priorities) |
| `docs/tui-layout-constitution.md` | Layout constitution (budget, ownership, interaction) — when present |
| `docs/ARCHITECTURE.md` | Current system architecture (Ink TUI today) |
| `docs/PRODUCT.md` | Product UX claims (TUI section) |

When constitution and cutover disagree with the plan on locked decisions, the plan wins until deliberately re-locked.
