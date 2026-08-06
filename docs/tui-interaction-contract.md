# TUI interaction contract

**Status:** constitution (locked product bindings + implementable focus/scroll design)  
**Source plan:** `docs/plans/tui-layout-scroll-platform.md` §5, §12  
**Product brief:** `briefs/tui-rebuild-opentui.md`  
**Siblings:** `docs/tui-layout-constitution.md`, `docs/tui-cutover-readiness.md`

This document is the interaction constitution for the OpenTUI shell. It locks mid-run send semantics, discovery chords, focus ownership, and scroll lease rules so implementers do not re-open product decisions or invent focus/scroll races.

The cutover has landed and OpenTUI is the shipping renderer, but not every binding below is implemented — `docs/tui-cutover-readiness.md` records which ones are missing (Shift+Tab, sent-history recall, typed slash commands) and where runtime behavior deviates (quit is Ctrl+D, not Ctrl+C).

---

## 1. Purpose

Operators abandon tools that fight them mid-stream. Corbits today inverts market-leader muscle memory (Enter interrupts; Alt+Enter queues) and splits discovery across slash, help, and tribal knowledge. Multiple scroll hooks and boolean focus flags race keys and wheel.

This contract fixes the **operator-facing** half of that failure class:

1. Mid-run send is **queue-default**; interrupt is loud and rare.
2. One discovery chord owns the command palette.
3. Exactly one focus owner and one scroll lease at a time; Esc always pops something real.

Geometry budgets and long-log window sizes live in sibling constitution docs. This file owns **keys, queue/steer/interrupt, focus tree, and scroll lease**.

---

## 2. Locked binding table

Do not reopen these product decisions. They match the plan’s locked table.

| Intent | Binding | Notes |
|---|---|---|
| Queue message mid-run | **Enter** (agent busy, non-empty submit) | Badge count on prompt; does **not** stop the agent |
| Steer ASAP | **Alt+Enter** | Deliver at next **tool boundary** |
| Interrupt now | **Ctrl+C** | Hard stop current run; must not be plain Enter |
| Command palette | **Ctrl+O** | Reclaim from today’s tool-expand chord |
| Help / keymap | Palette entry + `/help` | Tables must match handlers |
| Copy path | **Alt+C** (existing direction) | Message / tool / diff; not mouse-drag |
| Esc | Pop focus stack | Overlay → prior focus; never silent no-op |
| Wheel | Active scroll lease only | Transcript wheel off when modal owns lease |
| Newline in prompt | **Shift+Enter** (Alt+Enter when idle if terminal maps it) | Mid-run Alt+Enter is steer, not newline |

**No legacy toggle** for “Enter interrupts” in v1. Educate once via hint line + release note.

---

## 3. Queue, steer, interrupt

### 3.1 Definitions

| Term | Meaning |
|---|---|
| **Idle** | No in-flight parent inference/tool work and no running child agent work that blocks drain |
| **Busy** | Parent run active and/or child work that holds the drain gate |
| **Queue** | Operator message accepted while busy; stored for later delivery; agent continues |
| **Steer** | Operator message accepted while busy; marked priority for ASAP delivery at the next tool boundary |
| **Interrupt** | Abort the current run immediately; discard pending deliveries; do not auto-replay the stopped turn |
| **Tool boundary** | ASAP safe injection point: after a tool result lands (`tool.done` / equivalent), before the next inference that would otherwise continue the prior plan; also when the run reaches true idle if no earlier boundary fired |

### 3.2 Enter — queue (default mid-run send)

When the agent is **busy** and the prompt has a submittable payload:

1. Enter enqueues the message (FIFO among queue-class items).
2. Prompt clears; badge increments.
3. The running agent is **not** stopped, aborted, or re-prompted.
4. Delivery waits for a **tool boundary** (or idle if the run ends without tools).

When **idle**, Enter is normal send (immediate delivery), same as today for an idle prompt.

Empty Enter is a no-op (no phantom queue entry). Slash commands still dispatch immediately when the field starts with `/` (busy or idle); they are not queued as chat.

### 3.3 Alt+Enter — steer

When the agent is **busy** and the prompt has a submittable payload:

