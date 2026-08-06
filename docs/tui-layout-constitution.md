# TUI layout constitution

**Status:** locked for Platform wave (OpenTUI rebuild)  
**Scope:** layout principles, chrome zone registry, geometry contract, kill list  
**Not this doc:** keybindings and mid-run semantics (`docs/tui-interaction-contract.md`), Ink freeze policy (`docs/tui-ink-freeze.md`), migration cutover (`docs/tui-migration-cutover.md`)

This constitution is the implementer contract for shell geometry on the OpenTUI migration branch. Product direction and epic sequencing live in `briefs/tui-rebuild-opentui.md` and `docs/plans/tui-layout-scroll-platform.md`. Do not reopen locked product decisions here.

---

## 1. Purpose

The Corbits Code TUI fails today as a **systems** problem: guessed row budgets, dual height owners (manual subtraction vs paint flex), dual overlay stacks, and unbounded optional chrome that starves the event log.

This document locks:

1. Layout principles every surface must obey.
2. A chrome zone registry with row budgets and collapse rules.
3. A single geometry contract (who measures, who owns residual height).
4. A kill list of patterns that must not reappear on OpenTUI.

Implementers without external ticket context should still be able to build shell, geometry, and chrome zones from this file alone.

---

## 2. Principles

These are hard contracts, not preferences.

1. **Transcript pays the rent.** Fixed chrome stays thin. Dense UI is modal or collapsed by default. Optional strips never stack without bound.
2. **Measure, do not guess.** One layout owner produces region rects. Leaf components consume those rects. They do not invent heights or subtract magic constants from terminal size.
3. **One geometry equation.** Paint and reservation use the same measured heights. Parallel “hook math” that can drift from the paint tree is forbidden.
4. **Residual transcript.** After fixed chrome, optional chrome (within budget), and the active overlay region are accounted for, remaining height belongs to the transcript. The transcript is never reduced below the hard floor by optional chrome (see §4).
5. **One overlay host.** Blocking surfaces share one host and one height path. No second stack with separate row accounting.
6. **One scroll owner (lease) at a time.** Keyboard and wheel follow the same focus tree. Details of lease handoff live with focus design; layout only ensures each region has a well-defined rect to scroll inside.
7. **One list viewport kit.** Models, permissions, agents, approval options, settings lists share windowing, keep-active-visible, and page/jump. Layout provides the box; the kit fills it.
8. **Modals measure the remaining box.** Overlays size against the layout-owned overlay region (or full-shell modal mode), not against raw `stdout.rows`.
9. **Hard min transcript rows** on 24-row terminals; **chrome priority** when space is scarce (collapse order in §3.3).
10. **Platform before features.** No new permanent chrome zones until shell + geometry + registry land on the migration branch.
11. **Visual quiet (layout implication).** State via text and color density, not extra permanent rows of glyph chrome.
12. **Long log is a working set.** Only near-viewport content is fully expanded/rendered. Off-viewport material collapses. Numeric window size is set with long-log work, not ad hoc per surface.

---

## 3. Chrome zone registry

### 3.1 Reference terminal

Budgets are validated against **80×24** as the hard floor and **120×40** as the common laptop size. macOS is primary; Linux is secondary; Windows does not block v1.

**Non-negotiable:** on **80×24 idle** (no overlay, optional strips collapsed), the transcript region is **≥ 12 rows**.

### 3.2 Zone table

