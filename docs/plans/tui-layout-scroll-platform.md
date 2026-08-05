# TUI rebuild: OpenTUI shell, layout platform, Amp-class calm

**Status:** plan (source of truth for Linear project *TUI layout and scroll platform*)  
**Product brief:** `briefs/tui-rebuild-opentui.md`  
**Project:** https://linear.app/abklabs/project/tui-layout-and-scroll-platform-2f172c54fa83  
**Issues:** CL-5364–CL-5388 + CL-5391–CL-5400 (follow-ups from this plan)

This document is written **before** treating the Linear backlog as shippable work. Tickets are expanded from here, not the reverse.

---

## 1. Problem

The Corbits Code TUI feels random because it is a **systems failure**, not a pile of unrelated bugs.

### What users hit

- Scroll and overflow break under long sessions, dense approvals, stacked chrome, and small terminals.
- Mid-run steering is inverted vs Amp (Enter interrupts; Alt+Enter queues) and hard to discover.
- Discovery is split across slash commands, a help overlay, and tribal key knowledge.
- Linear is full of closed and open tickets in the **same failure class**: guessed row budgets, per-surface scroll, dual overlay stacks.

### Root cause (architecture)

| Concern | Today | Failure |
|---|---|---|
| Fixed chrome | `chrome-zones.ts` constants (`header:2`, `prompt:3`, `status:2`, …) sum to a fixed `CHROME_ROWS` | Constants drift from paint |
| Variable chrome | `chrome-geometry.ts` + `extraChromeRows` (goal, task, agents, banners, prompt growth) | Stacks until transcript is 1 row |
| Overlay height | Hardcoded budgets in `use-layout-geometry.ts` (permissions 6/20, operator 7, help 16, …) | Reuse of wrong budget (e.g. settings ← permissions) |
| Paint | Ink `flexGrow` on the log **and** manual row subtraction | Two systems claim the same height |
| Scroll | `use-scroll`, `use-scroll-window`, prompt-local offset, agents strip window, subagent fork, manual slices in agent/settings/plugins/resume | N owners, no lease |
| Focus | Boolean soup in `app.tsx` + per-modal `useInput` | Keys/wheel race |
| Overlays | `modal-stack.tsx` **and** `overlay-stack.tsx` | Inconsistent height accounting; absolute-positioned settings/slash |

**Effective equation today:**

```
visibleRows = terminal.rows
  - CHROME_ROWS
  - overlayHeuristic
  - extraChromeRows
```

Paint does not obey this equation exactly. Overflow tickets are the equation lying.

### Teardown inventory (surfaces)

| Surface | Layout | Scroll |
|---|---|---|
| Event log | Residual rows from geometry hooks | `useScroll` + `useTranscriptLayout` + `useMouseScroll` |
| Chat prompt | Cap ~40% / max height 8 | Local window (`prompt-layout`) |
| Permission / operator | Modal-local height | `useScrollWindow` |
| Agent modal | Modal list | Manual slice |
| Mentions | Fixed maxHeight | `useScrollWindow` |
| Permissions / settings / plugins / resume | Overlay panes | Local window each |
| Subagent session | Full-screen fork | Own offset (parallel to main log) |
| Agents strip | Extra chrome row | Horizontal only |

Tests cover `use-scroll-window` and `prompt-layout` thinly. Missing: chrome-zones/geometry, use-scroll, mouse gating, overlay→shrink integration, size matrix.

---

## 2. Decision (locked)

1. **Target substrate: OpenTUI** (`@opentui/core` + binding chosen in spike). Same family as OpenCode.
2. **Do not** build a long-lived geometry/scroll platform on Ink and rewrite later.
3. **Ink policy:** only true P0 daily-use blockers get minimal patches; no new chrome features on Ink (CL-5367).
4. **UX north star: Amp-class calm**, implemented on OpenTUI — not a copy of Amp's product surface.
5. **Peers for comparison:** Amp (feel), OpenCode (stack), Claude Code / pi (interaction baselines). pi-tui is **not** the destination stack.

---

## 3. Product definition

### Who

Terminal-first developers already on Corbits or evaluating agent CLIs. They abandon tools that fight them mid-stream.

### Good 30-minute session