1. Alt+Enter accepts a **steer** item (priority class).
2. Prompt clears; badge increments (same badge pool as queue unless UI later splits counts).
3. The agent is **not** hard-stopped.
4. At the next **tool boundary**, steer items drain **before** any plain queue items.

When **idle**, Alt+Enter is not a second send path: treat as newline if the terminal delivers meta+return that way, otherwise no-op for empty fields. Steer only exists while busy.

### 3.4 Ctrl+C — interrupt

While a run is active (parent busy, including entered-subagent observe of a running parent/child session as implemented by the shell):

1. Ctrl+C **interrupts** the current run (hard stop / `requestStop` class).
2. All pending queue **and** steer items are **discarded**.
3. In-flight tools settle to a terminal stopped state; no silent no-op.
4. Hint line and keymap must name this as stop/interrupt, not “exit”.

When **idle**:

- Non-empty prompt: clear the prompt (or existing clear-input path).
- Empty prompt: existing exit-with-confirm path (app quit is not interrupt).

Interrupt must never be bound to plain Enter.

### 3.5 Queue vs steer priority (locked micro-semantics)

When both classes are pending at a tool boundary:

1. Drain **all steer items first**, oldest-first (FIFO within steer).
2. Then drain **queue items**, oldest-first (FIFO within queue).
3. Drain **one message per boundary** into a new turn (same “one outbound send at a time” rule as today’s drain), unless an implementer proves multi-inject is safe under the reactor — default is **one per boundary**.
4. After that send starts, further pending items wait for the next boundary or idle.

Rationale: steer is “ASAP course correction”; queue is “when you get a chance.” Mixing them in a single FIFO would bury steers behind earlier casual queues.

### 3.6 Drain policy

| Event | Drain action |
|---|---|
| Tool boundary while busy | Prefer steer head, else queue head; one item |
| Run becomes idle (no child work holding gate) | Drain remaining steers then queues, one at a time as each send completes |
| Interrupt (Ctrl+C) | Clear both classes; badge → 0 |
| New session / clear session | Clear both classes |
| Permission / operator modal open | **Do not** inject mid-modal; boundary waits until the run can accept a user message again |

Drain is **tool-boundary**, not “only full idle.” Waiting only for `connector.reply` / full turn idle is the **current** behavior and is insufficient for the target.

### 3.7 Badge and clear minimum

**Badge**

- Show a single count of pending deliveries: `steer_count + queue_count`.
- When count > 0, prompt chrome includes the count (e.g. `3 queued`).
- Optional later: split `1 steer · 2 queued`; not required for v1.

**Clear (minimum)**

| Action | Behavior |
|---|---|
| Clear last | Drop the most recently accepted pending item (steer or queue, by enqueue time) |
| Clear all | Drop every pending item; badge → 0 |
| Interrupt | Implies clear all |

Discovery: palette entries “Clear last queued” / “Clear all queued” are required for v1 discoverability. A prompt-local chord may be added later; do not steal Esc (Esc is focus-stack only).

Editing an in-place queued item (reorder, rewrite) is **deferred**; clear last + retype is enough for v1.

### 3.8 Hint line truth

While busy, the action/hint line **must** name all three intents in operator language, for example:

`Enter queue · Alt+Enter steer · Ctrl+C stop`

When pending count > 0, prefix the count. Empty-field busy state still shows the chords (discoverability without typing). Help overlay, keymap table, and palette descriptions must match these bindings — one source of truth table feeds all three surfaces.

---

## 4. Command palette (Ctrl+O)

| Rule | Detail |
|---|---|
| Chord | **Ctrl+O** opens the command palette |
| Scope | Searchable actions: slash twins, panels, model/settings/permissions entry, queue clear, help |
| Reclaim | Tool-output expand **must not** keep Ctrl+O. Expand moves to a dedicated non-palette chord later (candidate: keep tool-row local expand / dedicated binding — **not** Ctrl+O). OpenTUI shell (`src/tui-opentui`) implements Ctrl+O → palette as of Wave 6. Residual surfaces (settings/help/plugins/resume/mentions) and observe are palette actions as of Wave 7. |
| Esc | Closes palette and restores prior focus (normally prompt; if palette stacked over a primary overlay, Esc restores that overlay first). Esc while observing a subagent leaves observe and restores the parent stream + lease. |
| Slash | Remains a power path; every user-facing slash entry has a palette twin |
| Stack | Palette may open above an existing primary overlay (permissions / operator / model). Esc pops one frame at a time. |