| Zone | Role | Idle target (rows) | Min | Max | Collapse / resize rules | Owner |
|---|---|---|---|---|---|---|
| **progress** | In-flight phase / workflow line | 0 when idle; 1–2 when active or workflow chip | 0 | 2 | **0** when inactive and no workflow chip. Shown only while agent is active or a workflow chip needs it. | Shell |
| **progress_divider** | Hairline above prompt stack | 0–1 | 0 | 1 | Present only when the prompt stack is painted as a distinct block. Prefer absorbing into prompt chrome if a hairline is free on OpenTUI. | Shell |
| **model_bar** | Session · profile · model · effort above prompt, dim and right-aligned | 1 | 0 | 1 | Collapse to 0 only under extreme starve (see §3.3); restore as soon as space allows. | Shell |
| **prompt** | Bordered input (content + borders) | 3 base | 3 | Cap: **≤ 40% of terminal rows**, and never so large that transcript falls below floor when only prompt grows | Content growth **scrolls inside** the prompt box. Cap fraction is of full terminal height. Multi-line paste must not steal the log permanently. | Shell + prompt |
| **hint** | Stateful key hints under the prompt | 1 | 1 | 1 | Exactly one dim row showing the keys that work in the current state. State (queue depth, interrupt latch, pinned scroll) appears only when it is not at its default. Never a filled bar. | Shell |
| **goal** | Goal / acceptance strip | 0 default | 0 | **1** collapsed; expanded dense detail → **modal** | Default collapsed or hidden. Implementing phase may show a compact 1-row chip. Full criteria lists are modal, not an unbounded strip. | Zone registry consumer |
| **task** | Work checklist strip | 0 default | 0 | **1** collapsed; expand → **modal** or temporary expand capped at **proposed 5** content rows then modal | Default off or 1-row summary. Full checklist is not a permanent multi-row tenant. | Zone registry consumer |
| **agents** | Orchestrator agents strip | 0 in single-agent; 0–1 collapsed in orchestrator | 0 | **1** collapsed; observe/expand → modal or dedicated region under overlay host | Single-agent sessions pay **0**. Orchestrator default is a thin strip, never a permanent multi-row roster. | Zone registry consumer |
| **plugin_banner** | Plugin / MCP auth / thin notices | 0 | 0 | **1** each class, dismissible or timed | Never stacks multiple multi-line plugin UIs into chrome. Dense plugin admin is overlay. | Shell banners |
| **command_banner** | Command feedback | 0 | 0 | **1–2**, short-lived | Auto-dismiss or Esc; not a permanent zone. | Shell banners |
| **settings_notice** | Settings diagnostics | 0 | 0 | **proposed ≤ 3** rows then collapse remainder into modal/settings | Multi-line dump of every diagnostic is forbidden in chrome. | Shell banners |
| **transcript** | Event log (residual) | **≥ 12** on 80×24 idle | **12** on 24-row idle; **proposed ≥ 8** when overlay open on 24-row | Remaining height | Always residual after higher-priority zones. Optional chrome may not push idle transcript below floor. | Geometry owner |
| **overlay_host** | Single modal / blocking surface | 0 when closed | 0 | Layout-owned region: **proposed ≤ 70% of terminal rows**, and never eliminates the prompt stack entirely on 24-row | One primary blocking overlay at a time. Open replaces or stacks with a single Esc path back to prompt. Height is measured for the active surface inside the host box (list kit + wrap measure), not a per-surface magic constant table outside the host. | Overlay host |

**Proposed (not yet paint-proven) defaults** are marked **proposed**. Locked floors: progress 0 or 1–2, model bar 1, prompt exactly 3 (capped growth), hint 1, optional strips 0–1 collapsed, transcript ≥ 12 on 80×24 idle.

There is no titlebar and no status strip. The prompt box is the product: it is anchored at the bottom in every state, and the only permanent chrome around it is the dim model bar above and the dim hint row below. No zone paints a full-width background fill.

### 3.3 Chrome priority when space is scarce

When `terminal.rows` cannot host all desired chrome without violating the transcript floor, collapse in this order (first cut first):

1. Temporary banners (`command_banner`, timed notices) — drop or force-dismiss.
2. `settings_notice` / `plugin_banner` — collapse to 0 or single-line “N notices” chip.
3. Expanded `goal` / `task` / `agents` — force collapsed (0–1) or push dense content to modal.
4. `progress` — if idle, already 0; if active, prefer 1 row over 2.
5. `progress_divider` — drop if still short.
6. `model_bar` — last fixed chrome to shrink (0 only under extreme starve).
7. `prompt` — never below 3; growth reclaims only via internal scroll (already capped).

`hint` is never collapsed: one row, in every mode, including full-shell modal, where it carries the overlay's own keys.

**Overlays:** opening a blocking overlay may shrink the transcript below the idle floor, but must leave a **proposed ≥ 8** row transcript (or hide transcript entirely only in full-shell modal mode, where the overlay owns the residual box and the prompt remains reachable on Esc). Full-shell modal mode is explicit (e.g. model picker, settings), not the default for thin permission prompts.

### 3.4 Idle budget check (80×24)

Example idle layout that satisfies the floor:

| Zone | Rows |
|---|---|
| model_bar | 1 |
| prompt | 3 |
| hint | 1 |
| optional strips | 0 |
| progress | 0 |
| **subtotal chrome** | **5** |
| **transcript residual** | **19** (≥ 12) |

With progress (2) + thin agents strip (1): chrome 8 → transcript 16. Goal+task+agents all expanded as multi-row strips is **out of constitution** — those expansions must modalize or collapse under §3.3.

### 3.5 Today vs target (Ink reference only)

Ink ownership today (do not extend; do not reimplement on OpenTUI):

