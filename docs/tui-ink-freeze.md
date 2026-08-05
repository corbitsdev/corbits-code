# Ink freeze policy (P0-only)

**Status:** locked for the OpenTUI rebuild wave  
**Applies to:** any PR that touches `src/tui` while Ink remains the shipping shell  
**Product brief:** `briefs/tui-rebuild-opentui.md`  
**Epic plan:** `docs/plans/tui-layout-scroll-platform.md`

Ink is **maintenance-only**. The destination shell is OpenTUI. This document tells reviewers what may land on Ink, what must wait for the platform, and how to triage overflow/scroll tickets.

---

## 1. Freeze policy

### Allowed on Ink

| Class | Rule |
|---|---|
| **True P0 daily-use blocker** | Minimal patch only — restore a broken daily path; do not redesign |
| **Safety / data-loss** | Crash, hang, corrupted session write, or quit that leaves the terminal unusable |
| **Regression of a prior fix** | Same surface broke again after a recent change; restore previous behavior with the smallest diff |

### Forbidden on Ink

| Class | Why |
|---|---|
| **New chrome features** | Zone registry, collapse modes, palette UX, glyph quiet, dense→modal redesign — OpenTUI Quiet UI milestone |
| **New geometry owners** | Extra row constants, parallel height math, per-surface “just one more budget” |
| **New scroll owners** | Another `useScroll*` / manual slice / local window without a shared lease design |
| **Dual-stack expansion** | Growing `modal-stack` and `overlay-stack` in parallel; new absolute overlays |
| **Long-lived Ink platform work** | Building a geometry/scroll platform on Ink that we rewrite later |
| **“While we’re here” polish** | Theme, glyphs, non-blocking layout nits that are not session-killers |

**One-line rule for PR review:** if the change invents chrome, geometry, or scroll ownership rather than unblocking a broken daily path, reject it for Ink and route to the OpenTUI platform epic.

---

## 2. P0 definition

A ticket is **P0 for Ink** only when **all** of the following hold:

1. **Daily use** — hits a normal coding session (stream, approve, type mid-run, scroll the log, quit), not a rare edge.
2. **Session-killer or data-risk** — operator cannot finish the session, loses work, or hits a hard wrong action (e.g. accidental interrupt with no recovery path). Cosmetic overflow that still leaves a usable prompt is not P0.
3. **No reasonable workaround** that is already documented or discoverable in-session (e.g. resize, close a panel, `/clear`).
4. **Fixable with a minimal patch** — does not require a new layout owner, shared list kit, or dual-stack redesign.

### P0 examples (would justify a minimal Ink patch)

- Prompt or event log fully unusable on a common terminal size (e.g. 80×24) during a normal session
- Permission / operator modal completely unusable (cannot approve, cannot Esc)
- Hard crash or hang on open/close of a primary surface
- Terminal left broken after quit (alt-screen garbage that requires killing the terminal)
- Regression: a path that worked last release is broken on main

### Not P0 (absorb into platform / defer)

- Picker list scrolls awkwardly but is still selectable
- Goal / task / agents strip steals rows but log still has a few usable lines
- Settings / help absolute paint leaves a one-frame ghost
- Line-granular scroll feel, follow-tail polish, long-log virtualization
- Chrome “looks random” under stacked panels without losing the session
- Feature requests for new chrome, palette, or queue/steer UX (interaction contract lands on OpenTUI)

When in doubt: **not P0**. Prefer absorb over patch.

---

## 3. Patch rules (when P0 is granted)

If a change is accepted as P0 Ink work:

1. **Minimal** — smallest diff that restores the daily path. No drive-by refactors of chrome-zones, geometry hooks, or scroll hooks.
2. **No new chrome features** — no new permanent strips, badges, or zone types on Ink.
3. **No new geometry owners** — do not add constants that must stay in sync with paint; do not invent a second residual-height formula. Prefer clamping or a one-line correction at the existing owner.
4. **No new scroll leases** — do not introduce another independent scroll hook; fix the broken owner in place if possible.
5. **No dual-stack growth** — do not add a third overlay path or expand absolute-positioned surfaces.
6. **Document the debt** — PR description links the failure class to the platform epic (list kit, geometry resolver, overlay host, scroll lease) so the real fix is not forgotten.
7. **Tests only where they pin the regression** — thin unit test at the existing seam; do not build an Ink layout harness as a substitute for the OpenTUI harness.

Reviewer checklist (paste into PR if helpful):

- [ ] Daily-use session-killer with no workaround?
- [ ] Diff stays at existing owner (no new zone/scroll/geometry module)?
- [ ] No new chrome feature or dual-stack surface?
- [ ] Related platform ticket / epic link present?
- [ ] Not inventing work that the migration branch will delete?

---

## 4. Triage dispositions

| Disposition | Meaning | When |
|---|---|---|
| **Absorb** | Fix only on the OpenTUI platform / migration branch | Failure class is layout/scroll/overlay architecture |
| **P0 Ink patch** | Minimal mainline Ink fix now | Meets §2 P0 bar; patch rules in §3 |
| **Defer** | Valid product issue; not blocking cutover; schedule after platform or Quiet UI | Polish, non-daily, or depends on platform primitives |
| **Cancel** | Duplicate of a failure class already owned by platform acceptance scenarios, or obsolete after cutover | Same root cause as absorb; no separate ship path |

Default for overflow/scroll/layout tickets: **Absorb**.

---