Palette open takes the **palette** focus target (overlay priority slot) and the scroll lease for its own list.

---

## 5. Focus tree

### 5.1 Priority (high → low)

```
                    ┌─────────────────────┐
                    │   Overlay host      │  palette, permission, help,
                    │   (modal / manager) │  settings, operator question, …
                    └──────────┬──────────┘
                               │ Esc pops
                    ┌──────────▼──────────┐
                    │ Entered subagent    │  observe child session
                    │ observe view        │
                    └──────────┬──────────┘
                               │ Esc leaves observe
                    ┌──────────▼──────────┐
                    │ Shell               │  prompt + transcript (+ thin strips)
                    │ default focus:      │  prompt owns typing;
                    │   prompt            │  transcript owns scroll when leased
                    └─────────────────────┘
```

### 5.2 Rules

1. **Exactly one focus owner** receives non-reserved keys at a time.
2. **Overlay host** always wins over subagent observe and shell.
3. **Entered subagent** wins over shell; parent prompt does not steal typing while observing.
4. **Shell default** is the prompt field. Transcript is not a separate “mode” for typing; it holds the scroll lease when no overlay/subagent list owns it.
5. **Esc** pops exactly one level:
   - Overlay → previous focus (usually prompt; if observe was under an overlay, restore observe).
   - Observe → parent shell (prompt focused).
   - Shell with open thin panel (tasks/hooks strip expanded) → collapse panel, stay on prompt.
   - Shell with empty stack → existing clear-prompt / no-op policy (never a silent dead key when something is dismissible).
6. Opening B while A is open either **replaces** A or **stacks** A under B; either way Esc returns along a single path to the prompt. No orphan focus.
7. Closing any overlay **restores** the focus node recorded on open (not a hardcoded “always prompt” if observe was active underneath — restore the recorded prior).

### 5.3 Focus vs global chords

These chords are handled at the shell/keymap layer even when the prompt is not the text owner, unless an overlay fully captures input for its own confirm flow:

| Chord | When overlay open | When observe open | When shell |
|---|---|---|---|
| Esc | Pop overlay | Leave observe | Pop panel / clear policy |
| Ctrl+C | Overlay-local cancel if any; else interrupt/exit policy | Interrupt if running; else exit policy | Interrupt if running; else clear/exit |
| Ctrl+O | Close or replace with palette (single stack) | Open palette above observe | Open palette |
| Wheel / PgUp / PgDn | Active lease only | Child transcript lease | Shell transcript lease |

---

## 6. Scroll lease

### 6.1 One owner

At any moment exactly one surface holds the **scroll lease**. Keyboard page/line scroll **and** mouse wheel both follow that lease. There is no parallel “wheel on transcript while keys scroll a modal.”

### 6.2 Lease assignment (high → low)

| Priority | Surface | When |
|---|---|---|
| 1 | Overlay list / body | Overlay host focused (permissions, palette, settings, help, …) |
| 2 | Entered subagent transcript | Observe view active, no overlay |
| 3 | Prompt internal window | Prompt multi-line content overflows **and** caret navigation needs in-prompt scroll; short-lived, returns to transcript when not needed |
| 4 | Main transcript | Default shell lease |

Agents strip horizontal navigation is not a vertical scroll lease.

### 6.3 Rules

1. **Grant:** focus enter on a scrollable surface grants the lease; previous owner releases.
2. **Release:** focus leave restores the prior lease from the focus stack.
3. **Wheel:** ignored by non-lease surfaces (no dual-scroll).
4. **Follow vs pin (transcript):** auto-follow while at bottom; operator scroll-up pins; show a clear “follow live” / jump-to-bottom affordance; reattach restores follow.
5. **Modal open:** transcript does not consume wheel or page keys; list kit owns them.
6. **Subagent observe:** child transcript has its own offset; Esc restores parent lease and parent offset (parent must not jump to bottom solely because observe closed unless parent was already following).