| Concern | Today | Target |
|---|---|---|
| Fixed chrome | Constants in `src/tui/chrome-zones.ts` summed into a fixed chrome total | Declared zones in registry; measured or fixed-with-test |
| Variable chrome | `src/tui/chrome-geometry.ts` extra rows (goal, task, plugins, banners, prompt growth) | Same registry; collapse rules; dense → modal |
| Overlay height | Heuristics in `src/tui/hooks/use-layout-geometry.ts` | Overlay host measures content inside a layout-owned rect |
| Paint vs math | Flex grow **and** manual subtraction | One owner; paint consumes rects |
| Overlay stacks | Modal stack **and** overlay stack | One host |

---

## 4. Geometry contract

### 4.1 Single owner

The **app shell geometry resolver** is the only module allowed to turn terminal size + zone declarations + overlay mode into region rects.

| Input | Source |
|---|---|
| Terminal size | Runtime resize events (`columns`, `rows`) |
| Declared chrome zones | Zone registry (§3): fixed or measured heights |
| Optional zone visibility | Session state (goal active, tasks present, orchestrator mode, banners) |
| Overlay mode | Closed · inset (shrink transcript) · full-shell modal |
| Content measures | Prompt wrap height (capped); overlay body measure (list kit / wrap) |

| Output | Meaning |
|---|---|
| Region rects | `{ x, y, width, height }` for transcript, prompt stack, hint, overlay host, and each active optional strip |
| Transcript residual height | Explicit; not re-derived in leaves |
| Scroll lease region | Which rect currently owns wheel/page keys (focus tree decides *who*; geometry provides *where*) |

### 4.2 Forbidden in leaves

Leaf components **must not**:

- Read `process.stdout.rows` / columns and subtract magic constants.
- Maintain a private “overlay budget” table that other surfaces reuse incorrectly.
- Assume full terminal height for a modal without subtracting layout-owned chrome.
- Call `flexGrow` (or OpenTUI equivalent) in a way that competes with the residual transcript assignment.
- Grow optional chrome without going through the registry and collapse rules.

### 4.3 Residual transcript equation

Conceptual (implementation may use measured zone heights rather than a single sum of constants):

```text
chromeHeight     = sum(visible zone heights from registry, after collapse)
overlayHeight    = 0 | measured overlay host region
transcriptHeight = terminal.rows - chromeHeight - overlayHeight

assert transcriptHeight >= idleFloor     when overlay closed and only allowed chrome
assert transcriptHeight >= overlayFloor  when inset overlay (proposed ≥ 8 on 24-row)
```

`idleFloor` = **12** on 24-row terminals. On taller terminals, idle floor remains **12** minimum (do not spend extra rows on chrome by default; extra rows accrue to the transcript).

**Proposed** on terminals shorter than 24: still attempt floor of `max(6, rows - maxChromeForTiny)` and refuse to open non-essential optional strips; exact tiny-terminal matrix is Bar work.

### 4.4 Resize

On every resize:

1. Re-run the geometry resolver with new `columns` / `rows`.
2. Re-apply collapse rules if the transcript would breach the floor.
3. Re-measure overlay body within the new host rect (lists re-window; keep-active-visible).
4. No ghost lines: previous absolute paint outside the new rects is invalid — host clears/clips.

Prompt base row count stays stable across resize; only wrap width and internal scroll change.

### 4.5 Overlay host modes

| Mode | Transcript | Prompt / hint | Use |
|---|---|---|---|
| **Closed** | Residual full | Visible | Default session |
| **Inset** | Shrinks; ≥ overlay floor | Visible | Permission, operator question, thin confirms |
| **Full-shell modal** | Hidden or minimal | Hidden or minimal; Esc restores | Model/settings/help-class managers |

Exactly one primary blocking surface. Opening B while A is open either replaces A or pushes a stack with a single Esc path that always returns to the prompt. No orphan focus, no second geometry path.

### 4.6 Prompt growth

- Base bordered prompt: **3** rows (borders + one content line).
- Content may grow with wrap, **capped at 40% of terminal rows**.
- Growth is **internal scroll**, not unbounded chrome.
- Extra prompt rows count against chrome only up to the cap; they still cannot violate the transcript idle floor when no overlay is open — if both cannot be satisfied, prompt stays at base/internal scroll and does not expand further.

### 4.7 Measurement rules

- Prefer **measure after layout** (OpenTUI-native) over hand-maintained constant tables.
- Where a fixed height is used for a zone, it must be **fixed-with-test**: a unit or harness check fails if paint height drifts from the declared budget.
- Overlay bodies: measure wrapped text and list windows inside the host width; do not copy another surface’s row constant.
- Scroll units for the transcript must be based on **measured row heights** (or framework-owned scroll measurement), not virtual indices that change height under wrap.

---

## 5. Kill list

These patterns caused the current failure class. They **must not reappear** on OpenTUI.

