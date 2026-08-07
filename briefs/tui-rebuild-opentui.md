# Product brief: Corbits Code TUI rebuild (OpenTUI foundation)

**Status:** Ready for planning  
**Audience for this doc:** whoever plans and builds the TUI rebuild  
**Not this brief:** framework APIs, package versions, migration mechanics (engineer's call once product is locked)

---

## One-liner

A full-screen coding-agent TUI that feels calm and predictable for a 30-minute feature session — one layout system, one discovery surface, queue-first steering, zero “why did the screen jump?” moments.

---

## Audience

**Who:** Solo developers and small teams who already use Corbits (or a peer agent CLI) to implement a discrete feature in a real repo. They live in the terminal, care about cost and safety, and will abandon a tool that fights them mid-stream.

**What they do today instead:**

- Stay in Claude Code / Gemini CLI / Amp / OpenCode despite wanting Corbits' director, permissions, and multi-agent model — because the TUI feels random.
- Or stay in Corbits and work around scroll bugs, mistyped interrupt vs queue, and “where is that shortcut?” by re-reading `/help` and still guessing wrong.

**Rough scale that matters for v1:** the people already on Corbits + the next 50–200 serious CLI-agent users evaluating switches. Not “everyone who codes.” Not IDE-first users. Not remote-control power users yet.

**What “good” means for them:** after half an hour they trust the chrome. They steered without panic. They approved what needed approving. They can scroll the log and copy something useful. They would start another session tomorrow without a workaround ritual.

---

## The hook

**Stop the random.** Today every surface reimplements layout; scroll/overflow/focus fight each other; mid-run Enter vs Alt+Enter is the opposite of the market leader people already internalized from Amp; discovery is split across slash, help overlay, and tribal knowledge.

Rebuild on **one layout foundation (OpenTUI)** so:

1. The transcript is the stable center; chrome is a fixed budget, not a free-for-all.
2. **Sending while the agent runs queues by default**; interrupt is deliberate and labeled.
3. **One command palette** is how you find everything (slash remains a power path, not the only path).
4. Keybindings are listed, consistent, and settings-overridable later — not re-bound per modal by accident.

If those four land, the product stops feeling broken. Everything else is polish or adjacency.

---

## Definition of success (observable)

After launch of this rebuild wave, a human (not a unit test) can verify:

1. **Calm session** — In a 30-minute “implement X” session with streaming + tool calls + at least one permission prompt, the transcript does not jump, clip, or leave dead empty regions when content grows or a modal opens/closes.
2. **Steering without panic** — Operator can type mid-run, hit Enter, and see the message **queued** (badge/count visible). Interrupt requires a distinct action they can name after one look at the hint line.
3. **Discovery without docs** — From a cold start, operator opens the command palette, finds “permissions” and “model,” runs both, and returns to the prompt without memorizing slash names.
4. **Chrome budget held** — On an 80×24 terminal, the event log always has a usable scroll region while idle and while active; optional panels (tasks, agents, hooks) never permanently steal the log without an obvious way back.
5. **No “mystery key”** — Ctrl+O (or the chosen palette chord) does one job. Expand-tool is not on the same chord. Help and palette do not contradict each other.
6. **Copy path exists** — Operator can get a past assistant reply or tool output onto the system clipboard without mouse-drag terminal selection (which we know is flaky across terminals). Does not need perfect multi-select yet.

**Money / retention proxy (product, not finance):** existing Corbits users stop filing “TUI is broken / scroll is wrong / I interrupted by accident” as the top session-killers within one release cycle of the rebuild landing. If those tickets still dominate, the rebuild failed even if OpenTUI is “in.”

---

## Good 30-minute session (felt experience)

Operator opens `corbits "Add X to the API"` in a real repo.

1. **0–1 min** — Screen paints once. Header says who is running (model/profile). Prompt is ready. No layout thrash on first stream token.
2. **1–10 min** — Agent streams; tool rows appear; log auto-follows unless operator scrolled up (then a clear “follow live” affordance). Cost or status is glanceable, not screaming.
3. **Mid-run** — Operator types “also add a test.” Enter → message sits in queue with a count. Agent finishes current step/turn and picks it up. If they meant “stop now,” they use the interrupt chord (documented on the hint line) and the run stops without ambiguity.
4. **Permission** — Modal overlays cleanly; log does not reflow into gibberish; Allow Once / Always works; focus returns to prompt.
5. **Orchestrator path (if on)** — Agents strip shows children; Enter-observe is intentional; Esc leaves. Parent log still makes sense.
6. **End** — They scroll back, copy a diff or answer, `/clear` or quit without residual alt-screen garbage.

If any of those steps feel like fighting the terminal, v1 is not done.

---

## Amp: steal / adapt / ignore

| Amp idea | Verdict | Why |
|---|---|---|
| Own TUI foundation for no flicker, smooth stream scroll, mouse, overlays | **Steal (via OpenTUI, not a from-scratch framework)** | Root cause of Corbits pain is fragmented layout. OpenTUI is the chosen foundation; goal is Amp-class *behavior*, not Amp's private renderer. |
| Command palette (Ctrl+O) as primary discovery | **Steal** | Slash-only discovery fails cold users. Palette is how people find mode, permissions, IDE connect in Amp. Corbits today burns Ctrl+O on tool expand — wrong priority. |
| Queue-by-default while agent runs; interrupt is special | **Steal** | Corbits today: Enter interrupts, Alt+Enter queues — inverted vs Amp and vs operator expectation once they've used Amp. Inversion is a retention tax. |
| Steer (deliver at next tool boundary) vs hard interrupt | **Steal (locked)** | **Enter** = queue · **Alt+Enter** = steer at tool boundary · **Ctrl+C** = interrupt. Queue drain is tool-boundary, not only full idle. |

| One polished visual system, not many themes | **Steal** | One default theme, restrained accents. Theme marketplace is vanity until chrome is stable. |
| Keybindings discoverable; customize via settings | **Adapt** | v1: discoverable + consistent + documented in palette/help. Settings remap is **later** unless it falls out of the keymap table for free. |
| Plugin UI primitives: notify / confirm / input / select (TUI+web) | **Adapt (TUI only in v1)** | Corbits plugins already exist. v1 needs a small, stable TUI dialog kit so plugins and core modals share one stack. Web mirror of those primitives is later. |
| Remote control / multi-thread / web mirror | **Ignore for this project** | Product adjacency. Does not fix “TUI feels broken.” Note in plan as non-goals so nobody sneaks them in. |
| Thread sharing, multiplayer, orbs, schedules | **Ignore** | Amp product surface, not Corbits' job this wave. |
| Amp agent modes low/medium/high/ultra | **Ignore as UI chrome** | Corbits already has model/profile/effort surfaces. Do not clone Amp's mode marketing. |
| Mouse support | **Adapt lightly** | Wheel scroll on the log is must-ship if OpenTUI makes it cheap. Click-to-focus everywhere is later. |
| Selection/copy still hard in Amp (community scar) | **Learn — ship a deliberate copy path** | Do not claim mouse selection is solved. Ship message/tool pick-to-clipboard (Corbits already has Alt+C direction — keep and make reliable). |
| Lag on huge threads (Amp scar) | **Learn — budget for long logs** | v1 must define a max comfortable log strategy (windowed render / virtualize / collapse old tools). “Render every historical line forever” is out. |
| Ink (Claude/Gemini) stay path | **Ignore as destination** | Peers on Ink are reference for UX patterns only; decision is OpenTUI. |
| pi-tui differential renderer | **Ignore as destination** | Interesting peer; not our stack. Steal ideas about differential paint only if OpenTUI already exposes them. |

---

## Chrome budget (plain language)

Think of the terminal as rent. The **event log pays the rent**. Everything else is a tenant with a lease limit.

### Fixed tenants (always on, small)

- **Header** — who/what session (profile, workflow chip if any). ~2 rows.
- **Prompt stack** — model/action bar + bordered input + status. ~5–6 rows total when idle.
- **Optional progress line** — only while the agent is active or a workflow chip needs it. Collapses when idle.

Hard rule: on **24 rows**, the log still gets **at least ~12 rows** idle. On **80 cols**, no chrome wraps into a second unexpected block that steals log height without a single source of truth.

### Optional tenants (toggle, never stack forever)

- Tasks panel, hooks panel, agents strip expand, goal view, full-screen managers (`/model`, settings, permissions).
- **One primary overlay at a time** for blocking work (permission, operator question, full-screen picker). Non-blocking toasts/banners are thin and timed or dismissible.
- Opening B while A is open either replaces A or stacks with a single Esc path that always returns to the prompt. No orphan focus.

### Layout principles

1. **One geometry owner** — zones and row budgets live in one place; components consume budgets; they do not invent height.
2. **Transcript is the scroll root** — only one vertical scroll surface owns mouse wheel + page keys unless a modal explicitly captures them.
3. **Follow vs pinned** — auto-follow when at bottom; leave follow when operator scrolls up; show how to reattach.
4. **Streaming must not thrash** — appends paint smoothly; no full-redraw flicker; no jump-to-top on each token.
5. **Modals measure the remaining box** — they never assume full terminal height without subtracting chrome.
6. **Long content collapses by default** — tool output and huge assistant blobs start collapsed or windowed; expand is explicit (and not on the palette chord).

---

## Interaction principles (plain language)

1. **Queue is the default mid-run send.** Enter while running enqueues. Badge shows count. Operator can cancel/edit queued items (minimum: clear last / clear all). Delivery is at **tool boundary**.
2. **Steer is ASAP.** Alt+Enter injects at the next tool boundary (Amp-like).
3. **Interrupt is loud and rare.** **Ctrl+C** hard-stops the current run (does not quit the app without confirm if that already exists). Hint line always shows: *queue* / *steer* / *stop*.
3. **Palette is how you discover.** One chord opens a searchable list of commands, panels, and settings entry points. Slash commands remain for muscle memory and scripting muscle; every slash entry has a palette twin.
4. **One meaning per chord.** No dual-use Ctrl+O. Expand-tool moves. Help does not invent shortcuts the keymap does not honor.
5. **Focus is a stack.** Prompt → overlay → nested picker → back. Esc always means “pop one level” until prompt. Double-Esc clear-prompt only when already at prompt (document that).
6. **Permissions stay sacred.** Rebuild does not soften the gate. Faster chrome, same safety story.
7. **Orchestrator is optional chrome.** Single-agent sessions do not pay agents-strip tax. Orchestrator shows strip without stealing the log permanently.
8. **Copy is a product feature, not terminal luck.** Keyboard path to clipboard for messages and tool output.
9. **Performance is UX.** A 2-hour session with hundreds of tool rows must still scroll. If it lags, collapse/window — do not “fix later.”
10. **No theme zoo.** One visual system. Accessibility contrast over fashion.

### Mid-run semantics change (explicit product call)

| Today (Corbits) | Target |
|---|---|
| Enter = interrupt + send | Enter = **queue** (tool-boundary delivery) |
| Alt+Enter = queue | Alt+Enter = **steer** (ASAP tool boundary) |
| (no clear interrupt) | Ctrl+C = **interrupt** |
| Hint line documents both | Hint line + palette: queue / steer / interrupt |

This is a breaking muscle-memory change for existing Corbits users. Ship it with a one-time banner or `/help` callout in the release notes — still worth it; Amp already trained the market.

---

## In scope for v1 (must-ship)

Smallest set that proves the hook:

1. **OpenTUI foundation** for the main session shell: header, event log, prompt, status, modal host.
2. **Single layout/geometry system** (chrome budget enforced; one scroll root).
3. **Smooth streaming + follow/pin scroll behavior** under load (tools + tokens).
4. **Queue-by-default mid-run send** + visible queue badge + clear/cancel queue (Enter).
5. **Steer** via Alt+Enter at tool boundary + **Ctrl+C interrupt**, both on hint line and in palette.
6. **Command palette** as primary discovery (commands, panels, model/settings entry).
7. **Existing critical modals on the shared overlay host:** permission, operator ask, model/settings (or thin wrappers), exit confirm.
8. **Reliable copy path** for message / tool output (keyboard).
9. **Long-log strategy** so huge threads do not melt the TUI (windowing or collapse policy — pick one in the plan, ship it).
10. **Keymap table is truth** — help, palette, and actual handlers match; Ctrl+O is palette not expand-tool.
11. **Mouse wheel scroll** on the log (if OpenTUI supports it cleanly).
12. **Parity for session mode, auto mode toggle, agents strip observe/leave** — behavior preserved, chrome cleaned.

### Explicitly out of scope (later / adjacency)

- Remote control from web
- Web UI mirror of plugin dialogs
- Multiplayer / thread sharing
- Full keymap customization UI (unless free)
- Theme marketplace / multiple official themes
- Perfect terminal mouse text selection
- Amp-style queue item reorder + selective steer (unless default queue is insufficient)
- Rebuild of exec/non-TUI path (leave stable; only share types/events if needed)
- IDE extensions
- Rewriting the director, permissions policy, or agent loop “while we're here”
- New product surfaces (schedules, orbs-equivalents, etc.)

If a planning doc starts estimating remote control, stop and re-read this section.

---

## Constraints

- **Foundation decision:** OpenTUI (OpenCode's stack). Do not reopen Ink vs OpenTUI in the plan unless OpenTUI is proven unblockable — then escalate as a risk, not a casual pivot.
- **Product identity stays Corbits:** deterministic director, permission gate, goals/tasks, orchestrator vs single — UI serves those; it does not become “Amp skin.”
- **Breaking interaction change is allowed** for queue-default; document it.
- **Terminal reality:** 80×24 minimum; 120×40 common; tmux users exist (Shift+Enter newline may not work — keep a newline chord).
- **No code in this brief; no Linear expansion from this brief alone** — planning agent turns this into work.

---

## Open risks and unresolved decisions

| Risk / decision | Status (2026-08-05) |
|---|---|
| Exact interrupt chord | **LOCKED:** Ctrl+C = interrupt · Enter = queue · Alt+Enter = steer |
| Queue drain boundary | **LOCKED:** tool boundary (not only full idle) |
| Palette chord | **LOCKED:** Ctrl+O = palette; move expand-tool |
| Long-log policy | **LOCKED ideal:** viewport working set; scroll up collapses off-bottom / shows into-top; numeric N in CL-5399 |
| OpenTUI maturity / gaps | Spike decides go/no-go (CL-5365); binding ADR (CL-5366) |
| Existing user muscle memory | **LOCKED:** no legacy Enter-interrupts toggle; educate once |
| Platform support | **LOCKED:** macOS #1, Linux #2, Windows non-blocking |
| Cutover | **LOCKED:** branch hard cutover; no dual-release; scrap branch if epic fails |
| Plugin dialog kit depth | Cap at four primitives for v1 (notify/confirm/input/select) — still fine |
| Agents strip + goal/tasks density | Chrome budget in plan §5; constitution finishes numbers |

---

## Acceptance checks (human, no code reading)

Run on a real repo, real model, 80×24 and a larger terminal.

### A. Layout calm

- [ ] Start session; stream 500+ tokens; log follows bottom; no flicker/tear.
- [ ] Scroll up mid-stream; view stays pinned; a clear control resumes follow.
- [ ] Open permission modal; dismiss; log height and content position remain sane.
- [ ] Toggle tasks panel open/closed; log remains usable; Esc returns focus to prompt.

### B. Queue / steer / interrupt

- [ ] While agent runs, type a message and press Enter → queued (count ≥ 1), agent does **not** stop.
- [ ] Queued message delivers at next **tool boundary** without re-typing.
- [ ] Alt+Enter steers ASAP at tool boundary.
- [ ] Ctrl+C interrupts the run; agent stops; no silent no-op.
- [ ] Hint line names queue, steer, and stop.
- [ ] Interrupt chord stops the run; partial work does not leave the UI wedged.
- [ ] Hint line names both actions in plain words.

### C. Discovery

- [ ] Cold user opens palette, types “perm”, opens permissions manager, Esc to prompt.
- [ ] Palette lists model/settings and at least the built-in slash commands.
- [ ] `/help` (or help command) does not advertise chords the app ignores.

### D. Copy and length

- [ ] Copy an assistant message to clipboard via keyboard path; paste elsewhere succeeds.
- [ ] Session with many tool calls still scrolls; expand/collapse tool output works; palette chord is not required for expand.

### E. Orchestrator (if enabled)

- [ ] Child agents appear on strip; observe session; Esc returns to parent; parent log still coherent.

### F. Regression sacredness

- [ ] Permission gate still blocks a consequential action in ask mode.
- [ ] SHIFT+TAB still toggles auto mode with a visible cue.
- [ ] Quit path still confirms; no stuck alt-screen on exit.

All boxes checked ⇒ rebuild wave is shippable. Any open box ⇒ not done, regardless of “migrated to OpenTUI.”

---

## What the plan document must force us to answer

**Suggested plan title:** `TUI rebuild: OpenTUI shell, queue-first steering, command palette`

**Sections the plan is not allowed to skip:**

1. **Product non-goals** — Copy the out-of-scope list; add any new temptations and kill them.
2. **Interaction contract** — Final table: Enter / newline / queue / interrupt / Esc / palette chord. No “TBD” after spike.
3. **Chrome budget table** — Row rents per zone at 24 and 40 rows; which panels are mutually exclusive.
4. **Scroll & streaming model** — Follow/pin rules; who owns the wheel; what happens on modal open.
5. **Long-log strategy** — Chosen algorithm + failure mode when history is huge.
6. **Palette IA** — Command inventory (built-ins + how plugins register); search behavior; relationship to slash.
7. **Overlay host** — Stack rules; which flows are full-screen vs modal vs toast.
8. **Migration slices** — Vertical slices that each leave a runnable TUI (not a big-bang dark launch). First slice must prove scroll+stream calm.
9. **Spike results** — OpenTUI: streaming, mouse, overlays, performance, packaging. Go/no-go criteria.
10. **Breaking-change comms** — Queue-default Enter; keymap moves; release note copy.
11. **Acceptance** — Paste the human checklist; map each item to an owner and a manual test script.
12. **Explicit deferrals** — Remote control, web mirror, keymap editor, selective steer — with “revisit when” triggers.

A plan that only says “port components to OpenTUI” is not a plan. A plan that answers the twelve is.

---

## Glossary

| Term | Meaning in this brief |
|---|---|
| **Chrome** | Everything that is not the scrollable event log/transcript (header, prompt, status, strips, panels, modals). |
| **Chrome budget** | Fixed row/column rents so the log always has a usable region. |
| **Event log / transcript** | The main scrollable history of user, assistant, tools, and system events. |
| **Queue** | Operator messages held while the agent is running, delivered at a defined boundary without stopping current work. |
| **Interrupt** | Hard stop of the current agent run so the operator can take over immediately. |
| **Steer** | (Amp) deliver a queued message at the next opportunity before full idle; Corbits v1 may only ship queue+interrupt unless plan expands. |
| **Command palette** | Searchable overlay of actions/commands; primary discovery surface. |
| **Overlay host** | Single stack that owns modals/full-screen managers and focus return. |
| **Follow vs pin** | Auto-scroll with new output vs user-scrolled frozen viewport. |
| **OpenTUI** | Chosen TUI foundation (OpenCode stack) replacing the current Ink-centric shell. |
| **Session mode** | `single` vs `orchestrator` — product setting; UI must respect both. |
| **Agents strip** | Orchestrator UI for child sessions (observe/leave). |
| **Copy path** | First-class keyboard flow to put content on the system clipboard. |
| **Long-log strategy** | How the UI stays responsive as history grows (window/collapse/cap). |

---

## Bottom line

Ship a TUI people stop apologizing for. One geometry owner, queue-first send, palette discovery, interrupt on purpose, copy that works, logs that do not melt. OpenTUI is the foundation, not the product. Remote control and web mirrors do not pay the rent until the main stage is solid.