### 6.4 Implementer checklist

- [ ] Single lease token in shell state (not N independent hooks fighting `useInput`).
- [ ] List viewport kit used by palette, permissions, agents, settings (shared windowing + keep-active-visible).
- [ ] Mouse scroll gated on lease id.
- [ ] Tests: modal open → wheel does not move transcript; Esc → transcript lease restored; observe Esc → parent offset stable.

---

## 7. Historical: Ink vs this contract

The Ink shell has been deleted. This table is kept only to explain why the current
bindings differ from muscle memory built on the old shell.

| Concern | Old (Ink) | Target (this contract) |
|---|---|---|
| Enter while busy | Interrupt + send (`steerOnEnter` path) | **Queue** (no stop) |
| Alt+Enter while busy | Queue follow-up | **Steer** at tool boundary |
| Interrupt chord | Enter (busy) / Ctrl+C also stops | **Ctrl+C** only for hard stop |
| Queue drain | Idle / `connector.reply` when not processing | **Tool boundary** ASAP |
| Ctrl+O | Expand tool output (visible area) | **Command palette** |
| Ctrl+C idle | Clear input or exit confirm | Unchanged family (clear / exit confirm) |
| Focus | Boolean soup + per-modal `useInput` | Focus tree + restore stack |
| Scroll | N owners (`use-scroll`, windows, modal slices) | One lease |
| Hint line | “Enter steer · Alt+Enter queue” | “Enter queue · Alt+Enter steer · Ctrl+C stop” |
| Keymap help | Ctrl+O = expand tool; Ctrl+C = exit | Must match target table |

Breaking change is intentional. No compatibility toggle in v1.

---

## 8. Acceptance scenarios

These are the operator-visible checks for this contract (subset of the plan acceptance corpus).

### A. Queue mid-run

1. Start a long-running agent turn with tools.
2. Type a follow-up; press **Enter**.
3. Expect: badge ≥ 1; agent continues; no abort.
4. At next tool boundary (or idle), queued message delivers as a new user turn.

### B. Steer mid-run

1. While busy, type a correction; press **Alt+Enter**.
2. Expect: badge increments; agent not hard-stopped.
3. At next tool boundary, steer delivers **before** any earlier plain-queue items still pending.

### C. Queue vs steer priority

1. While busy: Enter message A (queue), then Alt+Enter message B (steer).
2. At the next boundary: B delivers first; A remains pending (or delivers on a later boundary after B’s turn starts).

### D. Interrupt

1. While busy (with or without pending items), press **Ctrl+C**.
2. Expect: run stops; badge → 0; pending discarded; no silent no-op.
3. Plain Enter never interrupts.

### E. Palette

1. **Ctrl+O** opens palette.
2. Find permissions (or model); open it; **Esc** returns focus to prompt (or prior focus).
3. Ctrl+O does not expand tool output.

### F. Focus + scroll lease

1. Open a tall permission/options list; wheel/page only moves the list.
2. Esc closes; transcript lease restored; prompt accepts typing.
3. Enter subagent observe; scroll child log; Esc → parent; parent lease restored.

### G. Hint / help truth

1. While busy, hint line names queue, steer, and stop with the locked chords.
2. Help/keymap/palette copy matches the locked table.

---

## 9. Non-goals (this contract)

- Keymap settings editor / user remap UI (discoverable fixed map first).
- Amp-style selective reorder of queue items beyond clear last / clear all.
- Multi-message inject at a single boundary.
- Mouse click-to-focus everywhere.

---

## 10. Related docs

| Doc | Owns |
|---|---|
| `docs/plans/tui-layout-scroll-platform.md` | Plan + locked decisions source |
| `briefs/tui-rebuild-opentui.md` | Product intent and acceptance narrative |
| `docs/tui-layout-constitution.md` | Chrome budget, geometry ownership |
| `docs/tui-cutover-readiness.md` | Post-cutover state: which bindings are implemented, which are not |

When implementation lands, the keymap truth table, hint line, and palette labels must be generated from or checked against **this** binding table so help cannot drift again.