1. **Guessed fixed row tables that drift from paint** — constants that are not the same values the shell actually paints, with no test coupling them.
2. **Parallel geometry hook + paint tree heights** — two systems claiming the same vertical space (manual subtraction *and* flex residual).
3. **Absolute overlays without layout-owned clip** — surfaces positioned outside the geometry resolver’s rects.
4. **N independent scroll hooks without a lease** — each modal/list/log owning wheel and keys with no single focus/scroll owner.
5. **Unbounded stacked chrome with only `max(1, …)` as floor** — optional strips that grow until the log is unusable.
6. **Reusing one overlay budget for another surface** — e.g. settings height derived from permissions constants.
7. **Dual overlay stacks** — separate modal and overlay accounting paths.
8. **Leaf magic constants from terminal size** — components computing their own `rows - K`.
9. **Dense permanent strips** — full goal criteria, full task lists, full agent rosters as always-on multi-row chrome.
10. **Idle progress spacers** — reserving progress rows when nothing is painted.

---

## 6. Acceptance scenarios this constitution enables

Full corpus and harness mapping live in `docs/plans/tui-layout-scroll-platform.md` (acceptance scenarios section). Layout-critical scenarios that must stay true under this constitution:

| Scenario | Layout requirement |
|---|---|
| **Starved chrome** | Goal + tasks + agents + active progress on 24 rows → transcript still ≥ floor; expand/collapse works via §3.3 |
| **Permission list** | Host measures list; keep-active-visible; wheel on list lease; close restores prompt rect/focus |
| **Operator question** | Long question + many choices fit host box; no overpaint into the hint row |
| **Prompt expand** | Multi-line paste; internal scroll; transcript does not vanish |
| **Stream follow** | Transcript residual stable under append; no layout thrash |
| **Resize mid-session** | 80×24 ↔ 120×40; resolver re-runs; no ghost lines; prompt base stable |
| **Settings / help** | Full-shell or host modal; open/close leaves no residual absolute paint |
| **Long log** | Working-set render inside transcript rect; interactive scroll (numeric N elsewhere) |

Interaction scenarios (queue, palette, copy, subagent observe) depend on this geometry but are specified in the interaction contract and focus design, not here.

---

## 7. Related docs

| Doc | Role |
|---|---|
| `briefs/tui-rebuild-opentui.md` | Product brief (Amp-class calm, queue-default, palette, chrome rent metaphor) |
| `docs/plans/tui-layout-scroll-platform.md` | Epic plan: architecture, migration hard cutover, full acceptance corpus |
| `docs/tui-interaction-contract.md` | Keys, queue/steer/interrupt, palette chord (sibling constitution) |
| `docs/tui-ink-freeze.md` | What may still patch on Ink before cutover |
| `docs/tui-migration-cutover.md` | Branch hard cutover, platforms, merge bar |
| `docs/PRODUCT.md` | Product UX claims (update when cutover ships; do not treat mid-run Enter semantics there as target) |
| `docs/ARCHITECTURE.md` | System architecture; TUI runner ownership today |

### Ink paths (reference only — do not grow)

- `src/tui/chrome-zones.ts` — fixed zone row budgets today
- `src/tui/chrome-geometry.ts` — variable chrome row math today
- `src/tui/hooks/use-layout-geometry.ts` — transcript/overlay resolver today
- `src/tui/components/modal-stack.tsx`, `src/tui/components/overlay-stack.tsx` — dual stacks today

---

## 8. Proposed defaults still open for paint proof

These are **proposed** in this constitution so Platform can implement without waiting. Spike/harness may tighten numbers; they may not violate locked floors.

| Item | Proposed default | Rationale |
|---|---|---|
| Transcript idle floor (24-row) | **12** | Locked by plan/brief |
| Transcript inset-overlay floor (24-row) | **8** | Keeps log glanceable under permission/operator |
| Prompt height cap | **40% of terminal rows** | Matches current prompt-layout intent; internal scroll |
| Overlay host max (inset) | **≤ 70% of terminal rows** | Leaves room for the prompt stack |
| Goal / task / agents collapsed | **0–1 row each** | Plan budget; dense → modal |
| Task temporary expand cap | **5 content rows then modal** | Prevents checklist starvation of log |
| Settings notice chrome cap | **≤ 3 rows** | Diagnostics dump belongs in settings |
| Tiny terminal (< 24 rows) min transcript | **≥ 6** with optional strips forced off | Degraded but usable |
| Collapse priority | §3.3 order | Makes “chrome priority when scarce” implementable |

Numeric long-log working-set size is **not** set here; it belongs with long-log platform work.

---

## 9. Change control

- Locked floors and kill list change only with an explicit product/plan update, not drive-by PR edits.
- Proposed numbers may be refined when the geometry harness proves paint heights.
- New permanent chrome zones require a registry row, a collapse rule, and an idle 80×24 budget proof before merge.
