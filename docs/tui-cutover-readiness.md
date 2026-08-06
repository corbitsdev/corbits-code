# TUI cutover readiness — post-cutover re-score

**Branch:** `migration/opentui-tui`
**Policy:** `docs/tui-migration-cutover.md` — hard cutover, no dual-ship.
**Scope of this doc:** what shipped, what was verified and how, and what parity is
still missing. It does **not** authorize a merge; it tells a reviewer exactly what
they would be merging.

## Status summary

The cutover is done. OpenTUI is the only renderer.

| Claim | State | How it was checked |
|-------|-------|--------------------|
| Interactive CLI renders with OpenTUI | yes | `src/index.ts` → `runTUI` (`src/tui/runner.ts`) → `mountRunnerHost` (`src/tui-opentui/runner-host.ts`) |
| Onboarding on OpenTUI | yes | `src/tui/onboarding.ts` → `runProviderSetup` (`src/tui-opentui/provider-setup.ts`) |
| Resume picker + session-mode prompt on OpenTUI | yes | `src/tui/pick-session.ts`, `src/tui/session-mode-prompt.ts` → `runListModal` (`src/tui-opentui/list-modal.ts`) |
| Ink tree deleted | yes | no `.tsx` file remains under `src/`; no `from "ink"` import anywhere |
| Ink/React deps removed | yes | `ink`, `ink-testing-library`, `react`, `@types/react`, `react-devtools-core`, `yoga-layout` are absent from `package.json` |
| Build clean | yes | `bun run build` bundles `src/index.ts` |
| Typecheck clean | yes | `bun run typecheck` |
| Suite green | yes, one known unrelated baseline failure | `bun test` — 3712 pass / 1 fail; the failure is `src/perf/permission-subagent-spans.test.ts` ("records allow decision when operator approves a shell ask"), pre-existing and unrelated to the renderer |

### What "verified" can and cannot mean here

There is **no automated test that mounts `runTUI`**. Every OpenTUI test — including
the ones that exercise production wiring — mounts the `@opentui/core` test renderer,
not a real TTY. So the strongest automated evidence available is:

- **production-wired** — the test drives the same module the CLI drives
  (`product-host.ts`, `runner-host.ts`, `gate-wire.ts`, `command-surfaces.ts`,
  `stream-event-map.ts`, `observe-live.ts`, `provider-setup.ts`, `list-modal.ts`),
  with the production event/emitter shapes, on the headless renderer.
- **platform-kit only** — the test drives `shell.ts` / `overlays.ts` / `geometry.ts`
  with fixture data. Real paint on a real terminal is not covered.

Nothing below is scored on a real-TTY run. The manual size-matrix checklist at the
end of this doc is still unsigned.

## Acceptance corpus (`docs/plans/tui-layout-scroll-platform.md` §10) — re-scored