1. Screen paints once; prompt ready; no thrash on first stream token.
2. Stream + tools auto-follow unless operator scrolled up (clear “follow live”).
3. Mid-run type → **Enter queues** (badge); interrupt is a distinct labeled chord.
4. Permission overlay measures remaining box; focus returns cleanly.
5. Orchestrator: agents strip thin; observe intentional; Esc leaves.
6. Scroll back, keyboard copy path works, quit without alt-screen garbage.

### Success (human-visible)

- Calm layout under stream + modal open/close.
- Queue-default steering; interrupt discoverable.
- Command palette finds permissions/model without memorizing slash.
- Chrome budget held on 80×24 (≥ ~12 log rows idle).
- Keyboard copy of a message/tool/diff without relying on terminal drag-select.
- Fewer “TUI broken / scroll wrong / accidental interrupt” session-killers.

---

## 4. Amp: steal / adapt / ignore

| Amp idea | Verdict |
|---|---|
| Solid TUI foundation, no flicker, smooth stream scroll, overlays | **Steal** via OpenTUI |
| Command palette (Ctrl+O) as primary discovery | **Steal** — today Ctrl+O expands tool output; rebind |
| Queue-by-default mid-run; interrupt special | **Steal** — invert Enter vs Alt+Enter |
| Steer at tool boundary vs hard interrupt | **Adapt** — queue + interrupt first; deep steer later |
| One visual system | **Steal** — one theme |
| Keymap customize | **Adapt** — discoverable v1; settings remap later |
| Plugin UI notify/confirm/input/select | **Adapt** — TUI-only v1 |
| Remote control / web mirror / multiplayer | **Ignore** this project |
| Perfect mouse selection | **Ignore** — ship deliberate keyboard copy (learn Amp scar) |
| Unlimited historical render | **Ignore** — long-log strategy required (learn Amp lag scar) |

