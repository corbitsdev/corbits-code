# Corbits Code — TUI Behavior Spec

This is the normative behavior spec for the terminal UI: Corbits Code, built on
OpenTUI (`@opentui/core`). It describes what the shell must do, not how the
OpenTUI cutover got here. The implementation lives in `src/tui-opentui/`; the
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
zero rows when it has nothing to say (`src/tui-opentui/geometry/zones.ts`).
The transcript is residual: whatever rows remain after chrome and any open
overlay belong to it, never the other way around
(`src/tui-opentui/geometry/resolve.ts:resolveGeometry`).

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
(`resolveSideMargin`, `src/tui-opentui/geometry/margins.ts`) so the shell reads
as a single column of content rather than stacked panes. The gutter is one
column per side at every width that can afford it, and zero below
`MARGIN_MIN_COLUMNS` (40), where every column belongs to content. There is no
middle tier: one column is already enough to keep content off the frame edge,
which is the gutter's entire job, and anything wider only read as excess air on
a wide pane. The gutter costs no rows.

The prompt box's border carries the metadata that would otherwise cost a
titlebar row: the model label sits right-aligned in the top rule; the brand
lockup sits at the left of the bottom rule with the working directory and git
branch at its right (`AppShell.promptTopRule` / `promptBottomRule`,
`src/tui-opentui/shell.ts`). Both rules cost zero transcript rows because they
ride the prompt box's own border.

While a turn is live the lockup slot swaps the wordmark for the phase word —
`thinking`, `streaming 12 tok`, the running tool's name — led by a single
density cell (`rampPulse`, `src/tui-opentui/ramp.ts`). The cell, not the word,
is what says whether the session is healthy, and it carries four states:

| State | Cell | Reads as |
|---|---|---|
| `working` | cycles `░ ▒ ▓ █` on `RAMP_CYCLE_MS` | moving |
| `done` | static `█` | finished |
| `blocked` | static `▌` | waiting on the operator |
| `stalled` | `!` blinking against `█`, then a static `!` | a problem |

Every state is separated by glyph and motion before colour, so all four survive
a monochrome terminal and are readable without stopping to read the word. A
static `working` word was the original failure: a live run and a hung one
printed identically, so the only way to tell them apart was to wait.

`blocked` and `stalled` share the orange deliberately — both name a turn
waiting on something outside itself — and are told apart by motion: `blocked`
holds perfectly still, which is the signal that the session is waiting on *you*.

The stall phase is driven by the watchdog's own silence clock
(`stallLevel`, `src/tui-opentui/stall-watchdog.ts`), so the indicator and the
abort can never disagree about which runs are stuck. It arms at
`STALL_NOTICE_MS` and keeps reading as stalled straight through the abort
threshold. Its blink is a bounded burst (`STALL_BLINK_BURST_MS`) that settles
to a static `!`: an alarm that strobes for the whole stall window becomes
wallpaper, and settling also lets the render loop drop back to the slow
cadence. The burst is measured from the moment silence crossed the notice
threshold, so a resumed session with already-stale activity shows the settled
glyph immediately rather than alarming about silence the operator missed, and
a stall that breaks and re-arms bursts again.

An idle session animates nothing at all: the monitor tick stops entirely
rather than repainting an unchanging frame.

Color is a small, deliberate palette, not decoration
(`src/tui-opentui/theme.ts`). Dimmed text is a dimmed cream, never a neutral
gray, so every emphasis level keeps the same warm hue. Orange
(`UI.action`) is spent once per screen: it marks the session identity and
whatever is currently awaiting a human decision (an approval subject, an
active choice) — nothing else competes with it. Ongoing, non-decision status
uses the bronze/sand/ember chrome ramp and green (`UI.done`) for completion.
The one deliberate exception is diff removals, where orange is content (the
removed line), not a decision marker, and no decision-marker shares that row.

## The live agents panel

The `agents` chrome zone renders a standing panel above the transcript, one
row per currently-running sub-agent — not a count. Each row reads
`agentId: description · elapsed · tool`, sourced from the same
`agentProgress()` clock/tool/stall computation used to trail a task row in the
transcript (`src/tui-opentui/agent-progress.ts`); the panel does not compute
progress a second way. A worker silent past the stall window (`DEFAULT_STALL_MS`)
gets a `· stalled` suffix so it reads distinct from one still working, without
relying on color alone.

