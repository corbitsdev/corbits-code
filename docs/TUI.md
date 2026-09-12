# Corbits Code — TUI Behavior Spec

This is the normative behavior spec for the terminal UI: Corbits Code, built on
OpenTUI (`@opentui/core`). It describes what the shell must do, not how the
OpenTUI cutover got here. The implementation lives in `src/tui/`; the
runner that mounts it is `src/tui/runner.ts` (see `docs/ARCHITECTURE.md` for
how the TUI fits the rest of the system). A reviewer should be able to hold a
PR against this document; someone building a new overlay or picker should be
able to build it correctly from this document alone.

Internally and in code, a blocking surface is an "overlay." Never use that
word in anything the operator reads — hint lines, status flashes, help text,
titles. The operator sees "permissions," "model / provider," "command
palette," a plain question — never the word "overlay."

## How it should look

There is no titlebar, no status strip, and no key-hint row as permanent
chrome. The prompt box is the only permanent chrome in the shell: it is
anchored at the bottom in every state, and everything else — task/agents
strips, notices, banners, the overlay host — is optional and collapses to
zero rows when it has nothing to say (`src/tui/geometry/zones.ts`).
The transcript is residual: whatever rows remain after chrome and any open
overlay belong to it, never the other way around
(`src/tui/geometry/resolve.ts:resolveGeometry`).

A single **geometry resolver** turns terminal size, zone visibility, and
overlay mode into region rects; every zone reads its rect from that resolver
instead of computing its own height from `process.stdout.rows`. On an 80×24
terminal with nothing optional showing, the transcript floor is 12 rows
(`IDLE_TRANSCRIPT_FLOOR`); with an inset overlay open the floor drops to a
proposed 8 rows (`OVERLAY_TRANSCRIPT_FLOOR`) so the log stays glanceable
underneath a permission prompt. When space is scarce, collapse follows a
fixed order — transient banners first, then settings/plugin notices, then
task/agents strips, then progress, then the prompt itself shrinks one
row at a time down to its 3-row base — never the transcript
(`COLLAPSE_ORDER` in `zones.ts`).

Horizontally, every surface sits inside one shared gutter
(`resolveSideMargin`, `src/tui/geometry/margins.ts`) so the shell reads
as a single column of content rather than stacked panes.
`resolveGeometry` always returns `layoutMode: "stack"` — full-width
y-stack, no dual-column rail. Live workers paint in the agents strip
above the prompt; transcript `spawn_agent` rows remain spawn/final/fail
anchors (see Live agents chrome below).
The side gutter is one column per side at every width that can afford it,
and zero below `MARGIN_MIN_COLUMNS` (40), where every column belongs to
content. There is no middle tier: one column is already enough to keep
content off the frame edge, which is the gutter's entire job, and
anything wider only read as excess air on a wide pane. The gutter costs
no rows.

Vertically, the same file keeps content off the top and bottom edges with one
blank row each: `TOP_PAD_ROWS` above the first transcript row, and
`BOTTOM_MARGIN_ROWS` below the prompt box. Both are carved out of the
transcript residual by the shell after the geometry resolver has assigned
heights, so they never change the resolver's row budget. Each collapses to
zero when the terminal is too short to spare it (`TOP_PAD_MIN_TRANSCRIPT_ROWS`
for the top pad, `BOTTOM_MARGIN_MIN_ROWS` for the bottom).

Operator turns in the transcript are left-aligned bubbles with a solid bar
down the left edge (`userBubbleLines` in `src/tui/stream.ts`). Each bubble
keeps one empty bar row above and below its text so the operator's voice
stays easy to find while scrolling through denser assistant and tool rows —
the pad is part of the bubble itself, not an extra turn-boundary gap, and
assistant rows are unchanged; tool rows are lanes (see Tool lanes below).

Parent live reasoning paints through the existing thinking row — never a
third mid-turn stream lane. While `inference.thinking.delta` arrives,
`thinkingLivePreviewLines` (`src/tui/thinking.ts`) wraps the newest revealed
prose into a hard-capped inset paragraph (`LIVE_THINKING_MAX_LINES`, currently 10) at a bounded reveal rate (`REVEAL_CHARS_PER_SEC`). When the turn moves on
(assistant text, a tool call, or settle), the row collapses to its opening
clause with the rest behind expand. Mid-turn thinking bursts fold onto that
same one row per turn (`reasoning-fold`); `inference.text.delta` grows the
open assistant streaming row in place. Worker spawn_agent-row thinking is a
separate path and is unchanged by this preview.

## Tool lanes

Transcript tool rows group by tool, not by sentence. A call for a tool the
previous row already represents folds onto that row instead of opening a new
one (`src/tui/tool-rows.ts`); the row narrates the newest call's subject and,
while calls are in flight, carries a dim count chip (`· ×N`) after the
subject. `spawn_agent` never folds — each dispatch is its own live anchor —
and `manage_tasks` paints no transcript row at all.

When the lane settles (its last outstanding answer landed), the head rewrites
to a past-tense count over the latest subject — `Grepped ×3 · "corbits"` —
with the count taken over calls, never over payload items (a lane of three
greps says `×3` even if the payloads returned forty matches in total; nothing
here can substantiate a payload total). Each call's own answer stays behind
the expand arrow. For an edit lane the per-call `+n/-n path` addenda remain
in the expanded body, so folding never buries which file each call touched.
Single-call rows (count <= 1) render exactly as they did before lanes.

The past tense is a map keyed by raw tool name (`src/tui/tool-formatter.ts`:
`grep` → `Grepped`, `read_file` → `Read`, `write_file` → `Wrote`,
`edit_file` → `Edited`, `run_shell` → `Ran`, `list_dir` → `Listed`,
`search_files` → `Searched`, …); an unknown tool falls back to its display
name.

Because a lane's row identity moves to the newest call, a lane also carries
the call ids it absorbed (`memberIds`, newest appended). A
result resolves its lane when its call id is the row's own id **or** one of
its members — this is what pairs a resumed transcript's parallel batch
(call, call, result, result) correctly. An id matching nothing still answers
nothing: it is appended as its own row, never folded onto the newest
same-name lane.

Alt+C on a lane copies the most recent call's full output (see the Alt+C
bullet under Clipboard and mouse).

### Shell output lanes