Sources: [Owner's Manual](https://ampcode.com/manual), [Look Ma, No Flicker](https://ampcode.com/news/look-ma-no-flicker), [Command Palette](https://ampcode.com/news/command-palette), [Amp Rebuilt](https://ampcode.com/news/neo).

---

## 5. Principles (constitution)

1. **Transcript pays the rent.** Fixed chrome is thin. Dense UI is modal or collapsed.
2. **Measure, do not guess.** One layout owner; no parallel magic constants that must match paint.
3. **One scroll owner (lease) at a time.** Keys and wheel follow the same focus tree.
4. **One list viewport kit.** Models, permissions, agents, approval options, settings lists share windowing + keep-active-visible + page/jump.
5. **One overlay host.** Kill the ModalStack vs OverlayStack split in the design.
6. **Visual quiet.** State via text and color; no glyph zoo. One theme.
7. **Queue-default steering.** Interrupt is loud and rare.
8. **Palette discovers.** Slash remains a power path, not the only path.
9. **Platform before features.** No new chrome until shell + kit land.
10. **Hard min transcript rows** on 24-row terminals; chrome priority when space is scarce.

### Chrome budget (v1 numbers)

| Zone | Idle rows (target) | Notes |
|---|---|---|
| Header | ≤ 2 | Profile / workflow chip |
| Progress | 0 or 1–2 | Only while active / workflow |
| Model / action bar | 1 | Above prompt |
| Prompt (bordered) | 3+ content growth capped | Cap fraction of terminal; scroll internally |
| Status | 1–2 | Under prompt |
| Goal / task / agents / plugin | 0–1 each, collapsed default | Dense detail → modal or expand |
| **Transcript** | **≥ 12 on 80×24 idle** | Non-negotiable floor |

Dense content never becomes an unbounded permanent strip.

### Interaction contract (v1) — **LOCKED**

| Intent | Binding | Notes |
|---|---|---|
| Command palette | **Ctrl+O** | Reclaim from tool-expand |
| Queue message mid-run | **Enter** (when agent busy) | Badge count on prompt; does **not** stop the agent |
| Steer ASAP | **Alt+Enter** | Deliver at next **tool boundary** (Amp-like steer) |
| Interrupt now | **Ctrl+C** | Hard stop current run (must not be plain Enter) |
| Help / keymap | Palette + `/help` | Tables must match |
| Copy path | **Alt+C** (existing direction) | Message/tool/diff; not mouse-drag |
| Esc | Pop focus stack | Overlay → prompt; never silent no-op |
| Wheel | Active scroll lease only | Disabled for transcript when modal owns focus |

**Queue drain:** messages deliver at **tool boundary** (next tool result / ASAP opportunity), not only full idle. Enter enqueues; Alt+Enter steers (priority ASAP at tool boundary). Exact micro-semantics (queue vs steer priority when both pending) live in CL-5394 constitution.

**Breaking change:** today's Enter-interrupt / Alt+Enter-queue is inverted and expanded (Ctrl+C = interrupt). Document once; no legacy toggle in v1 (educate on hint line + release note).

---

## 6. Target architecture

```
┌─────────────────────────────────────────┐
│ OpenTUI app shell (single layout owner) │
│  header │ transcript │ prompt │ status  │
│           overlay host (modal mode)     │
└─────────────────────────────────────────┘
         │                    │
   geometry contract    focus tree + scroll lease
         │                    │
   zone registry        list viewport kit
   (declared heights)   (shared windowing)
```

### Contracts (define before porting surfaces)

**Geometry**

- Inputs: terminal size, declared chrome zones (measured or fixed-with-test), overlay mode.
- Outputs: region rects (x, y, width, height) for header, transcript, prompt, status, overlay.
- Forbidden: leaf components subtracting magic constants from `process.stdout.rows`.

**Scroll**

- Content model + **measured row heights** (or OpenTUI-native scroll that owns measurement).
- Pin policy: follow-tail vs user-pinned; jump-to-bottom affordance.
- Scroll unit must not be “virtual log line index that changes height under wrap.”

**Focus**

- Tree: overlay host > entered subagent > prompt/transcript shell.
- Exactly one scroll lease; keyboard and wheel share it.
- Restore previous focus on close.

**Long log (LOCKED ideal)**

- Keep a hard working set: only content near the viewport is fully expanded/rendered.
- When the operator scrolls **up**, material that leaves the bottom of the viewport **collapses/hides**; material scrolling into view at the top **expands/shows**.
- Symmetric when scrolling down: off-screen content collapses; in-view content is real.
- Goal: multi-thousand-line sessions stay interactive without rendering the entire history at full fidelity.
- Numeric N / window size set during CL-5399 with a laptop budget (interactive scroll after multi-k lines).

### Kill list (must not reappear on OpenTUI)

- Guessed fixed row tables that drift from paint
- Parallel geometry hook + paint tree heights
- Absolute overlays without layout-owned clip
- N independent scroll hooks without a lease
- Unbounded stacked chrome with only `max(1, …)` floor
- Reusing one overlay budget for another surface

### Non-goals (this project)

- Web workbench / portal UI
- Amp remote control / multi-thread / web plugin mirror
- Inference, permission policy, or agent-loop rewrites (except TUI wiring)
- Theme marketplace
- Perfect native drag-select
- Building on pi-tui or staying on Ink as destination
- Full keymap settings editor (unless free with table)
- **Dual-release Ink + OpenTUI** — no shipping two paint paths; migration is branch-hard-cutover
- **Windows** as a v1 support target (do not block on it)

---

## 7. Migration strategy (branch hard cutover) — **LOCKED**

**Not** a dual-entry product flag. **Not** shipping OpenTUI until the whole epic is ready.

1. **Spike** OpenTUI on Bun (FFI, install, binding) → go/no-go. Spike *is* the start of the migration branch attempt.
2. **Constitution** locks budget, focus, scroll, palette, queue/steer/interrupt (docs + acceptance scenarios).
3. **Single migration branch** builds the full OpenTUI shell + platform + all primary surfaces.
4. **Gate:** whole epic acceptance corpus green → merge and ship. If it fails, **scrap the branch** and stay on Ink (do not land half).
5. **Platform** on that branch: shell + geometry + list kit + focus/scroll lease + harness.
6. **Migrate critical path** on that branch: transcript → prompt → approvals/operator → pickers → agents/goal chrome → permissions/settings/help → palette.
7. **Quiet UI** on that branch after geometry rules exist.
8. **Remove Ink** as part of the same cutover (not a later flag flip on main).
9. **Bar** before merge: size matrix, peer pass (incl. Amp), long-session smoke.

### Strangler order (on the migration branch)

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

### Rollback / failure mode

- **Before merge:** scrap migration branch; main stays Ink.
- **After merge:** normal git revert of the merge if catastrophic; no permanent dual paint path.
- Never ship “OpenTUI shell with Ink fallback” as a product mode.

### Platform support (LOCKED)

| Priority | Platform | Packaging / Bar |
|---|---|---|
| **#1** | **macOS** | Must pass; primary development target |
| **#2** | **Linux** | Must pass for CI/server users |
| — | **Windows** | Do not block v1; best-effort only if free |

---

## 8. Milestone map

| Milestone | Intent | Gate |
|---|---|---|
| **0. Renderer** | OpenTUI spike, binding, packaging plan, comparison note | Go/no-go written |
| **1. Constitution** | Budget, ownership, freeze policy, interaction contract | Reviewed + locked |
| **2. Platform** | Shell, geometry, list kit, focus/scroll, harness | Unit + harness green |
| **3. Migration** | All primary surfaces on branch; hard cutover | Acceptance corpus green; Ink deleted on merge |
| **4. Quiet UI** | Collapse chrome, glyph quiet, dense→modal | Budget held on 80×24 |
| **5. Bar** | Size matrix (macOS #1, Linux #2), peers (Amp/OpenCode/Claude/pi), long smoke | Acceptance signed |

---

## 9. Issue index (Linear)

### 0. Renderer

| ID | Title | Plan role |
|---|---|---|
| CL-5365 | Spike OpenTUI on Bun | Go/no-go evidence |
| CL-5366 | Binding choice | Decision record from spike |
| CL-5368 | Renderer comparison note | Fold into spike decision (not floating research) |
| CL-5370 | Install/CI/packaging | Plan early; implement after go |

### 1. Constitution

| ID | Title | Plan role |
|---|---|---|
| CL-5364 | Layout constitution | Principles + contracts |
| CL-5367 | Freeze Ink chrome | Policy + open-ticket triage |
| CL-5369 | Chrome zone registry | Budget numbers + registry |

**Filed from this plan:** CL-5395 focus design · CL-5394 interaction contract · CL-5398 dual-entry · CL-5397 palette · CL-5393 follow-tail · CL-5399 long-log · CL-5391 copy path · CL-5396 ticket triage · CL-5400 plan lock · CL-5392 residual overlays.

### 2. Platform

| ID | Title | Plan role |
|---|---|---|
| CL-5377 | App shell | Frame owner |
| CL-5372 | Geometry resolver | Measured regions |
| CL-5376 | List viewport kit | Shared lists |
| CL-5374 | Input ownership impl | Focus tree + scroll lease |
| CL-5373 | Test harness | Raise priority; before kit claims CI |

### 3. Migration

| ID | Title | Plan role |
|---|---|---|
| CL-5375 | Transcript / event log | Critical path |
| CL-5371 | Prompt box | + queue-default wiring |
| CL-5382 | Approvals / operator | Overlay host consumer |
| CL-5380 | Model/provider pickers | List kit consumer |
| CL-5379 | Agents / goal / task chrome | Zone model |
| CL-5384 | Permissions UI | List kit + budget |
| CL-5381 | Remove Ink | Endgate |

**Missing surfaces to cover in expansion:** settings, help, status/header, subagent session view, plugins manager, session resume, mention list, streaming markdown host.

### 4. Quiet UI

| ID | Title | Plan role |
|---|---|---|
| CL-5383 | Collapse mode/goal/task | Defaults |
| CL-5385 | Dense → modal | Product rule enforcement |
| CL-5378 | Glyph quiet | Polish after structure |

### 5. Bar

| ID | Title | Plan role |
|---|---|---|
| CL-5386 | Size matrix | Also early regression, not only end |
| CL-5387 | Peer pass | **Add Amp** to checklist |
| CL-5388 | Long-session smoke | Ghosting / overpaint / resize |

---

## 10. Acceptance corpus (scenarios)

These replace “fix overflow bugs one by one.” Each must pass on OpenTUI before cutover.

1. **Starved chrome:** goal + tasks + agents + active progress on 24 rows → transcript still ≥ min floor; expand/collapse works.
2. **Permission list:** 30 options; keep-active-visible; wheel only on list; close restores prompt.
3. **Operator question:** long prompt text + many choices; no overpaint into status.
4. **Prompt expand:** multi-line paste; internal scroll; transcript does not vanish.
5. **Stream follow:** continuous tool output; auto-follow; scroll up pins; jump-to-bottom returns.
6. **Queue mid-run:** type + Enter while busy → badge; agent continues; Alt+Enter steers at tool boundary; Ctrl+C interrupts.
7. **Palette:** Ctrl+O → open permissions → Esc → prompt focused.
8. **Copy path:** Alt+C style flow copies last assistant message without mouse.
9. **Subagent observe:** enter child, scroll independently, Esc to parent; parent lease restored.
10. **Resize mid-session:** 80×24 ↔ 120×40; no ghost lines; prompt row stable.
11. **Settings / help:** open/close; no residual absolute paint.
12. **Long log:** multi-thousand lines; scroll remains interactive (define numeric budget in CL long-log).

Map each scenario to automated harness where possible; manual for terminal-specific paint.

---

## 11. Related failure-class tickets (triage)

Absorb into platform rather than deep Ink fixes (unless true P0):

- Provider picker scroll (e.g. CL-5363)
- Goal resume / mode chrome overflow (e.g. CL-5199, CL-5196)
- Permissions row budget
- Scroll hygiene / line-granular scroll historical class

Policy: **minimal Ink patch only if daily-use blocker**; otherwise link as related to migration consumer tickets.

---

## 12. Decisions (LOCKED 2026-08-05)

| # | Topic | Decision |
|---|---|---|
| 1 | Mid-run **Enter** | **Queue** (badge); does not stop agent |
| 2 | Mid-run **Alt+Enter** | **Steer** ASAP at next **tool boundary** |
| 3 | **Ctrl+C** | **Interrupt** current run (hard stop) |
| 4 | Queue drain | **Tool boundary** (not only full idle/turn end) |
| 5 | OpenTUI **binding** | **Spike decides** (React vs Solid vs core) — CL-5365/5366 |
| 6 | OS support | **macOS #1**, **Linux #2**, **Windows do not block** |
| 7 | Long log | Viewport working set: scroll up → collapse off-bottom / show into-top; numeric N in CL-5399 |
| 8 | Cutover | **Branch hard cutover** — no dual-release Ink+OpenTUI; ship only when whole epic works; scrap branch on fail |

### Still for spike / constitution polish (not product direction)

- Exact queue vs steer priority when both pending (implement CL-5394 with tool-boundary delivery).
- Numeric long-log window size and collapse thresholds (CL-5399).
- Binding ADR after spike evidence (CL-5366).
- Terminal matrix within macOS/Linux (iTerm2, Ghostty, Apple Terminal, tmux, common Linux terms).

---

## 13. Work sequence (do this order)

1. Land this plan + product brief (decisions locked above).
2. Expand Linear issues with plan links, blockers, kill-list, acceptance corpus (done for core set).
3. Constitution pack (CL-5364/5369/5394/5395) + Renderer spike (CL-5365) in parallel.
4. Open migration branch after go; build full epic on branch.
5. No merge until acceptance corpus + Bar minimum green.
6. No Quiet UI chrome redesign until Migration geometry exists on branch.
7. Run size matrix on each migration PR on the branch (continuous, not end-only).

---

## 14. References

- Product brief: `briefs/tui-rebuild-opentui.md`
- Product UX claims: `docs/PRODUCT.md` (TUI section)
- Architecture: `docs/ARCHITECTURE.md`
- Current ownership: `src/tui/chrome-zones.ts`, `chrome-geometry.ts`, `hooks/use-layout-geometry.ts`, `hooks/use-scroll*.ts`, `components/event-log.tsx`, `app.tsx`, `modal-stack.tsx`, `overlay-stack.tsx`
- Amp: https://ampcode.com/manual
- OpenTUI / OpenCode: peer stack reference
- pi-tui: comparison only (`@earendil-works/pi-tui`)