The panel is bounded to `AGENTS_PANEL_MAX_VISIBLE` rows
(`src/tui-opentui/geometry/zones.ts`); a larger fan-out degrades to a trailing
`+N more` row rather than growing the zone — and therefore the chrome
budget — without limit. Its height is requested from the geometry resolver
like every other zone, never guessed: the caller passes the exact row count it
is about to render (`ZoneVisibility.agents: boolean | number`), and the
resolver clamps it to the zone's registered max. Agents that have reached a
terminal state (done/failed/cancelled) do not occupy a row; zero running
agents is zero rows and zero chrome. `observe` mode overrides the panel with a
single `observe: <agentId> — <description>` line instead of per-agent rows.

Which agents survive a fan-out past `AGENTS_PANEL_MAX_VISIBLE`, and the order
those survivors render in, are two different questions with two different
answers (`formatAgentsPanel` in `chrome-state.ts`). Selection — which N
agents are shown before the rest fold into `+N more` — keys on staleness
(`lastActivityAt`), so the agent most likely to be stalled is guaranteed a
row rather than the caller's feed order (which sorts running sessions
newest-first) silently hiding it. Presentation — the order the surviving
rows paint in — keys on `startedAt` instead: `lastActivityAt` changes on
every tool event, so sorting the visible rows by it would reshuffle the
panel on every repaint. `startedAt` is stable for the life of a running
agent, with `agentId` as a tiebreak for a simultaneous fan-out.

Under space pressure, the zone shrinks one row at a time toward 1 rather
than collapsing straight to 0 (`COLLAPSE_ORDER` treats it like `progress`,
not like the single-row `task` strip) — a 1-row panel still carries
the stalest agent plus its `+N more` trailer, so it stays meaningful all
the way down. Only once every other collapsible zone ahead of it in
`COLLAPSE_ORDER` and the panel itself are exhausted does it reach 0, the
same last-resort floor every other optional zone shares.

## How pop-ups should feel

A blocking surface (permissions, an operator question, the model/provider
picker, settings, help, the command palette, …) shares one overlay host and
one height path — there is no second modal stack with independent row
accounting (`src/tui-opentui/geometry/resolve.ts`,
`src/tui-opentui/shell.ts:openListOverlay`). Opening a second surface either
replaces the one that was open or stacks over it; either way Escape always
walks back along a single path to the prompt.

An open overlay reserves a real minimum for its own border, title, and at
least one content row before anything else — including the transcript floor
— is allowed to starve it further. That minimum is `OVERLAY_MIN_ROWS = 3`
(`src/tui-opentui/geometry/zones.ts`) — two border rows plus one content row.
The geometry resolver iteratively collapses optional chrome to make room for
both the transcript floor and this overlay minimum before it ever accepts a
transcript-below-floor outcome; only when nothing is left to collapse does it
fall back to best effort (`resolveGeometry`'s collapse loop in
`geometry/resolve.ts`). An overlay must never paint past the box it was
actually assigned.

Escape dismisses the open overlay and, for a permission or operator prompt,
that dismissal **denies** the request rather than leaving it unresolved
(`src/tui-opentui/gate-wire.ts`: both `onPermission`'s and `onOperator`'s
`onCancel` handlers resolve the pending promise — as a deny for permissions,
as a cancel for the operator question — with an explicit comment that an
unresolved gate "hangs the run until the process is killed"). This exists
because an earlier version could abandon the awaited promise on Escape and
leave the session parked with no recovery path short of killing the process;
Escape must always settle the promise it is dismissing.

The decision surfaces (permission approval, operator question) are the one
framed content in the shell, and they are shaped rather than merely listed
(`src/tui-opentui/overlay-body.ts`): a dithered header (`░▒▓`) carries the
subject in the action color, a blank row separates it from context, and each
choice gets one row with the active choice marked by a solid block (`█`)
rather than a background fill.

## How selectors should work

Every list surface — permissions, the operator question, the model picker,
the command palette, resume/session-mode pickers, settings — shares one list
viewport kit: shared windowing, keep-active-visible, and page/jump behavior.
There is exactly one scroll lease at a time; keyboard paging and the mouse
wheel both follow whichever surface currently holds it, so a modal open on
top of the transcript never lets the wheel move the transcript underneath it.