A pending `run_shell` row shows the command head and elapsed clock as today,
plus up to three dim tail lines of the command's live output and — when the
feed window holds more than three lines — the same dim `⋯ +N lines` elision
marker as the settle preview, `N` counting lines within the live window (the
feed keeps only the most recent 8 KiB). The output
travels through a polled bounded feed (`src/session/shell-output-feed.ts`),
not a reactor event: the plugin appends chunks (capped at an 8 KiB tail per
call, emitting at most once per 100 ms plus a final flush at settle), and
the product host's sticky poll reads the feed snapshot every 200 ms and
repaints the pending row frame-coalesced. Nothing from the feed is
persisted. When the feed is not wired (tests, the demo shell), the row
renders exactly as before — silent degradation.

At settle the live tail is replaced by a preview of the full output: its
last three lines plus a dim `⋯ +N lines` elision marker when more were
produced (the marker carries the count; the "N lines" stat is not painted
on shell rows). A non-zero exit adds an `exit N` stat; a zero exit adds
none. The existing expand idiom (Alt+E / click / the row arrow) reveals the
full output, hiding the preview; the idiom and the arrow are unchanged.

The prompt box's border carries the metadata that would otherwise cost a
titlebar row: the model label sits right-aligned in the top rule as
`profile · model · effort` (empty segments omitted), and a
compact `mcp !` sits immediately left of it when any MCP server still needs
authorization (`/mcp` is the surface that names them), painted in
`UI.warning` (sand, `#d1ad7d`) — the same role `plugin !` uses. Orange is
not spent on these standing marks. The brand
lockup sits at the left of the bottom rule with the working directory and git
branch at its right (`AppShell.promptTopRule` / `promptBottomRule`,
`src/tui/shell/internals.ts`). Context occupancy rides that bottom rule as a percent:
0–60 `UI.textDim`, 61–80 `UI.warning`, 81–100 `UI.error`; an optional cost
suffix stays dim. Both rules cost zero transcript rows because they
ride the prompt box's own border.

Inside the prompt, only a leading registered `/command` (the `/name` only)
and `@mention` tokens anywhere paint `UI.action`. Bare skill or agent words
(`implement`, `emil`, `brand review`) stay unstyled, as does a `/review`
that appears mid-prose.

While a turn is live — or the session is still occupied by a live fleet
or a pending dry-fleet continuation — the lockup slot swaps the wordmark
for a semantic activity word — never the raw tool, MCP server, or plugin
identifier that is actually executing. Live occupation cycles
`LIVE_ACTIVITY_WORDS` (`working`, `warping`, `buzzing`, `grinding`,
`thinking`, `doing`, `cooking`, `creating`, `imagining`, `inventing`)
on `LIVE_WORD_MS`; gated turns still read `waiting` or `stopping`.
`ACTIVITY_STATES` exported from the session chrome module is the source
of truth for what the slot can say, not this list. It is led by a single
density cell
(`rampPulse`, `src/tui/ramp.ts`). The cell, not the word,
is what says whether the session is healthy, and it carries four states:

| State     | Cell                                        | Reads as                |
| --------- | ------------------------------------------- | ----------------------- |
| `working` | cycles `░ ▒ ▓ █` on `RAMP_CYCLE_MS`         | moving                  |
| `done`    | static `█`                                  | finished                |
| `blocked` | static `▌`                                  | waiting on the operator |
| `stalled` | `!` blinking against `█`, then a static `!` | a problem               |

Every state is separated by glyph and motion before colour, so all four survive
a monochrome terminal and are readable without stopping to read the word. A
static `working` word was the original failure: a live run and a hung one
printed identically, so the only way to tell them apart was to wait.

`blocked` and `stalled` share the orange deliberately — both name a turn
waiting on something outside itself — and are told apart by motion: `blocked`
holds perfectly still, which is the signal that the session is waiting on _you_.

While fleet agents are running, the slot stays live even when the parent
turn has settled (idle-with-fleet). `resolveTurnLabel` and
`resolveRampPhase` take a `FleetProgress` roll-up plus session occupancy:
with live lanes the parent is idle by design, so its silence says nothing
about whether the session is progressing, and blanking the lockup made a
busy fleet look hung. Occupied sessions keep cycling a live-activity
word; recovery stays silent rather than painting `stalled`. A blocked
gate and a stopping turn still outrank the fleet. With zero running fleet
agents and no pending continuation the roll-up is empty and every path
through both functions behaves exactly as it does for a plain
single-agent turn.

The stall phase is driven by the watchdog's own silence clock
(`stallLevel`, `src/tui/stall-watchdog.ts`), so the indicator and the
abort can never disagree about which runs are stuck. It arms at
`STALL_NOTICE_MS` and keeps reading as stalled straight through the abort
threshold. Its blink is a bounded burst (`STALL_BLINK_BURST_MS`) that settles
to a static `!`: an alarm that strobes for the whole stall window becomes
wallpaper, and settling also lets the render loop drop back to the slow
cadence. The burst is measured from the moment silence crossed the notice
threshold, so a resumed session with already-stale activity shows the settled
glyph immediately rather than alarming about silence the operator missed, and
a stall that breaks and re-arms bursts again.

Auto-abort (`shouldAbortForStall`) is reserved for a stream that had already
started producing tokens and then went dead mid-flight — not for a run that
is merely _awaiting_ the model's next response (right after submit, or the
instant a tool batch resolves and `awaitingResponse` flips back to true).
That wait has no signal to tell "still coming" from "never coming" apart, so
it is never auto-aborted no matter how long it runs; it still surfaces via
the notice, keeping the operator in control of whether to give up on it.
The notice is a live diagnosis, not a sticky banner: it comes down on the
same paint as the activity that ends the silence, including when the turn
settles before the next monitor tick.

An idle session's turn chrome animates nothing at all: the monitor tick
stops entirely rather than repainting an unchanging frame. Pre-session
motion belongs to the landing's mount lifetime, not the monitor (see the
idle landing below).

