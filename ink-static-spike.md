# CL-4358 spike: Ink `<Static>` for committed transcript history

## TL;DR

**Keep the current app-managed viewport (`event-log.tsx` + `use-scroll` + alt-screen) as the default.** Do not adopt `<Static>` wholesale. The scrollback and copy/paste wins are real, but they come bundled with three regressions that matter more for this product: loss of retroactive tool-call collapse/expand, broken resize reflow for anything already committed, and forced exit from the alt-screen (which is a bigger UI change than "the transcript scrolls differently").

A working prototype exists behind an off-by-default flag (`INTERCODE_TUI_STATIC_HISTORY=1`) — see "Prototype" below — for anyone who wants to test it hands-on in a real terminal before treating this recommendation as final.

## Background

Today's transcript (`src/tui/components/event-log.tsx`):

- Flattens every content block into a `StyledLine[]` buffer (`buildLinesIncremental`/`buildLines`), capped at `DEFAULT_MAX_RENDERED_LOG_LINES` (2000 lines).
- Slices that buffer by `scrollOffset`/`visibleRows` (`lineWindow`) and renders only the visible window — an app-managed viewport, not native terminal scrollback.
- Runs inside a hand-driven alternate screen buffer (`enterAltScreen` in `src/util/alt-screen.ts`, invoked from `runner.tsx`), because Ink 7.0.4 has no built-in alt-screen option.
- Supports `Ctrl+O` "viewport-proximity expand": `resolveViewportExpandIds` walks the *currently visible* line range (± a buffer) and sticky-expands tool calls near it, so scrolling past a collapsed tool call auto-expands it without the user hunting for a keybind.
- Caches per-block `StyledLine[]` (`buildLinesIncremental`'s cache Map) so a streaming token only re-lays-out the trailing block, not the whole transcript — but every render still re-slices and re-diffs the *visible window*, and the window itself is bounded by `DEFAULT_MAX_RENDERED_LOG_LINES` — a long session's early history is trimmed from the renderable buffer entirely (see `state.trimmedBlockCount` banner), not just from the visible slice.
- Never touches real terminal scrollback: everything scrolled off is state inside the process, invisible to `cmd+F` in the terminal, mouse-drag text selection across the "scrolled off" region, or a terminal's own search/scrollback keys.

Ink's `<Static>` inverts this: items handed to it are written to the terminal exactly once, in order, and become part of the terminal's own scrollback. Ink never re-renders or touches them again — it only ever asks for items with an index past what it has already committed.

## What the prototype does

Behind `INTERCODE_TUI_STATIC_HISTORY=1`:

- `src/tui/components/static-transcript.tsx` adds `partitionSettledTurns(contentBlocks, turnInFlight)`, a pure function that groups the flat content-block stream into per-turn arrays (a turn starts at a `"user"` block) and separates all finished turns ("settled") from the turn currently being produced (the "tail").
- `StaticTranscript` renders settled turns through Ink's `<Static items={settledGroups}>`, building each turn's `StyledLine[]` once via the existing `buildLines` and reusing the existing `RenderedLine`/`RunningToolRow` row renderers (now exported from `event-log.tsx` for this purpose — no behavior change to those components). The in-flight tail renders in a normal, repeatedly-rendered `<Box>` below, using the same block-to-lines pipeline.
- `runner.tsx` skips `enterAltScreen()` entirely when the flag is set, since `<Static>` output is permanent terminal history and an alt-screen buffer discards its entire canvas on exit — the two are fundamentally incompatible, not just visually mismatched.
- `app.tsx` gates the transcript region on the flag (`staticHistoryEnabled` prop, default `false`) and otherwise leaves `EventLog`/`scroll`/viewport-expand code completely untouched.

This is intentionally a narrow slice: it demonstrates the commit-once mechanism and the turn-boundary split, not a production-ready replacement. Chrome banners (trimmed-block notice, resource banner), the `Ctrl+R`/`Ctrl+O` expand toggles, and mouse-wheel scrolling are not wired into the static path — turning any of those on for the static path is exactly the migration work described below, not a gap in the prototype's core idea.

## Tradeoffs, measured against the code (not a live long-session benchmark — see "What wasn't measured")

### Repaint cost

**Static wins, structurally.** The current viewport still re-slices and re-diffs `visibleRows` lines of `StyledLine[]` on every render tick regardless of transcript length — `buildLinesIncremental`'s cache saves the *layout* cost for old blocks, but the *render* cost (Ink reconciling `visibleRows` `<Text>` nodes) recurs every frame the viewport is visible, including on every streamed token, because the whole viewport `<Box>` re-renders when `eventLogLines` changes identity (which it does on every streaming tick, since the tail block mutates).

`<Static>` renders each turn exactly once, period — Ink does not re-invoke the child renderer for indices it has already emitted, and does not keep those nodes in its reconciliation tree at all once committed. Only the tail region (bounded by one turn's content) repaints during streaming, independent of total session length. For a session with hundreds of turns, this is the difference between "steady repaint cost" and "repaint cost that includes re-touching a capped-but-still-large recent window every tick."

### Scrollback

**Static wins outright.** This is the entire point of the ticket. Today, nothing before the current viewport window exists in the terminal's own scroll buffer — a user's `Cmd+F`, terminal-native search, or scrollback keybinds see nothing. Worse, content is truncated from the *renderable* buffer past `DEFAULT_MAX_RENDERED_LOG_LINES` (2000 lines) regardless of terminal scrollback size, so very long sessions lose early history from the app's own state, not just from view. `<Static>` writes every settled turn to the terminal's real scrollback, which is exactly as deep as the user's terminal is configured to keep — independent of any app-side cap.

### Copy/paste

**Static wins.** Alt-screen buffers are why triple-click / drag-select across "scrolled past" transcript content doesn't work today — that content was never actually written to the terminal, it's an app-internal string that got sliced out of view. Once transcript rendering moves to `<Static>` (and necessarily out of the alt-screen, since the two conflict), every committed turn is real terminal text: selectable, copyable, searchable, exactly like normal terminal output.

### Resize reflow

**Static loses, and this is the sharpest regression.** Every `RenderedLine` in a settled turn is built once, at the terminal width at the moment it was committed (`buildLines(group, width, ...)`). If the user resizes the terminal after a turn commits, that turn's already-written lines do **not** rewrap — they were written as literal terminal output, and Ink has no way to retroactively edit history it already flushed. Only the still-open tail (and any new turns after the resize) would render at the new width. In today's model, `contentWidth` changes invalidate the entire line cache (`lineCacheKeysRef`) and the whole buffer relays out at the new width on the next render — resize is fully correct today and would become permanently broken (for already-committed content) under Static.

This is a real, not cosmetic, cost for a terminal app: users resize panes constantly, and a transcript with several different wrap widths stacked in scrollback reads as visibly broken.

### Loss of viewport-proximity collapse (`Ctrl+O` / `resolveViewportExpandIds`)

**Static loses this feature outright, not just "makes it harder."** `resolveViewportExpandIds` decides which collapsed tool calls to sticky-expand based on which *lines are currently in the app's visible window* (`scrollOffset`, `visibleRows`, `atBottom`). Once a turn is committed to `<Static>`, the app has no way to know — and Ink gives it no way to know — where that content currently sits relative to the user's real terminal viewport, because the app no longer owns the transcript's scroll position at all; the terminal does. There is no event for "user scrolled their terminal to line N of real scrollback."

Concretely, this means:

- A tool call collapsed at commit time is collapsed **forever** in scrollback. There is no way to expand it after the fact without re-emitting the entire turn (which would duplicate it in scrollback — a new copy below the old one — since Static can only append, never edit or replace).
- The explicit `Ctrl+R` "expand this specific tool" toggle could still work prospectively (expand before commit), but retroactive expand of already-scrolled-past content is architecturally gone.

For a coding agent transcript, where large tool outputs (diffs, shell output, file reads) are deliberately collapsed by default specifically so they can be expanded later when the user wants to check on them, this is a meaningful loss of a feature users rely on, not an edge case.

### Other findings

- **Alt-screen exit is bigger than "the transcript scrolls differently."** Leaving the alt-screen changes the whole app's presentation model: header/status bar/prompt chrome no longer own a fixed full-screen canvas with the transcript as a bounded pane inside it: they become chrome painted below an ever-growing scrollback, the way a normal CLI logs progress. That's a legitimate, different UX, but it is a product decision (do we want a "full-screen app" feel or a "streaming CLI log" feel?), not an implementation detail of this ticket.
- **Turn-boundary granularity matters.** The prototype commits at turn granularity (one user message to the next). A coarser grain (e.g., whole-session) would starve scrollback of intermediate structure; a finer grain (per-block) would commit tool calls before their paired result arrives, which breaks `toolResultForCall`'s pairing logic and would need every tool call's full lifecycle resolved before commit — meaningfully more state tracking than the two-array split used here.
- **Streaming tail correctness.** The prototype's tail is "whatever turn is not yet closed by a fresh `user` block, while `state.status` is `running`/`blocked`." This is adequate for a spike but doesn't yet handle every status transition (`stopping`, `stopped`, `failed` while a tail is open) — a real migration needs to define exactly when a turn is considered "settled" so it never commits a turn that's still receiving edits.

## What wasn't measured

This spike is code-level analysis plus a smoke-tested prototype, not an instrumented long-session benchmark. Before treating "keep the current model" as final, it would be worth:

- Running both paths side by side in a real terminal for a multi-hour session with heavy tool use, and comparing perceived input latency and CPU usage.
- Testing the resize-reflow regression against real terminal emulators (iTerm2, Terminal.app, Windows Terminal, tmux) to confirm the failure mode is as universal as the code suggests.
- Checking whether any terminal/multiplexer combination silently mitigates the resize issue (e.g., a terminal that keeps its own reflow-capable scrollback independent of what was originally written — unlikely, but worth ruling out before calling this decisive).

## If we adopt anyway: migration plan

Should product direction later prioritize scrollback/copy-paste enough to accept the tradeoffs above, here is the concrete path:

1. **Decide the presentation model first.** Commit to leaving the alt-screen for the main session view (this is the prerequisite, not a side effect) and redesign chrome placement (header/status bar/prompt) as a bottom-anchored region below growing scrollback, not a fixed-height pane.
2. **Replace viewport-proximity expand with commit-time expand policy.** Since retroactive expand is gone, redefine collapse/expand as a decision made *before* a turn commits: e.g., auto-expand tool calls above a size threshold, or expand everything and rely on terminal-native search/scrollback instead of app-side collapse. This is a UX call, not just an engineering one — flag it to design.
3. **Solve resize reflow or accept it.** Either (a) accept that resizing mid-session produces mixed-width scrollback (document it as a known limitation, matching how most streaming CLI tools behave), or (b) do not commit a turn to `<Static>` until some idle/settle window has passed, betting that resizes are rare enough mid-turn that most content commits at a stable width. There is no way to make already-committed `<Static>` content rewrap.
4. **Define turn-settlement precisely.** Enumerate every `AgentStatus` transition and decide, for each, whether the open tail should commit, stay open, or be discarded (e.g. on `stopped`/`failed` mid-turn). Fold this into `partitionSettledTurns` (or its replacement) with unit tests per transition, not just the "running/blocked = tail" heuristic used here.
5. **Retire the viewport machinery.** Once static commit is the only path, delete `use-scroll`, `resolveViewportExpandIds`/`viewportToolIds`/`capViewportToolIds`, `DEFAULT_MAX_RENDERED_LOG_LINES` truncation, and the scroll-offset plumbing through `app.tsx` — this is a large deletion (multiple hundred lines across `event-log.tsx` and `app.tsx`) that should land as its own commit once the static path has full feature parity, per this repo's "no back-compat shims" convention.
6. **Migrate mouse-wheel scroll.** `use-mouse-scroll`/`stdin-filter.ts`'s wheel re-routing exists to scroll the app-managed viewport; with native scrollback, wheel events should either be left alone (terminal handles them) or explicitly disabled to avoid double-handling.

## Prototype reference

- `src/tui/components/static-transcript.tsx` — `partitionSettledTurns` (pure, unit-tested) + `StaticTranscript` component.
- `src/tui/components/static-transcript.test.ts` — turn-partitioning unit tests.
- `src/tui/components/event-log.tsx` — `RenderedLine`, `RunningToolRow`, `runningStartOfLine` exported (no behavior change) for reuse by the prototype.
- `src/tui/app.tsx` — `staticHistoryEnabled` prop (default `false`) gates rendering `StaticTranscript` in place of `EventLog`; computed via `partitionSettledTurns` over `state.contentBlocks`. The non-flag path is untouched.
- `src/tui/runner.tsx` — reads `INTERCODE_TUI_STATIC_HISTORY=1` from the environment, skips `enterAltScreen()` when set, and passes `staticHistoryEnabled` to `<App>`.

To try it: `INTERCODE_TUI_STATIC_HISTORY=1 bun run start` (or the repo's equivalent dev entry point).

## How other agents solve this

Surveying other terminal coding agents shows the tradeoff above is not specific to this codebase — it's a structural split in the field, with two camps and one outlier worth watching closely.

**Camp 1: inline, committed-once, native scrollback.** Claude Code's default mode, gemini-cli, and aider all render turns inline in the normal terminal buffer and commit each one as it settles, the same `<Static>`-style approach this spike prototyped. They get native scrollback, terminal-native search, and real copy/paste for free. The cost is the same one measured above: history is frozen at the width and collapse-state it had when committed — resize reflow and retroactive tool-call expand/collapse are gone for anything already scrolled past.

**Camp 2: alt-screen, app-managed viewport.** opencode, crush, codex-today, and intercode as it stands today all run inside an alternate screen buffer with a hand-rolled viewport over an in-memory line buffer. This buys full resize reflow and dynamic collapse/expand of already-rendered content, at the cost of reimplementing scroll, search, and copy/paste inside the app instead of getting them from the terminal.

**The strongest signal: differential-inline rendering.** pi (pi.dev) and omp (oh-my-pi, `can1357/oh-my-pi`) do not pick a side — they render inline (no alt-screen) but keep an in-memory backbuffer of the live region, diff it against the previous frame, and repaint only the lines that changed, while treating any block that scrolls off the bottom of that live region as committed and appended to scrollback exactly once. This recovers native scrollback *and* near-viewport dynamism (resize reflow, retroactive collapse/expand) for the still-live portion of the transcript, at the cost of only one thing: once a block has scrolled off and been committed, it can no longer be mutated — the same one-way commit boundary `<Static>` has, just pushed much further back (to "off the bottom of the visible region" instead of "as soon as the turn ends"). Notably, Claude Code itself ships both an inline committed-once mode and an alt-screen viewport mode, rather than treating this as a single binary choice.

This changes the recommendation's shape. Keeping the alt-screen-managed viewport as intercode's default today is still correct — a plain port of Ink's `<Static>` would trade away the retroactive-collapse feature outright, as this spike found. But the real future direction worth spiking next is not "Static vs. viewport" as a binary; it's a pi/omp-style differential-inline renderer with a live backbuffer, which appears to be the only approach that recovers both scrollback and dynamism simultaneously.