| # | Scenario | Result | Evidence | Level |
|---|----------|--------|----------|-------|
| 1 | Starved chrome: goal + tasks + agents + progress on 24 rows → transcript ≥ floor | PASS | `geometry.test.ts` (collapse order, idle floor ≥ 12, prompt floor reclaim); `chrome-state.test.ts` maps the live governor/task/agent snapshots the runner passes | production-wired for the chrome mapping, platform-kit for the layout solve |
| 2 | Permission list: 30 options, keep-active-visible, wheel scoped, close restores prompt | PASS | `overlays.test.ts` (30 options, keep-active-visible, Esc restores); `gate-wire.test.ts` (`permission.gate` opens the overlay and resolves the real approval callback) | production-wired |
| 3 | Operator question: long body + many choices, no overpaint into status | PASS | `overlays.test.ts` operator; `gate-wire.test.ts` `operator.gate` end-to-end through the emitter | production-wired |
| 4 | Prompt expand: multi-line paste, internal scroll, transcript survives | PARTIAL | `geometry.test.ts` covers prompt growth and floor reclaim. No test drives a paste into the live prompt, and image paste is unwired (see gaps) | platform-kit only |
| 5 | Stream follow: continuous tool output, auto-follow, scroll pins, jump-to-bottom | PASS | `shell.test.ts` (sticky tail, scroll-up pin, append does not yank viewport); `stream-event-map.test.ts` maps real reactor events; `product-host.test.ts` paints emitter events into the shell | production-wired |
| 6 | Queue mid-run: Enter queues, Alt+Enter steers at tool boundary, Ctrl+C interrupts | PASS | `session-queue.test.ts`, `runtime-bridge.test.ts` (queued item delivers at `tool.boundary`), `live-session-port.test.ts` (forwards to the runner's `send` / `deliver` / `interrupt`) | production-wired |
| 7 | Palette: Ctrl+O → open permissions → Esc → prompt focused | PASS | `wave6.test.ts` palette open/stack/Esc; `command-catalog.test.ts` + `command-surfaces.test.ts` for the real dispatch | production-wired |
| 8 | Copy path: Alt+C copies last assistant message without mouse | PASS | `wave6.test.ts` copy mode (freeze targets, default last, navigate, Esc cancels); `copy-path.test.ts` | production-wired for selection/formatting; the OS clipboard write itself is behind a port and is only exercised with a recording port |
| 9 | Subagent observe: enter child, scroll independently, Esc to parent, lease restored | PASS | `observe-live.test.ts` (host-supplied session, mapped production child events, Esc restores parent transcript + focus lease); `runner-host.test.ts` `observeSessionFromSubAgents` picks the newest running session | production-wired |
| 10 | Resize mid-session 80×24 ↔ 120×40, no ghost lines, prompt row stable | PARTIAL | `overlays.test.ts` resize keeps floors; `geometry.test.ts` 120×40 accrues residual to transcript. Ghost-line/paint behavior is terminal-specific and untested | platform-kit only; needs a manual run |
| 11 | Settings / help: open/close, no residual absolute paint | PASS | `wave7.test.ts` residual surfaces; `command-surfaces.test.ts` drives the settings surface against a live settings snapshot (telemetry toggle, compaction chooser, sub-agent limit) | production-wired |
| 12 | Long log: multi-thousand lines, scroll stays interactive | PASS | `long-log.test.ts` (window slice is O(window), not O(total)); `wave6.test.ts` multi-thousand append stays windowed | platform-kit only, but the budget is asserted numerically |

Two further scenarios were carried in the previous revision of this doc and are
kept because they are real surfaces:

| # | Scenario | Result | Evidence | Level |
|---|----------|--------|----------|-------|
| 13 | Model/provider picker | PASS | `model-catalog.test.ts` maps the runner's real provider config; `overlays.test.ts` model picker accept; `runner-host.test.ts` routes `models` | production-wired for select-and-apply only — connect / usage / re-auth panes do not exist (see gaps) |
| 14 | Onboarding / resume / session-mode prompt | PASS | `provider-setup.test.ts` (field flow, secret masking, connection-test failure, save-anyway, Ctrl+C aborts), `list-modal.test.ts` (accept, arrows, Esc, Ctrl+C) | production-wired — these are the modules the CLI mounts |

No scenario is marked PASS on the strength of a real-terminal run, because none was
performed.

## Parity gaps carried into production

These are real regressions against the deleted Ink shell. They are shipped, not
theoretical.

### Blocking — a normal user will hit these

1. **Built-in slash commands are not registered.** `src/tui/commands/built-in.ts`
   registers 14 commands (`help`, `model`, `settings`, `permissions`, `plugins`,
   `clear`, `new`, `rename`, `paste-image`, `mcp`, `cost`, `changelog`, `goal`, and
   the tier commands) as a module side effect, and **nothing on the production path
   imports it**. With `src/tui/runner.js` loaded, `listCommands()` returns an empty
   array. Consequence: `/clear`, `/new`, `/rename`, `/cost`, `/goal`, `/mcp`,
   `/changelog` are unreachable. `help`, `settings`, `permissions`, `plugins` and the
   model picker survive only because the palette catalog in `src/tui-opentui/palette.ts`
   carries its own residual openers.
   Re-verify with: import `src/tui/runner.js`, then call `listCommands()` from
   `src/tui/commands/registry.js` and assert the result is non-empty.
2. **Typed slash commands do not parse.** The OpenTUI send path forwards prompt text
   straight to `agent.send`. There is no `/`-prefix interception and no `/` completion
   menu, so typing `/help` sends the literal string to the model. Commands are only
   reachable through the Ctrl+O palette.
3. **Quit moved from Ctrl+C to Ctrl+D.** Ctrl+C is the interrupt key in the OpenTUI
   shell, so `mountRunnerHost` binds Ctrl+D to dispose the host. The help catalog in
   `src/tui-opentui/keybindings.ts` still documents Ctrl+D as "delete character under
   cursor" (the textarea default it overrides) — the help overlay is therefore wrong
   about the quit key. There is no exit-confirm step.
4. **`@`-mention resolution is unwired.** File mentions are not expanded before send.
   The at-mention modules under `src/tui/components/at-mention/` have no production
   importer.
5. **Image attachments are gone.** `/paste-image` reports "not available in this
   renderer yet". The OpenTUI send path is text-only; this needs an attachment
   channel on the send port, not another overlay.

### Missing surfaces

6. **Provider login modals** (codex / xAI OAuth) are unmounted. An expired provider
   profile has no in-session re-auth surface.
7. **Model surface is select-only** — no connect, usage, or re-auth panes.
8. **Plugins manager is reduced to an enable/disable toggle** — no credential form,
   no verify, no add-by-path, no web-provider override, no trust revoke.
9. **Tasks view is unmounted.** No command emits it; the `view` command result reports
   the gap.
10. **Resume and mentions surfaces exist in the platform kit only.**
    `openCommandSurface` handles `help`, `settings`, `permissions`, `plugins`, `models`
    and nothing else.

### Behavioral deltas

11. **Shift+Tab is unimplemented**, and with it the in-session auto-mode toggle. Auto
    mode is settable only via `--auto` / `--no-auto` at launch.
12. **Sent-message history recall is unimplemented.** `src/tui/sent-message-history.ts`
    survives with tests but no consumer.
13. **Alt+D word kill consumes the trailing separator**, where Ink stopped at the word
    boundary.
14. **Session mode writes global scope only.** Ink also offered a per-repo local scope.
15. **Permissions list is flat with Enter-to-revoke**, where Ink grouped by scope and
    used `d` to delete.

## Open question: orphaned `src/tui` modules

Roughly two dozen modules under `src/tui` now have **no production importer** and
survive only because co-located tests import them:

`agent-profiles.ts`, `chrome-zones.ts`, `command-display.ts`, `copy.ts`,
`exit-command.ts`, `image-attachments.ts`, `kill-ring.ts`, `mcp-view.ts`,
`mention-resolution.ts`, `model-picker.ts`, `observe-chrome.ts`, `osc8.ts`,
`prompt-layout.ts`, `quota-retry.ts`, `sent-message-history.ts`, `session-chrome.ts`,
`stall-watchdog.ts`, `stdin-filter.ts`, `streaming-markdown.ts`,
`styled-segment-props.ts`, `sync-output.ts`, `commands/built-in.ts`,
`components/at-mention/list.ts`, `components/at-mention/parse.ts`,
`components/form-reflow.ts`, `components/prompt-action-bar-label.ts`.

Each is either (a) logic that still needs rewiring into the OpenTUI host — which is
what the gap list above implies for `built-in.ts`, `mention-resolution.ts`,
`image-attachments.ts`, `sent-message-history.ts`, `kill-ring.ts`, `copy.ts`,
`observe-chrome.ts`, `session-chrome.ts`, `chrome-zones.ts`, `prompt-layout.ts`,
`streaming-markdown.ts` — or (b) dead weight from the Ink shell that should be
deleted (`stdin-filter.ts` and `styled-segment-props.ts` were written against Ink's
input pipeline and `Text` props respectively). **This has not been triaged.** A green
suite here means nothing: the tests pass because the modules are self-contained, not
because anything uses them. Sorting each module into rewire-or-delete is follow-up
work and should not be inferred from this doc.

`quota-retry.ts` and `stall-watchdog.ts` in particular carry live-run resilience
behavior that the shell no longer surfaces; losing them silently would be a
regression nobody notices until a provider throttles.

## Size matrix

| Platform | Role | How to run |
|----------|------|------------|
| macOS (darwin) | Primary interactive | run `corbits` in a real TTY at 80×24 and 120×40 |
| Linux CI | Headless gate | `bun test ./src/tui-opentui` — `@opentui/core` test renderer, no TTY |
| Geometry pure | Any | `geometry.test.ts` — no `process.stdout`; explicit columns/rows |

**Floors (constitution)**

- Idle closed overlay: transcript ≥ 12 on 80×24
- Inset overlay open: transcript ≥ 8
- Residual rows accrue to transcript, not chrome

Manual checklist — **not yet signed off by an operator**:

- [ ] 80×24 idle: status visible; prompt not clipped
- [ ] 80×24 permissions open: list scrollable; Esc restores
- [ ] 80×24 palette over permissions: Esc ×2 restores prompt
- [ ] 120×40: extra rows land in transcript
- [ ] Observe enter/leave: parent stream restored
- [ ] Ctrl+D quits cleanly; Ctrl+C interrupts a run without exiting
- [ ] Resize mid-session leaves no ghost rows

## Related

- Plan: `docs/plans/tui-layout-scroll-platform.md` (§5, §7, §10, §12)
- Cutover policy: `docs/tui-migration-cutover.md`
- Constitution: `docs/tui-layout-constitution.md`
- Interaction contract: `docs/tui-interaction-contract.md`
- Code: `src/tui-opentui/**`, `src/tui/runner.ts`