## 5. Triage table (known failure classes)

Symptom-first rows. IDs appear only where the epic plan already named them; do not treat this table as a Linear inventory.

| Symptom / class | Disposition | Rationale |
|---|---|---|
| Provider / model picker list scroll wrong or jumps | **Absorb** | Shared list viewport kit + scroll lease on OpenTUI; not a new Ink scroll owner (e.g. historical provider-picker class) |
| Goal resume / mode chrome overflows or stacks until log dies | **Absorb** | Zone budget + collapse defaults; Quiet UI after geometry exists (e.g. goal/mode chrome overflow class) |
| Permissions / operator row budget wrong; list clips or overpaints status | **Absorb** | Overlay host measures remaining box; list kit keep-active-visible — epic acceptance scenarios |
| Settings / help / slash absolute paint ghosts or wrong height | **Absorb** | Kill dual ModalStack vs OverlayStack; one overlay host with layout-owned clip |
| Scroll hygiene / line-granular scroll feel | **Absorb** | One scroll lease; follow-tail + long-log working set on platform |
| Transcript residual wrong (guessed `CHROME_ROWS` vs paint) | **Absorb** | Single geometry owner that measures; no parallel magic constants |
| Variable chrome stacks (`extraChromeRows`) until transcript is 1 row | **Absorb** | Hard min transcript floor + chrome priority; zone registry on constitution/platform |
| Overlay height reuse (settings ← permissions budget, etc.) | **Absorb** | Per-surface measure under one host; kill hardcoded overlay heuristic table |
| Ink `flexGrow` on log **and** manual row subtraction fight | **Absorb** | One layout equation owned by shell; do not “fix” by tuning both on Ink |
| N independent scroll hooks (log, prompt, agents, subagent, pickers) | **Absorb** | Focus tree + single scroll lease; subagent observe restores parent lease |
| Mouse wheel scrolls wrong surface when modal open | **Absorb** | Wheel follows active lease only |
| Prompt multi-line paste steals entire transcript | **Absorb** (unless log vanishes completely on common size → **P0**) | Prompt internal scroll + cap is platform; grant P0 only if daily session is unusable on 80×24 |
| Stream auto-follow / pin-on-scroll-up wrong | **Absorb** | Follow-tail contract on OpenTUI transcript |
| Long log lag (multi-thousand lines) | **Absorb** | Viewport working set / collapse off-screen; not Ink virtualization project |
| Focus stuck after modal close; Esc silent no-op | **P0** if prompt dead; else **Absorb** | Focus tree is platform; P0 only when operator cannot return to typing |
| Accidental Enter-interrupt / queue inversion | **Defer** to interaction cutover on OpenTUI | Locked product change; not an Ink chrome patch |
| Command palette / discovery split | **Defer** | Palette milestone; forbidden as Ink chrome feature |
| Theme / glyph polish | **Defer** / **Cancel** for Ink | Quiet UI after structure |
| Crash on open permission modal; cannot approve | **P0 Ink patch** | Daily-use blocker; minimal restore only |
| Quit leaves alt-screen / broken TTY | **P0 Ink patch** | Safety / terminal integrity |
| Duplicate ticket of a class already in acceptance corpus | **Cancel** (link to platform scenario) | Platform pass replaces one-by-one Ink fixes |

---

## 6. How to add new tickets

1. **Classify the symptom** against the table above (or add a row if the class is new).
2. **Default disposition: Absorb.** Link the ticket to the TUI layout and scroll platform project / migration consumer (list kit, geometry, overlay host, scroll lease, transcript) — not a standalone “deep Ink fix” epic.
3. **P0 exception:** author must write the four-part P0 case (§2) in the ticket and propose a **minimal** Ink patch. Reviewer applies §3 checklist.
4. **Do not** open parallel “rewrite geometry on Ink” work. If OpenTUI is blocked, escalate as a **risk** (spike / product), not as permission to build a long-lived Ink platform.
5. After cutover, open Ink-only layout tickets are **Cancel** unless they describe a migration regression on the new shell (then they are OpenTUI bugs).

Cutover is **branch hard cutover** — no dual-release Ink+OpenTUI product mode. See `docs/tui-migration-cutover.md`.

---

## 7. Related docs

| Doc | Role |
|---|---|
| `briefs/tui-rebuild-opentui.md` | Product north star |
| `docs/plans/tui-layout-scroll-platform.md` | Epic plan, non-goals, acceptance corpus, failure classes |
| `docs/tui-layout-constitution.md` | Principles, chrome budget, geometry contract, kill list |
| `docs/tui-interaction-contract.md` | Queue / steer / interrupt / palette bindings |
| `docs/tui-migration-cutover.md` | Hard cutover, merge gate, scrap-on-fail |
| `docs/PRODUCT.md` | Product UX claims (TUI section) |
| `docs/ARCHITECTURE.md` | System architecture |

---

## 8. Reviewer one-pager

**Question:** “May this PR touch Ink layout/scroll/chrome?”

| Answer | Condition |
|---|---|
| **Yes, minimal** | True P0 daily-use blocker; patch rules held; debt linked to platform |
| **No — absorb** | Overflow/scroll/overlay/geometry class; fix on OpenTUI migration branch |
| **No — defer** | Product/polish that waits for platform or Quiet UI |
| **No — cancel** | Duplicate of acceptance-corpus failure class |

Ink freezes until cutover deletes it. Spend design energy on the platform, not on a second geometry system that dies at merge.