Color is a small, deliberate palette, not decoration
(`src/tui/theme.ts`). Dimmed text is a dimmed cream, never a neutral
gray, so every emphasis level keeps the same warm hue. Orange
(`UI.action`) is spent once per screen: it marks the session identity,
a leading `/command` or `@mention` in the prompt, and the dithered subject
of a decision surface (permission or operator ask) — nothing else competes
with it. Standing caution (`mcp !`, `plugin !`, the context
meter's 61–80 band, consequence impact under a list) uses `UI.warning`; the meter turns `UI.error` at 81–100.
Ongoing, non-decision status uses the bronze/sand/ember chrome ramp and green
(`UI.done`) for completion.
The one deliberate exception is diff removals, where orange is content (the
removed line), not a decision marker, and no decision-marker shares that row.

## The live task list panel

**Parked pending rebuild.** `formatChromeZones` (`src/tui/chrome-state.ts`)
keeps the task checklist parked (`task: null`) while the agents strip paints
live. A task is a unit of work with a status; an agent is an executor with its
own context and transcript. They are never merged into one panel. When the
checklist strip is rebuilt, each row will show a bracket status marker (`[ ]`
todo, `[~]` doing, `[x]` done, `[-]` cancelled) ahead of the title, bounded to
`TASKS_PANEL_MAX_VISIBLE` with a trailing `+N more` under overflow, and
shrinking via `COLLAPSE_ORDER` in `geometry/zones.ts`.

Two independent mechanisms keep the task panel from ever costing the prompt
box a row on a short terminal, and they guarantee different things.
`COLLAPSE_ORDER` places `task` ahead of `prompt`, so `collapseOnce`
(`geometry/resolve.ts`) always drains `task` to zero before it ever reduces
`prompt` — that loop only runs when the transcript floor is not yet met, and
it never touches a zone later in the order while an earlier one still has
rows to give up. Separately, `PROMPT_CAP_FRACTION` in `desiredHeights` caps
how tall a _requested_ prompt is allowed to start at (`PROMPT_CAP_FRACTION *
terminal.rows`), independent of collapse and before it ever runs. Neither
mechanism substitutes for the other: the cap bounds the prompt's own growth
on any terminal, tall or short; the collapse order bounds what other zones
are allowed to take from it once the transcript floor is at risk.

The panel stays **hidden by default** (CL-5847): a fresh shell does not paint
the checklist. `toggleTasksPanel` (bound to Alt+T) opts in for the shell's
lifetime — it flips a hidden flag held on the shell in memory only — so demos
and tests that call `setChromeZones` with task rows can still show them.
Because `formatChromeZones` parks task auto-paint, Alt+T does not
surface a live `manage_tasks` list; it can still show preformatted task
rows that tests or demos push via `setChromeZones`.

The `manage_tasks` tool writes state through `ChatDirectorImpl` (`src/agent/director.ts`),
which calls `onTasksChange` on every `manage_tasks` tool call and on session
hydrate. `manage_tasks` calls paint no transcript rows; with the checklist
parked, that list has no standing chrome surface until rebuild.

## Live agents chrome (strip above the prompt)

Live workers paint as a **flat agents strip** above the prompt (label /
status / current tool) — Amp/Codex-style lanes without a FLEET header board:

```
● explore  map callers  · 0:59 · grep
● general  write tests  · 1:07 · write_file
```

An `ask_director` lane stays live and reads as waiting on the director, not stalled.
The runner snapshots currently pending root-worker questions, dropping resolved,
cancelled, replaced, terminal, or removed asks before delivery. It sends one
coalesced wake when the parent is not processing and all operator gates are closed,
even while live workers hold the shell busy. Replies use `send_input`'s `target`
field with the worker's session ID, not its shared catalog ID. The runner
publishes snapshots and the bridge delivers each session/question identity
once while pending; the agents strip never re-delivers it. Synthetic wakes use
the idle delivery path, bypassing composer `/feedback` capture and leaving queued
user follow-ups untouched.

`formatChromeZones` → `formatAgentsPanel` owns that paint. Geometry stays
stack-only (`layoutMode: "stack"`, `railWidth: 0`); the zone max is
`AGENTS_PANEL_MAX_VISIBLE + 1` (lanes plus a trailing `+N more`). Finished
lanes (done / failed / cancelled / interrupted) linger for
`AGENTS_PANEL_LINGER_MS` (4s) after `finishedAt`, then drop. Product-host sticky
poll uses
`agentsChromeNeedsSticky` so clocks and linger stay fresh; while sticky is
needed it **does not** call `bridge.syncAgentProgress` — chrome owns the live
clocks.

### Transcript spawn_agent rows (history anchors)

`runtime-bridge` paints each `spawn_agent` call as a transcript stream row for
**spawn / final / fail anchors**. While the agents strip is sticky, sticky-poll
`syncAgentProgress` rewrites are gated off so the transcript is not a dual live
rail. A `spawn_agent` call never folds into a tool lane: each dispatch keeps
its own transcript row for its whole lifetime, because the row is the live
progress anchor, not just a call record. Ordinary in-flight tool rows keep
their own elapsed clock
(`syncToolElapsed`) without the current-tool suffix.

### Unprompted fleet reports

Parent prose owns success narratives. Transcript fleet notices exist only for
attention live spawn_agent rows cannot keep: a lane **failed** or **cancelled**
while other work is still running, and **one** dry-fleet line when the last
lane finishes
(`N done`; failed and cancelled counts appear only
when non-zero, e.g. `N done, M failed, K cancelled`).
The line does not claim the run is idle — the parent often continues.
The prompt-box lockup is what names that occupation, not this tally.
Per-lane `done — summary` walls and live `dispatched` re-announcements
are never printed. That dry-fleet line stays operator-facing. If tasks
are still todo/doing, the runtime re-enters the parent with collected
reports as a system continuation — it does not paint the report wall as
a user message.

`src/subagent/fleet-report.ts` is pure: it reads the same fleet-agent session
store and the same `agentProgress()` stall definition. Store changes drive it;
a `FLEET_REPORT_SETTLE_MS` (400ms) timer lets a parallel dispatch settle into
one observation. Quiet detection uses `FLEET_STALL_POLL_MS` (5s). Past
`COALESCE_ABOVE` (3) attention events in one observation, lines collapse into
a single tally. Errors clip to `OUTCOME_CHARS`/`MAX_UPDATE_CHARS` on the
"one update is one row" rule. `fleetDigest()` is the on-demand counterpart
for `/status` or an operator question mid-run.

## How pop-ups should feel

A blocking surface (permissions, an operator question, the model/provider
picker, help) occupies the shell's **single overlay host**
(`src/tui/geometry/resolve.ts`,
`src/tui/shell/overlay-host.ts:openListOverlay`). A second command surface replaces a
non-gate list on that host, or waits with a system line while a live
gate holds it. Palette may stack over a primary; Escape always walks
back along a single path to the prompt.

Accepting a `/` command or palette row keeps that host until dispatch
settles: the list closes without advertising idle, the command runs, and
the host advertises idle only when no list, deferred slot, or reservation
remains. A command surface (`/help`, `/model`) requested while a live
gate still holds the host does not steal it and does not silently no-op
— it waits until that gate closes, with a system line so the wait is
visible. A gate that was only queued (never shown) stays queued while
the command surface is up; its display timeout does not run.

An open overlay reserves a real minimum for its own border, title, and at
least one content row before anything else — including the transcript floor
— is allowed to starve it further. That minimum is `OVERLAY_MIN_ROWS = 3`
(`src/tui/geometry/zones.ts`) — two border rows plus one content row.
The geometry resolver iteratively collapses optional chrome to make room for
both the transcript floor and this overlay minimum before it ever accepts a
transcript-below-floor outcome; only when nothing is left to collapse does it
fall back to best effort (`resolveGeometry`'s collapse loop in
`geometry/resolve.ts`). Best effort re-checks the assigned overlay height
against that minimum: if the overlay is still short, it may take rows from
below the prompt floor (`PROMPT_BASE_ROWS`). An unanswerable approval
deadlocks the session; a cramped prompt does not. An overlay must never paint
past the box it was actually assigned, and its border must always close.

Escape dismisses the open overlay and, for a permission or operator prompt,
that dismissal **denies** the request rather than leaving it unresolved
(`src/tui/gate-wire.ts`: both `onPermission`'s and `onOperator`'s
`onCancel` handlers resolve the pending promise — as a deny for permissions,
as a cancel for the operator question — with an explicit comment that an
unresolved gate "hangs the run until the process is killed"). This exists
because an earlier version could abandon the awaited promise on Escape and
leave the session parked with no recovery path short of killing the process;
Escape must always settle the promise it is dismissing.

The permissions prompt's title line names `/yolo` as the way to skip further
prompts, longest first as the terminal narrows: `Esc cancel · Enter choose ·
/yolo skip prompts`, then `Esc · Enter · /yolo`, then `Esc · Enter`. Operator
questions and the model/provider picker do not advertise `/yolo`.

Once a permission or operator prompt is answered — or cancelled, timed out,
or auto-settled by a grant / abort / teardown — it leaves the screen and
does **not** replay the request, the command, or the chosen option into the
transcript. The overlay is the question; the tool row that follows is the
outcome. Grey `permission` / `operator` recap cards restated the same ask
after it was already decided. Expanding a collapsed payload while the
overlay is open still writes the full payload into the scrollable
transcript, because that text would otherwise be unreachable before
approval. That dump carries no gutter label.

The decision surfaces (permission approval, operator question) are the one
framed content in the shell, and their body is shaped rather than merely
listed (`src/tui/overlay-body.ts`): a dithered header (`░▒▓`) carries the
subject in the action color — the only Breakthrough Orange on the card. The
overlay host border and title use calm dim chrome (`UI.textDim`); consequence
impact in the description zone paints `UI.warning` (sand), not orange. A
blank row separates the subject from context. Choices are deliberately small:
each one is a bare, single-line action name (`Reject`, `Accept once`, the
scope's label) with no consequence text folded into the row. A scope's hint
paints instead as a body message above the choice list
(`permissionBodyFromRequest` in `src/tui/gate-wire.ts`), and the expand key,
which binds only when the subject carries collapsed payloads, reveals the
full body — collapsed payloads and hints alike — in the overlay
and, whole, in the transcript. Every choice reserves the same fixed two rows
(label plus a row of air) so list paging stays a simple multiple. The active
choice is marked by text color alone — cream (`UI.text`) against the dim rows
— with no leading marker, block, or background fill (`createOverlayList` in
`src/tui/shell/overlay-list.ts`).

## How selectors should work

Every list surface — permissions, the operator question, the model picker,
the `/` command list, resume/session-mode pickers, settings — shares one list
viewport kit: shared windowing, keep-active-visible, and page/jump behavior.
There is exactly one scroll lease at a time; keyboard paging and the mouse
wheel both follow whichever surface currently holds it, so a modal open on
top of the transcript never lets the wheel move the transcript underneath it.
Ask and permission rows are namespaced by the ask id minted on the gate
event at emit, before the overlay opens. Paint replaces the whole options
array (labels and ids together);
there is no drop-by-id merge. Enter binds by the painted id against the live
bag — a painted value that is not in that bag, or Enter on an empty gate
with no answer field, fail-closes the accept as unavailable rather than
remapping by index or treating it as Reject. Escape still denies a
permission and cancels an operator question through the dismiss path.

"Current" is never inferred. For the model picker, the row marked
`(current)` is read live from the session's actual active provider/model on
every picker open — independent of the recents list, which only moves on an
explicit pick and can go stale (`ProductHostConfig.activeModelId`'s doc
comment and `annotateCurrent` in `src/tui/product-host.ts`).

The `/` command list specifically (`src/tui/command-catalog.ts`,
`src/tui/shell/palette.ts:openPalette`/`repaintPalette`): width matches the prompt box — both
are painted at the geometry resolver's shared `contentWidth`
(`geometry/resolve.ts:assignRects`, `overlay-view.ts:overlayRowWidth`). There is no
leading marker column and no per-row kind column; the selected row is marked
by text color only (`paintPaletteList` in `overlay-view.ts`: "the highlighted row
already stands out by sitting under the cursor, so a leading `>` and a grey
block would both be saying the same thing twice"). Rows stay name-only
(`/help`, `/model`); the focused command's registry description paints in the
shared two-line description zone under the list (`openListOverlay({ describe })`,
`paintDescriptionZone` in `overlay-view.ts`). A missing or blank `description` still
reserves the zone (rule plus two blank lines); it does not collapse. Built-ins
have copy; this is the empty-description edge. The list also paints with no
title rule — slash-popup query lives in the prompt, so an orphan `>` filter
row under the box would be chrome that says nothing the prompt isn't already
showing (`repaintPalette`).

## Slash commands and pickers

`/` at an empty prompt opens the command list, narrowed by name prefix as
more is typed (`cmd.id` in `openSlashCommands`); Tab completes the name so
arguments can be typed, Enter runs it. Enter on a matching command keeps
the overlay host until dispatch settles, so a queued permission gate cannot
open in the gap between closing the list and opening `/help` or `/model`.
If the command list is stacked over a live permission or operator prompt,
that prompt stays; the command surface waits until it closes, and a system
line says so rather than dropping the selection. Tab, Escape, and Enter
with no matches are genuine dismisses and still release the host. The query
lives in the prompt — list chrome is in How selectors should work above.
When the prefix matches nothing, the list stays open and paints a
`(no matches)` row (CL-6699: a close-and-reopen refresh would drain a
queued gate); Enter then dismisses and leaves the prompt as typed (`/z`).
Every entry is backed by the live command registry
(`src/tui/command-catalog.ts:commandItemsFromRegistry`) — there is no
separate palette overlay and no shell-owned action outside the registry. The
overlay this reuses is still internally called `"palette"` (`src/tui/shell/internals.ts`'s
`PrimaryOverlayKind`), a naming leftover from when a Ctrl+O command palette
also opened it; that chord is gone (see keybindings.ts), and the identifier
stayed because renaming an internal overlay tag has no user-facing effect.

`?` no longer binds anything — it is a literal character everywhere, prompt
or transcript. The shortcut list it used to open is still reachable, as
`/help` (`src/tui/commands/built-in.ts`, routed to `src/tui/shell/palette.ts:openHelpOverlay`
via `openCommandSurface`'s `"help"` case, `command-surfaces.ts`); the `/` row
in `SHELL_SHORTCUTS` documents that in place of a dedicated `?` row.

`/plugins` lists every discovered plugin in a flat list. The title line carries
how-to hints (`Esc cancel · Enter toggle · Alt+A add path · Alt+X remove`,
falling back to shorter forms as the terminal narrows). Enter toggles
enablement. Alt+A adds a plugin by path. Alt+X removes a user, project, or
path plugin (owned user/project installs, including a path-origin plugin
whose directory sits under those roots, confirm before deleting from disk).
Every remove writes `enabled: false` rather than dropping `settings.plugins[id]`
so in-session command gating holds; disk and unique `pluginPaths` entries are
still removed so the plugin is gone after restart. Bundled Corbits plugins
cannot be uninstalled — Alt+X disables them instead and they stay listed.
Claude marketplace installs write `enabled: false` and never delete `~/.claude`.

The idle landing paints two doors beside the mark, keys aligned so the
descriptions share a column (`LANDING_HINTS` in `src/tui/landing.ts`): `/`
for commands, and `/yolo` so Corbits Code does not have to ask for
permissions. An 80-column terminal still seats the compact mark next to
them; when the terminal is too narrow, the hints win and the mark drops.

The running build version is chrome, not part of the landing composition:
`src/tui/shell/index.ts`'s `versionRow`/`versionBadge`, a dedicated row pinned to the
terminal's last line and right-aligned, distinct from `landing.ts`'s hero and
below sections. It only reserves that row while the landing screen is
showing (`relayout`'s `versionReserved`/`terminalForGeometry`) — once there
is real transcript content the row goes back to whatever needed it, and the
badge stops rendering. On a narrow or short terminal it hides
(`versionBadgeVisible`, thresholds `VERSION_BADGE_MIN_COLUMNS`/
`VERSION_BADGE_MIN_ROWS` in `landing.ts`) before the prompt box or any other
actionable chrome would degrade for width/height reasons.

This is not a free row, though, while it is showing: `terminalForGeometry`
subtracts it from the terminal size handed to the geometry resolver before
the resolver runs, so every height the resolver derives — including
`PROMPT_CAP_FRACTION * terminal.rows`, computed before `COLLAPSE_ORDER` ever
runs — sees one row fewer than the real terminal. The badge does not sit in
`COLLAPSE_ORDER` and is never given back under prompt-growth pressure the
way the task or agents panel is. An operator composing a long prompt on the
landing screen at, say, 23 rows gets an 8-row cap instead of 9. This is a
known, accepted cost of the badge rather than an oversight — see
`terminalForGeometry`'s doc comment in `src/tui/shell/layout.ts` for the exact mechanism.

While the landing is mounted, a mount-scoped 125ms timer advances snow
across a frozen mountain. It is cancelled on the first real transcript
row or on shell dispose. Deferred system notices do not count. While
the landing is still up, the callback no-ops if a turn is already
driving the mark. `still` freezes the mountain's draw/fill/fade
timeline only; snow still drifts. Reduced motion
(`AppShellOptions.reducedMotion`, forwarded from `ProductHostConfig`)
never starts that timer and paints a still mountain with no snow, even
when a caller asks `paintLanding` to animate.

That timer is the pre-session frame source. The renderer FRAME event
follows dirty rows, not a clock, and starves under throttle. The turn
monitor stays idle-stopped: mixing its cadence into the landing would
couple a pre-session surface to session activity.

The model/provider picker is one flat, type-to-filter list
(`src/tui/product-host.ts` + `openModelPickerOverlay({ typeToFilter: true })`):
recent and favorite provider+model pairs sit at the top, then every
`model * [provider]` leaf from the catalog. Typing narrows the list in place
(printable keys claimed by the picker's own `>` filter row); Enter selects
for this session. Escape closes the picker. The row matching the session's
live active model gets a `(current)` suffix. **Alt+D** persists the focused
pair as the default (global `defaultProvider` + that provider's `defaultModel`

- project-local selection) without switching the live session or closing the
  picker. Alt+F on a model row
  still toggles favorite when a favorite hook is wired. While type-to-filter is
  active, bare `j`/`k` type into the filter rather than moving the highlight —
  use arrow keys (or the filtered list's navigation) to move.

`/mcp` uses the same longest-first overlay-hint footer as the model picker:
**Alt+A** add (omitted while local MCP settings shadow global), **Alt+D**
disable, **Alt+R** remove — never bare letters. A remove confirm drops those
manage hints so the footer is the default Esc/Enter pair.

The list itself never nests by provider, but connecting a new provider is not
a flat-list row either: the picker used to grow a "connect →" row per
not-yet-configured provider kind, filtered out once that kind had any
connected account. That filtering made a second OAuth account (a second
Codex or xAI login) unreachable — OAuth accounts are per-profile, so
kind-level "already connected" filtering hid the connect path the moment the
first profile existed. **Alt+A** (US-style Option+A, including composed å/Å)
and **/connect** now open `add_provider`
(`src/tui/overlays.ts:openAddProviderOverlay`), a separate `PrimaryOverlayKind`
listing every first-class provider kind from `providerChoices()` — OAuth,
API-key, keyless local, and Custom alike — each annotated with its live
connected-account count and none of them filtered out. `/connect` is the
layout-proof path: layouts whose Option+A is not å/Å still type a printable
glyph, so Alt+A is a dead chord there. Custom uses the full manual form
(name, base URL, key, model); OAuth and API-key kinds keep their auth-only
or browser login paths, while Ollama has a keyless local setup path. Esc
after Alt+A from `/model` returns to the model list through the same
`openModels()` entry point the picker itself uses. Esc after `/connect`
from a closed prompt dismisses the selector without reopening `/model`.
Picking a row runs the
existing inline connect flow (`provider-connect.ts`); first-class kinds (OAuth
and API-key) both ask for an instance/account name before auth so multiple
instances coexist as `kind/slug` catalog rows, and reusing a name confirms
before re-auth or re-key. On success the picker reopens focused on the new
account's default model instead of the top of the list.

Ollama setup is keyless and starts with an editable server root, defaulting to
`http://localhost:11434`. Continuing discovers models dynamically from that
server rather than presenting a fixed catalog. If the server is unreachable,
the setup stays open and treats that as an expected local-availability state:
the user can start Ollama, edit the root, or retry. A reachable server with no
models instead explains that at least one model must be pulled before retrying;
a reachable response with an invalid shape is reported separately as malformed,
not collapsed into either an empty catalog or a connection failure. These are
recovery instructions, not an Ollama installation tutorial.

Onboarding (the standalone provider-setup screen, `provider-setup.ts`) and
the satellite pickers used for session resume and session-mode selection
(`src/tui/list-modal.ts:runListModal`) deliberately do not enable DEC
mouse reporting (`useMouse: false`, `enableMouseMovement: false` — verified
in `mouse-reporting-disabled.test.ts` for both `runListModal` and
`runProviderSetup`). This is intentional: these surfaces never need
click-to-expand or drag-to-scroll, so leaving mouse reporting off lets the
terminal's own text selection and copy work by default, with no Alt+M dance
required. The resume picker lists the 10 most recently persisted sessions
for this checkout — completed, failed, crashed, and interrupted included. Recency is
the last write to `run.json`, not start time. Type to filter by name
(printable keys claim the `>` row, same as the model picker).

## The prompt box

The prompt is a genuine multi-line composing area built on OpenTUI's
`TextareaRenderable` rather than its single-line `InputRenderable`, because
the single-line widget is hard-wired to one row, no wrapping, and strips
newlines (`src/tui/prompt-input.ts`). Enter sends; a literal newline
needs an explicit chord: Ctrl+Enter or Ctrl+J work on every terminal, and
Shift+Enter works too on a terminal that negotiates the kitty keyboard
protocol (this app requests it — `useKittyKeyboard` in `product-host.ts`) and
reports the modifier back. A plain terminal sends the same bare `\r` for
Enter and Shift+Enter, so on those Shift+Enter silently does nothing — driven
live, this is exactly what happens, not a hypothetical. Ctrl+Enter/Ctrl+J are
the chord to point an operator at when Shift+Enter doesn't respond.

### Soft steer vs. follow-up

Two mid-run gestures, two delivery times (CL-6290):

- **Enter, mid-run** — soft steer: enqueues kind `"steer"` and delivers at the
  next **parent** `tool.boundary` (the parent tool finishing, not a child) via
  `Agent.deliver` into the live reactor, not a new `send`. A
  long parent `run_shell` or an awaiting `wait_agents` is parent-busy and holds
  steers. An in-flight TUI-primary `wait_agents` yields as a timeout when a
  steer is queued so occupancy can pick it up. A queued steer delivers at the
  next parent `tool.boundary` so occupancy can pick it up. Pending items list
  in the pending column above the prompt, not the transcript; the transcript
  only ever sees the item that actually delivers, as an ordinary user row
  (`submitPrompt`, `drainSteersAtBoundary` in `runtime-bridge.ts`). If the
  captured target agent is already closed when delivery runs, the bridge
  restores the exact message (and attachments) to an empty prompt, or
  FIFO-defers behind a draft the operator already typed — it never
  auto-sends to a rebuilt successor. The delivered row is corrected to
  `[not delivered]` (or `[delivery uncertain]` for non-closed failures), and
  another explicit Enter is required before any new logical delivery.
- **Alt+Enter, mid-run** — follow-up: enqueues kind `"queue"` and delivers
  only on **session-idle** (parent-idle and no live fleet lanes) as a `send`.
  Does not interrupt or reinject. Idle, or with an empty
  prompt, Alt+Enter does nothing — there is nothing to wait for. (Internal
  `"reinject"` remains in the submit API for tests; no product chord wires it.)
  Closed-target recovery for follow-ups uses the same prompt-restore / draft-
  defer ownership as soft steer; `/clear`, `/new`, and dispose discard both
  in-flight deliveries and deferred recoveries with the old session.

Held items never touch the transcript. Both kinds list in the **pending
column** — a transient zone stacked directly on the prompt box, one row per
item (`› steer …` / `› follow-up …`, `▸` on the selected row), oldest items
folding into a leading `+N more` past four shown rows so the newest items —
nearest the prompt, first selected — stay visible, and a guidance row naming
its keys (`pending-column.ts`, painted by `syncPendingRows` in `chrome.ts`).
The transcript only ever sees the item that actually delivers, as an ordinary
user row — pending/delivery labels (`[will steer next]`, `[steering]`,
`[following up]`) are gone on purpose.

While the column has items, `↑` at the prompt buffer's top edge selects the
newest held item and `↑`/`↓` walk the rows; `↓` past the last row hands the
key back to the prompt. On a selected row, **Enter** kills the item out of the
queue and force-pushes it — `onForceDeliver` drops it on the same
`port.deliver` hop a drain uses, so a steer still injects when the parent
cycle is live and otherwise sends immediately. **Ctrl+X** drops the selected
item outright. Esc or any other key ends the selection and falls through to
normal handling. `Ctrl+G` stays the pop-to-edit chord: it returns the newest
held item to an empty prompt for editing (dropping it mid-compose).

When `steer > 0` and a parent tool has been in flight ≥ `STEER_WAIT_NOTICE_MS`
(3s), the notice row adds `waiting on <tool>` (e.g. `waiting on run_shell`).
Follow-up-only does not; a sub-threshold in-flight tool does not. Delivery is
unchanged.

**Idle-with-fleet** is shipped. After a non-blocking `spawn_agent` dispatch
the parent turn settles while workers keep running; the runner emits `fleet`
events carrying the live-lane count and the bridge holds the run busy on it.
During the hold, Enter upgrades to a new primary turn sent immediately —
there is no parent tool left to steer — while Alt+Enter follow-ups keep
waiting for true session-idle. A child done or fail while siblings still run
flushes mailbox mail as system inbound (`flushMailboxMail`, skip when a
fleet-dry open-task shot is latched). A steer still pending when the hold engages
sends at once (the parent it was steering has stopped), and the last lane
terminalizing releases the hold, drains follow-ups, and returns the session
to idle — unless todo/doing tasks remain, in which case a system
continuation starts before the fleet-0 event so the run stays busy and
follow-ups wait one more turn. The mail and that fleet-dry continuation
are runtime-to-agent traffic — the fleet board owns worker status — so
neither paints a transcript row, and neither rehydrates as one.

Interrupting (Ctrl+C) never discards a queued or steered message. It used to
— the transcript literally said `interrupt — discarded N pending`, and an
operator who queued an instruction and then lost patience destroyed the very
thing they were trying to deliver. It now reports `interrupt — N pending
kept`: the run stops, the queue survives, and those messages are handed over
at the interrupt itself (`doInterrupt` drains after `port.interrupt()`), not
left waiting on an idle event the stop may never produce (`interrupt` in
`session-queue.ts` no longer clears `items`).

**Fleet agent lanes on redirect.** Soft steer (Enter mid-run) and follow-up
(queued drain) leave running workers alone — they never call
`runner.ts`'s `interrupt()`, so the parent's operation signal stays live and
spawned workers keep running. Ctrl+C is the explicit fleet teardown:
`doInterrupt` → `port.interrupt()` → `currentAgent.close()` aborts the shared
operation signal and routes cancellation through the fleet/session-store
teardown path, so in-flight fleet-agent dispatch reports back as cancelled by
the operator rather than being left to finish silently detached. `/clear` and
session exit still call `subAgentSessions.cancelAll` for an explicit
session-wide cancel; that path is separate from interrupt and must stay off
the soft-steer / follow-up gestures.

Up/Down are caret motion first inside a multi-line buffer — except while the
pending column is engaged, when ↑ at the buffer's top edge selects a held item
instead (see "Soft steer vs. follow-up"). History recall
only fires when the caret is already at the first or last wrapped row of the
buffer — i.e., has nowhere further to go
(`promptCaretAtFirstRow`/`promptCaretAtLastRow` in `prompt-input.ts`,
consumed in `src/tui/shell/keys.ts`'s key handler). This is deliberate, not incidental:
with DEC mouse reporting on, a terminal translates a wheel tick into the same
arrow-key byte sequence as a real keypress, so scroll and history navigation
cannot both be arrow-driven at the same time without one shadowing the
other. That is also why the main shell routes the mouse wheel to the
transcript rather than the prompt even when the wheel event hits the prompt's
own hit-tested region (`routePromptWheelToTranscript`, `src/tui/shell/keys.ts`) — arrow
keys stay history/caret, wheel stays transcript scroll, and the two never
collide.

Bracketed paste is the primary paste path; a fallback heuristic (a printable
character immediately followed by Enter inside one keystroke burst) detects a
paste replayed as raw keystrokes on a terminal that never sends a real
`paste` event, so pasted multi-line text does not get split into multiple
sent messages. Once a real `paste` event has fired even once, the fallback
heuristic is permanently skipped for the rest of the session
(`src/tui/shell/keys.ts`, the `sawBracketedPaste` guard).

Ctrl+V and Ctrl+P attach a PNG from the macOS clipboard
(`attachClipboardImage` in `src/tui/shell/prompt.ts` → `readClipboardImage` in
`image-attachments.ts`).
Cmd+V stays text (bracketed paste above). Clipboard image attach is
macOS-only; Linux/Windows bitmap clipboard paste is not supported.
`/paste-image` is the same attach path.

@-mention path completion opens a popup keyed off the `@token` under the
cursor (`openAtMentionSuggestions`, `src/tui/shell/internals.ts`); every keystroke re-queries,
and a generation counter discards a slower, stale query's results if a newer
one already landed. Accept is refused unless that generation is still current
and a live `@` token is under the cursor (the same `@` the lookup started on).
Enter that fails those checks dismisses the popup (same generation bump as Esc)
so an in-flight lookup cannot reopen it. A lookup that finishes after the
cursor has left that token does not open. Dismiss clears mention accept state
and bumps generation.
Directory picks re-open one level down so the operator can drill into a path
without retyping it. The popup only splices a path into the prompt; submit
inlines `@file` contents and summarizes `@dir` via `ingestOperatorPrompt`.

A readline-style kill ring backs Ctrl+K/U/W (kill) and Ctrl+Y/Alt+Y
(yank/yank-pop) on top of the textarea's native delete bindings, which
otherwise discard what they delete (`src/tui/prompt-kill-ring.ts`).
Consecutive kills in the same direction accumulate into one ring entry the
way readline does, so a `Ctrl+K Ctrl+K … Ctrl+Y` sequence restores the whole
killed run in original order.

The prompt repaints on every keystroke (`onFrame` in `src/tui/shell/index.ts` calls
`syncPromptRows`/`syncTranscriptSpacer`/`syncNoticeAfterLayout` every frame,
not on a debounce) — anything added to the prompt's paint path must stay
cheap, because it runs at typing speed.

Ctrl+C interrupts a busy run, or clears idle prompt text and pending
attachments. Clearing prompt text arms a 2-second quit window
(`CTRL_C_EXIT_WINDOW_MS`); clearing attachments alone does not. A second
Ctrl+C while the window is open quits — this
replaced an Ink-era yes/no exit-confirm modal with the same intent (an
explicit second confirmation) without adding a modal (`handleCtrlC`,
`src/tui/shell/prompt.ts`). See "Soft steer vs. follow-up" above for the two
mid-run gestures and what interrupting does to fleet-agent lanes. The interrupt
keeps whatever is sitting in the queue rather than discarding it — the
operator typed those messages meaning them delivered, not meaning "cancel
this run and also throw away what I typed"; the transcript row says so
(`"N pending kept"`). Kept items are handed over at the
interrupt itself (`doInterrupt` in `runtime-bridge.ts` drains after
`port.interrupt()`), serialized behind the agent rebuild the stop starts —
a stop does not reliably produce an idle event to drain against later.

## Overflows, scrolling, and key macros

The main session shell owns the mouse. With DEC mouse reporting on (the
default), the wheel scrolls the transcript, clicking a collapsed tool row or
diff arrow expands it in place, and dragging across selectable text starts an
OpenTUI selection that **auto-copies to the system clipboard on mouse-up**.
Dragging on non-selectable chrome still scrolls. The cost of holding the
mouse this way is that _native_ terminal drag-select is unavailable while
reporting is on: the terminal hands drag events to the app instead of
running its own selection. Two chords cover remaining copy needs:

- **Drag-select (mouse captured)** uses OpenTUI's selection event
  (`CliRenderEvents.SELECTION` → `copyFinishedSelection` in
  `selection-copy.ts`). On mouse-up, non-empty selected text is written
  through the system clipboard port and the highlight clears with a status
  flash. Empty clicks do not copy. Confirmation flashes pass
  `ttlMs: RUNTIME_FLASH_MS` so they clear themselves; omit TTL only for
  live conditions that stay true until replaced (stall notice, landing hold).
- **Alt+M** toggles DEC mouse reporting off and back on
  (`toggleMouseCapture`, `src/tui/shell/copy.ts`). Off, the terminal's own drag-select
  and copy work exactly as in any other terminal program; the status flash
  names the trade both ways ("Mouse released · drag to select and copy as
  usual · Alt+M to click rows" / "Mouse captured · drag text to copy ·
  click to expand · Alt+M for native select").
- **Alt+C** copies a message, tool output, or diff without touching the
  mouse at all: it opens a copy-selection surface over the transcript
  (`enterCopyMode`) that resolves through the system clipboard port
  (`src/tui/system-clipboard.ts` — a native helper binary per
  platform, `pbcopy`/`clip`/`wl-copy`/`xclip`/`xsel`, falling back to an OSC
  52 escape sequence when no helper is available, e.g. over SSH). On a
  coalesced tool lane the copy resolves to the most recent call's full
  output; a single-call row copies its own output, exactly as before.

Arrow keys never scroll anything — inside the prompt they are caret motion
or, at the buffer's edges, prompt-history recall; inside an open overlay's
list they move the active selection. Only the mouse wheel and the modal's
own page keys (PgUp/PgDn) move a scroll position, and only the surface
holding the current scroll lease responds to them.

`Ctrl+G` (the Emacs/readline "abort" chord) pops the most recently queued
mid-run message back into an empty prompt for editing, or drops it mid-compose.
`Tab` toggles focus between the prompt and the transcript.
`Shift+Tab` cycles reasoning effort for the current model (wrapping the
supported ladder) and flashes the new level; the prompt-border effort
segment updates immediately. A model with no effort levels flashes instead
of mutating the session. Unshifted `Tab` still toggles focus.
`e` (with Alt/Option) expands a collapsed row — a collapsed permission
payload while an overlay owns focus, or a collapsed transcript row (tool
output, a long diff) while the transcript does — one expand idiom shared
across both contexts.

## Standalone screens

The provider-setup screen (`src/tui/provider-setup.ts`) runs before
any session shell exists, so it does not route through the shared geometry
resolver — there is no transcript, no prompt box, nothing for that resolver
to arbitrate yet. Every direct child of that screen's root is given
`flexShrink: 0` (verified at the five top-level row containers in
`provider-setup.ts`). Without that, OpenTUI's flex layout compresses
single-line rows into each other on a short terminal and garbles the text.
Any future standalone screen in this class — one that mounts its own
renderer ahead of the main shell — must follow the same rule.

## Fixture and demo data

Fixture and demo content must never be reachable from a production code
path. When a surface's real dependency is missing (e.g. the settings surface
opened with no settings data wired in), the surface must produce an honest
empty state or a surfaced error — never the hardcoded rows from
`src/tui/residuals.ts` rendered as if they were real content
(`overlay-fixture-fallback.test.ts` pins this: a settings surface opened
without its dependency must not contain the real settings labels, and must
notify the caller instead).

## Structured logging never paints the screen

Every logger in the process — including loggers inside vendored dependencies
Corbits does not control — is routed to a file sink
(`src/logging/sink.ts:installFileLogSink`, installed as the first statement
in the process entry point) instead of the console. `@intx/log` installs a
console sink as a side effect of its own first import, so this must run
before any other Corbits code executes: the TUI holds the alternate screen
for the rest of the process, and anything landing on the real terminal
mid-frame corrupts the paint. Anything the operator must actually see goes
through the transcript (`appendStreamRow`) or a chrome notice — never a log
line.

## Test-harness blind spots

The OpenTUI headless renderer used by the automated test suite is not a
terminal. It cannot observe:

- **Real paint.** Tests assert on the shell's in-memory row/rect state, not
  on what a terminal emulator actually draws to a screen buffer.
- **The live shell tail's wall clock.** The feed itself is pure and the
  cadence is injectable, so the live tail is headless-testable by driving a
  fake feed and a fake clock through the same sync path the sticky poll
  uses; what the harness cannot see is real-time emission timing.
- **Modifier reporting.** Whether a real terminal can report Shift+Enter,
  Alt+letter, or similar modifier combinations depends on the terminal
  negotiating the kitty keyboard protocol (or an equivalent) with the actual
  host terminal emulator — the headless harness has no such negotiation to
  fail or succeed at.
- **The system clipboard.** `system-clipboard.ts`'s helper-binary spawns and
  OSC 52 fallback are exercised with mocked spawn functions in tests; no
  test round-trips through a real `pbcopy`/`xclip`/terminal clipboard.
- **Terminal-owned text selection.** Native drag-select only exists once DEC
  mouse reporting is off and a real terminal emulator is running; there is
  no terminal emulator in the test harness to select text in. OpenTUI
  selection auto-copy is unit-tested (`selection-copy.test.ts`) and wired
  through a synthetic `SELECTION` event (`copy-wire.test.ts`); a real
  mouse-up path still needs a manual terminal check.

Concretely, whole defect classes — a DEC mouse-reporting toggle that silently
no-ops, an Alt+key chord a given terminal never actually delivers, a
clipboard write that fails silently on a machine with no clipboard helper
installed, native drag-select that never re-engages after Alt+M — are
invisible to the automated suite by construction. A green `bun run test` is
evidence the pure logic and the headless paint model behave; it is not
evidence any of the above works in a real terminal. Changes touching mouse
reporting, modifier chords, clipboard, or terminal-owned selection need a
manual run in a real terminal before being called done.

## Open questions

The following normative-shaped statements could not be verified against
source in the time available and are left here as open questions rather than
asserted as fact:

- Whether every collapse-order edge case in `geometry/resolve.ts` (e.g. the
  tiny-terminal, sub-24-row path) has a corresponding test that pins the
  exact row counts, or whether some of that path is only exercised
  indirectly.
- Full coverage of which chords are guaranteed deliverable on every terminal
  emulator Corbits Code targets (Shift+Enter and Alt+letter reporting depend
  on kitty-protocol negotiation the harness cannot test — see Test-harness
  blind spots above); this document states what the code does when a chord
  _is_ delivered, not which terminals reliably deliver it.