"Current" is never inferred. For the model picker, the row marked
`(current)` is read live from the session's actual active provider/model on
every picker open — independent of the recents list, which only moves on an
explicit pick and can go stale (`ProductHostConfig.activeModelId`'s doc
comment and `annotateCurrent` in `src/tui-opentui/product-host.ts`).

The command palette specifically (`src/tui-opentui/palette.ts`,
`shell.ts:openPalette`/`repaintPalette`): width matches the prompt box — both
are painted at the geometry resolver's shared `contentWidth`
(`geometry/resolve.ts:assignRects`, `shell.ts:overlayRowWidth`). There is no
leading marker column and no per-row kind column; the selected row is marked
by text color only (`paintPaletteList` in `shell.ts`: "the highlighted row
already stands out by sitting under the cursor, so a leading `>` and a grey
block would both be saying the same thing twice"). The palette also paints
with no title rule — the filter row (`> query`) directly under the box
already shows what was typed, so a second header line would say nothing new
(`repaintPalette`).

## Slash commands and pickers

`Ctrl+O` opens the command palette from anywhere in the shell (reclaimed from
the Ink-era tool-expand chord); `/` at an empty prompt opens the same
palette narrowed to registry slash commands. Every user-facing slash command
has a palette twin. Palette entries are either "residual" product actions
owned by the shell (open permissions, switch model, toggle a chrome zone,
copy, toggle mouse capture, help, insert a mention, observe a subagent) or
"command" entries backed by the live command registry
(`src/tui-opentui/palette.ts`).

The model/provider picker is provider-first
(`src/tui-opentui/product-host.ts:groupModelsForPicker`/`openLevel`): recent
and favorite provider+model pairs stay flat at the top of the list (already
single models, nothing to descend into); every other provider collapses into
one top-level group row. Selecting a provider group row descends into that
provider's models; selecting a model dispatches the switch. Escape at the
model level returns to the provider level rather than closing the picker
outright (`openLevel(group.rows, onCancel)` passes the parent `openModels`
reopen as the child level's `onCancel`); only Escape at the provider level
closes the picker. Recent/favorite rows and the active provider's group row
both get a `(current)` suffix when they match the session's live active
model.

Onboarding (the standalone provider-setup screen, `provider-setup.ts`) and
the satellite pickers used for session resume and session-mode selection
(`src/tui-opentui/list-modal.ts:runListModal`) deliberately do not enable DEC
mouse reporting (`useMouse: false`, `enableMouseMovement: false` — verified
in `mouse-reporting-disabled.test.ts` for both `runListModal` and
`runProviderSetup`). This is intentional: these surfaces never need
click-to-expand or drag-to-scroll, so leaving mouse reporting off lets the
terminal's own text selection and copy work by default, with no Alt+M dance
required.

## The prompt box

The prompt is a genuine multi-line composing area built on OpenTUI's
`TextareaRenderable` rather than its single-line `InputRenderable`, because
the single-line widget is hard-wired to one row, no wrapping, and strips
newlines (`src/tui-opentui/prompt-input.ts`). Enter sends; a literal newline
needs an explicit chord (Shift+Enter or Ctrl+Enter where the terminal reports
the modifier via the kitty keyboard protocol, Ctrl+J everywhere else, since a
plain terminal cannot report Shift+Enter at all). Alt+Enter is claimed by the
shell before the textarea ever sees it, as the mid-run "steer" action.

Up/Down are caret motion first inside a multi-line buffer. History recall
only fires when the caret is already at the first or last wrapped row of the
buffer — i.e., has nowhere further to go
(`promptCaretAtFirstRow`/`promptCaretAtLastRow` in `prompt-input.ts`,
consumed in `shell.ts`'s key handler). This is deliberate, not incidental:
with DEC mouse reporting on, a terminal translates a wheel tick into the same
arrow-key byte sequence as a real keypress, so scroll and history navigation
cannot both be arrow-driven at the same time without one shadowing the
other. That is also why the main shell routes the mouse wheel to the
transcript rather than the prompt even when the wheel event hits the prompt's
own hit-tested region (`routePromptWheelToTranscript`, `shell.ts`) — arrow
keys stay history/caret, wheel stays transcript scroll, and the two never
collide.

Bracketed paste is the primary paste path; a fallback heuristic (a printable
character immediately followed by Enter inside one keystroke burst) detects a
paste replayed as raw keystrokes on a terminal that never sends a real
`paste` event, so pasted multi-line text does not get split into multiple
sent messages. Once a real `paste` event has fired even once, the fallback
heuristic is permanently skipped for the rest of the session
(`shell.ts`, the `sawBracketedPaste` guard).

@-mention path completion opens a popup keyed off the `@token` under the
cursor (`openAtMentionSuggestions`, `shell.ts`); every keystroke re-queries,
and a generation counter discards a slower, stale query's results if a newer
one already landed. Directory picks re-open one level down so the operator
can drill into a path without retyping it.

A readline-style kill ring backs Ctrl+K/U/W (kill) and Ctrl+Y/Alt+Y
(yank/yank-pop) on top of the textarea's native delete bindings, which
otherwise discard what they delete (`src/tui-opentui/prompt-kill-ring.ts`).
Consecutive kills in the same direction accumulate into one ring entry the
way readline does, so a `Ctrl+K Ctrl+K … Ctrl+Y` sequence restores the whole
killed run in original order.

The prompt repaints on every keystroke (`onFrame` in `shell.ts` calls
`syncPromptRows`/`syncTranscriptSpacer`/`syncNoticeAfterLayout` every frame,
not on a debounce) — anything added to the prompt's paint path must stay
cheap, because it runs at typing speed.

Ctrl+C interrupts a busy run (or clears a non-empty idle prompt); a second
Ctrl+C within a 2-second window (`CTRL_C_EXIT_WINDOW_MS`) quits — this
replaced an Ink-era yes/no exit-confirm modal with the same intent (an
explicit second confirmation) without adding a modal (`handleCtrlC`,
`shell.ts`).

## Overflows, scrolling, and key macros

The main session shell owns the mouse. With DEC mouse reporting on (the
default), the wheel scrolls the transcript, clicking a collapsed tool row or
diff arrow expands it in place, and dragging inside the transcript scrolls it
— none of that needs a modifier key. The cost of holding the mouse this way
is that native terminal drag-select is unavailable while reporting is on:
the terminal hands drag events to the app instead of running its own
selection. Two chords cover that gap without needing the mouse released
first:

- **Alt+M** toggles DEC mouse reporting off and back on
  (`toggleMouseCapture`, `shell.ts`). Off, the terminal's own drag-select
  and copy work exactly as in any other terminal program; the status flash
  names the trade both ways ("Mouse released · drag to select and copy as
  usual · Alt+M to click rows" / "Mouse captured · click to expand, drag to
  scroll · Alt+M to select text again").
- **Alt+C** copies a message, tool output, or diff without touching the
  mouse at all: it opens a copy-selection surface over the transcript
  (`enterCopyMode`) that resolves through the system clipboard port
  (`src/tui-opentui/system-clipboard.ts` — a native helper binary per
  platform, `pbcopy`/`clip`/`wl-copy`/`xclip`/`xsel`, falling back to an OSC
  52 escape sequence when no helper is available, e.g. over SSH).

Arrow keys never scroll anything — inside the prompt they are caret motion
or, at the buffer's edges, prompt-history recall; inside an open overlay's
list they move the active selection. Only the mouse wheel and the modal's
own page keys (PgUp/PgDn) move a scroll position, and only the surface
holding the current scroll lease responds to them.

`Ctrl+G` (the Emacs/readline "abort" chord) cancels the most recently queued
mid-run message. `Tab` toggles focus between the prompt and the transcript.
`e` (with Alt/Option) expands a collapsed row — a collapsed permission
payload while an overlay owns focus, or a collapsed transcript row (tool
output, a long diff) while the transcript does — one expand idiom shared
across both contexts.

## Standalone screens

The provider-setup screen (`src/tui-opentui/provider-setup.ts`) runs before
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
`src/tui-opentui/residuals.ts` rendered as if they were real content
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
  no terminal emulator in the test harness to select text in.

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
- Whether the `(current)` marking on a provider *group* row
  (`withGroupMark` in `openModels`, `product-host.ts`) is reachable and
  correct in every case where the active model's provider itself has no
  favorites/recents entry — the code path exists but was not traced through
  a live picker session.
- Full coverage of which chords are guaranteed deliverable on every terminal
  emulator Corbits Code targets (Shift+Enter and Alt+letter reporting depend
  on kitty-protocol negotiation the harness cannot test — see Test-harness
  blind spots above); this document states what the code does when a chord
  *is* delivered, not which terminals reliably deliver it.
