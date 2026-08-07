# TUI cutover readiness — post-cutover re-score

**Branch:** `migration/opentui-tui`
**Policy:** `docs/tui-migration-cutover.md` — hard cutover, no dual-ship.
**Scope of this doc:** what shipped, what was verified and how, and what parity is
still missing. It does **not** authorize a merge; it tells a reviewer exactly what
they would be merging. The merge question is live, so §"What a reviewer would be
merging today" states that plainly.

> **Last verified against the code: 2026-08-06.**
> Method: every claim below was re-checked by reading the module and symbol it
> names at branch HEAD (`f1a189c`), plus a full `bun run typecheck` and `bun test`
> on macOS. Claims that could not be demonstrated in the code were deleted, not
> softened. Nothing here is scored on a real-TTY run — see §"Real-terminal
> coverage". A prior revision of this doc carried five "blocking" items that had
> already been fixed; they are listed in §"Closed since the last revision" so a
> reader can see the history without mistaking it for the present.

## Status summary

The cutover is done. OpenTUI is the only renderer.

| Claim | State | How it was checked |
|-------|-------|--------------------|
| Interactive CLI renders with OpenTUI | yes | `src/index.ts` → `runTUI` (`src/tui/runner.ts`) → `mountRunnerHost` (`src/tui-opentui/runner-host.ts`) |
| Onboarding on OpenTUI | yes | `src/tui/onboarding.ts` → `runProviderSetup` (`src/tui-opentui/provider-setup.ts`) |
| Resume picker + session-mode prompt on OpenTUI | yes | `src/tui/pick-session.ts`, `src/tui/session-mode-prompt.ts` → `runListModal` (`src/tui-opentui/list-modal.ts`) |
| Ink tree deleted | yes | no `.tsx` file remains under `src/`; no `from "ink"` import anywhere |
| Ink/React deps removed | yes | `ink`, `react`, `yoga-layout` and friends are absent from `package.json` |
| Build clean | yes | `bun run build` bundles `src/index.ts` |
| Typecheck clean | yes | `bun run typecheck` — no output |
| Suite green | yes, one known unrelated baseline failure | `bun test` — 4217 pass / 1 fail across 315 files; the failure is `src/perf/permission-subagent-spans.test.ts` ("records allow decision when operator approves a shell ask"), pre-existing and unrelated to the renderer |

### What "verified" can and cannot mean here

There is **no automated test that mounts `runTUI`**. Every OpenTUI test — including
the ones that exercise production wiring — mounts the `@opentui/core` test renderer,
not a real TTY. So the strongest automated evidence available is:

- **production-wired** — the test drives the same module the CLI drives
  (`product-host.ts`, `runner-host.ts`, `gate-wire.ts`, `command-surfaces.ts`,
  `stream-event-map.ts`, `provider-setup.ts`, `list-modal.ts`), with the production
  event/emitter shapes, on the headless renderer.
- **platform-kit only** — the test drives `shell.ts` / `overlays.ts` / `geometry.ts`
  with fixture data. Real paint on a real terminal is not covered.

## Real-terminal coverage

**No scenario in this document has been verified on a real TTY.** Every acceptance
result below comes from the headless test renderer. The manual size-matrix
checklist at the end of this doc is **still unsigned**. Two of the twelve
acceptance scenarios (resize, and paint under an expanded prompt) are
terminal-specific by nature and cannot be closed any other way. Treat the
automated corpus as evidence that the wiring is correct, not that the shell paints
correctly on a user's terminal.

## What a reviewer would be merging today

- A complete, single-renderer OpenTUI shell that is the only interactive path:
  onboarding, resume, session-mode prompt, transcript, prompt, overlays, palette,
  permissions and operator gates, subagent observe, settings, plugins, hooks.
- Full slash-command parity with the deleted Ink registry: `registerBuiltInCommands`
  is on the production path, typed `/` commands parse, and the palette is a second
  route to the same catalog.
- `@`-mentions, image attachments, sent-message recall, and a keyboard copy path.
- Four known open items, all in §Blocking or §Behavioral deltas below: mouse
  selection policy (CL-5540), paste in real terminals (CL-5541), test-renderer
  lifetime in CI (CL-5539), and Shift+Enter on terminals that do not report the
  modifier.
- An unsigned manual size matrix.

## Acceptance corpus (`docs/plans/tui-layout-scroll-platform.md` §10) — re-scored

| # | Scenario | Result | Evidence | Level |
|---|----------|--------|----------|-------|
| 1 | Starved chrome: goal + tasks + agents + progress on 24 rows → transcript ≥ floor | PASS | `geometry.test.ts` (collapse order, idle floor ≥ 12, prompt floor reclaim); `chrome-state.test.ts` maps the live governor/task/agent snapshots the runner passes | production-wired for the chrome mapping, platform-kit for the layout solve |
| 2 | Permission list: 30 options, keep-active-visible, wheel scoped, close restores prompt | PASS | `overlays.test.ts` (30 options, keep-active-visible, Esc restores); `gate-wire.test.ts` (`permission.gate` opens the overlay and resolves the real approval callback) | production-wired |
| 3 | Operator question: long body + many choices, no overpaint into status | PASS | `overlays.test.ts` operator; `gate-wire.test.ts` `operator.gate` end-to-end through the emitter | production-wired |
| 4 | Prompt expand: multi-line paste, internal scroll, transcript survives | PARTIAL | `geometry.test.ts` covers prompt growth and floor reclaim; `prompt-features.test.ts` covers bracketed paste into the live prompt. The user-reported paste failure in a real terminal (CL-5541) is not reproduced by any test | platform-kit only |
| 5 | Stream follow: continuous tool output, auto-follow, scroll pins, jump-to-bottom | PASS | `shell.test.ts` (sticky tail, scroll-up pin, append does not yank viewport); `stream-event-map.test.ts` maps real reactor events; `product-host.test.ts` paints emitter events into the shell | production-wired |
| 6 | Queue mid-run: Enter queues, Alt+Enter steers at tool boundary, Ctrl+C interrupts | PASS | `session-queue.test.ts`, `runtime-bridge.test.ts` (queued item delivers at `tool.boundary`), `live-session-port.test.ts` (forwards to the runner's `send` / `deliver` / `interrupt`) | production-wired |
| 7 | Palette: Ctrl+O → open permissions → Esc → prompt focused | PASS | `wave6.test.ts` palette open/stack/Esc; `command-catalog.test.ts` + `command-surfaces.test.ts` for the real dispatch | production-wired |
| 8 | Copy path: Alt+C copies last assistant message without mouse | PASS | `wave6.test.ts` copy mode (freeze targets, default last, navigate, Esc cancels); `copy-path.test.ts`, `system-clipboard.test.ts` | production-wired for selection/formatting; the OS clipboard write itself is behind a port |
| 9 | Subagent observe: enter child, scroll independently, Esc to parent, lease restored | PASS | `observe-live.test.ts` (host-supplied session, mapped production child events, Esc restores parent transcript + focus lease); `runner-host.test.ts` `observeSessionFromSubAgents` picks the newest running session | production-wired |
| 10 | Resize mid-session 80×24 ↔ 120×40, no ghost lines, prompt row stable | PARTIAL | `overlays.test.ts` resize keeps floors; `geometry.test.ts` 120×40 accrues residual to transcript. Ghost-line/paint behavior is terminal-specific and untested | platform-kit only; needs a manual run |
| 11 | Settings / help: open/close, no residual absolute paint | PASS | `wave7.test.ts` residual surfaces; `command-surfaces.test.ts` drives the settings, permissions, plugins and hooks surfaces against a live settings snapshot | production-wired |
| 12 | Long log: multi-thousand lines, scroll stays interactive | PASS | `long-log.test.ts` (window slice is O(window), not O(total)); `wave6.test.ts` multi-thousand append stays windowed | platform-kit only, but the budget is asserted numerically |
| 13 | Model/provider picker | PASS | `model-catalog.test.ts` maps the runner's real provider config; `overlays.test.ts` model picker accept; `runner-host.test.ts` routes `models` | production-wired for select-and-apply only — connect / usage / re-auth panes do not exist (see gaps) |
| 14 | Onboarding / resume / session-mode prompt | PASS | `provider-setup.test.ts` (field flow, secret masking, connection-test failure, save-anyway, OAuth login step, Ctrl+C aborts), `list-modal.test.ts` (accept, arrows, Esc, Ctrl+C) | production-wired — these are the modules the CLI mounts |

No scenario is marked PASS on the strength of a real-terminal run, because none was
performed.

## Blocking — a normal user will hit these

1. **Paste is reported broken in a real terminal (CL-5541).** Bracketed paste
   verifies in the harness (`prompt-features.test.ts`) and Ctrl+V / Ctrl+P image
   attach is wired (`attachClipboardImage` in `src/tui-opentui/shell.ts`, bound in
   the shell's key handler), but the reported real-terminal failure is not
   reproduced or explained. Until someone pastes into a real TTY, treat text paste
   as unverified.
2. **Mouse selection policy (CL-5540).** DEC mouse reporting defaults on in
   the main shell (`useMouse` in `src/tui-opentui/product-host.ts:218`), so
   wheel scroll and click-to-expand work out of the box. The cost is native
   text selection, which the terminal cannot perform while reporting is on;
   `Alt+M` (`toggleMouseCapture` in `src/tui-opentui/shell.ts:4006`) hands the
   mouse back for that. The satellite pickers (`list-modal.ts`,
   `provider-setup.ts`) keep reporting off and are unaffected. This is the
   settled decision, not a pending tradeoff.
3. **Shift+Enter does not insert a newline on terminals that do not report the
   modifier.** `Ctrl+Enter` and `Ctrl+J` are the working newline chords and the
   help catalog says so (`src/tui-opentui/keybindings.ts`). The kitty keyboard
   protocol path was verified end to end, so this is terminal reporting, not a
   decode defect — but a user on a plain terminal who reaches for Shift+Enter will
   send the message.
4. **The manual size matrix is unsigned.** See §Real-terminal coverage. This is a
   process gap, not a code gap, but it is the single largest unknown in this
   document.

## CI risk

**CL-5539 — test renderers are never freed.** `withTestRenderer`
(`src/tui-opentui/harness.ts:157`) destroys the renderer in a `finally`, but 15
call sites across 9 test files still call `createHarness` directly and never
destroy: `runner-host.test.ts` (6), `provider-setup.test.ts` (2), and one each in
`list-modal.test.ts`, `copy-wire.test.ts`, `harness.test.ts`,
`focus-routing.test.ts`, `product-host.test.ts`, `reasoning-fold.test.ts`,
`zz-paste-probe.test.ts`. On a fast macOS machine the current run emits zero
`Failed to create renderer` errors, so the leak is latent locally; on a 2-core CI
runner it has turned into a cascade of failures. Fix in flight. Do not read a
green local run as evidence CI is safe.

## Missing surfaces

1. **In-session provider re-auth is unmounted.** `runProviderSetup` handles OAuth
   during onboarding (`OAUTH_STEPS` in `src/tui-opentui/provider-setup.ts:78`), but
   an expired profile mid-session has no re-auth surface.
   `src/tui-opentui/provider-connect.ts` has no importer at all.
2. **Model surface is select-only.** `openCommandSurface`'s `models` case
   (`src/tui-opentui/command-surfaces.ts:915`) delegates to `openModels` and
   nothing else — no connect, usage, or re-auth panes.
3. **Tasks view is unmounted.** `applyCommandResult`'s `view` case
   (`src/tui/runner.ts:1796`) prints "not available in this renderer yet". No
   built-in command currently returns a `view` result, so nothing reaches it today,
   but the surface does not exist.
4. **Non-model modals print a placeholder.** `applyCommandResult`'s `modal` case
   (`src/tui/runner.ts:1790`) routes `agent` to the model picker and reports every
   other modal as unavailable.

## Behavioral deltas against the deleted Ink shell

1. **Shift+Tab is unimplemented**, and with it the in-session auto-mode toggle.
   Nothing in `src/tui-opentui/` binds it; the only references are the stale
   comments at `src/config/index.ts:388` and `src/permission/gate.ts:253`. Auto
   mode is settable only via `--auto` / `--no-auto` at launch.
2. **Session mode writes global scope only.** `promptSessionModeIfUnset`
   (`src/tui/session-mode-prompt.ts`) calls `saveGlobalSettings`; Ink also offered a
   per-repo local scope.
3. **Permissions list is flat with Enter-to-revoke**
   (`command-surfaces.ts:518`, title "permissions · Enter revokes"), where Ink
   grouped by scope and used `d` to delete.
4. **Markdown flickers mildly while streaming.** The one deterministic cause — a
   bare `####` painting as literal text before its heading text arrives — is fixed
   with a regression test (`markdown-rows.test.ts:126`). Residual flicker is
   reported but not characterized.

## Orphaned modules

The renderer rewrite moved most of the former `src/tui` platform code into
`src/tui-opentui`. What is genuinely unreferenced by any production path today:

- `src/tui/kill-ring.ts` — superseded by `src/tui-opentui/prompt-kill-ring.ts`.
- `src/tui-opentui/provider-connect.ts` — the unmounted re-auth surface above.
- `src/tui-opentui/demo.ts`, `smoke.ts`, `harness.ts` — developer entry points, not
  product code.
- `src/tui-opentui/observe-map.ts` — observe mapping now lives in `runner-host.ts`
  (`observeSessionFromSubAgents`, line 187).

Everything else the previous revision listed as orphaned has since been either
rewired or deleted. This list was regenerated mechanically on 2026-08-06 by
resolving every `src/tui/**` and `src/tui-opentui/**` module against its
non-test importers; regenerate it the same way rather than editing it by hand.

## Closed since the last revision

Kept only so a reader who saw the previous revision does not re-file these. All
were verified fixed on 2026-08-06.

| Was claimed | Actual state |
|---|---|
| Built-in slash commands are not registered | `runner.ts:84` imports `registerBuiltInCommands`; `runner.ts:351` calls it inside `setUpCommandRegistry`, which `runner.ts:398` invokes. All 15 built-ins register, including `hooks`. |
| Typed `/` commands do not parse and are sent to the model | `runner.ts:271-272` intercepts the leading `/`; `shell.ts` opens a completion list at an empty prompt (see the `/` row in `keybindings.ts`). |
| `@`-mention resolution is unwired | `ingestPathMentions` at `runner.ts:1821`, `resolveAtMentions` at `runner.ts:1822`, `setMentionSuggestionSource` at `runner.ts:2099`. |
| Image attachments are gone; `/paste-image` reports "not available" | `runner.ts:1799` routes `paste-image` to `attachClipboardImage`; `readClipboardImage` feeds `shell.pendingAttachments` (`shell.ts:824`), bound to Ctrl+V and Ctrl+P. |
| Help catalog documents Ctrl+D as "delete character under cursor" | Correct: the host claims no quit key, so Ctrl+D is the prompt default. Quitting is Ctrl+C twice. |
| There is no exit-confirm step | Ctrl+C arms a 2-second exit window and quits on a second press (`CTRL_C_EXIT_WINDOW_MS`, `shell.ts:3843`). |
| `quota-retry.ts` / `stall-watchdog.ts` have no production importer | Both moved to `src/tui-opentui/` and are imported by `runtime-bridge.ts:35,40`; `product-host.ts:232` opts the host into their timers. |
| Sent-message history recall is unimplemented | `shell.ts:45` imports `src/tui/sent-message-history.ts`; `runner.ts` appends every sent prompt and Up/Down recall is in the help catalog. |
| Plugins manager is an enable/disable toggle only | `command-surfaces.ts` carries a credential-entry pane (`openCredentialsPane`, line 562), trust state, and a web-provider override. |
| Two dozen `src/tui` modules are orphaned | Regenerated; see §Orphaned modules. Four modules remain. |

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
- [ ] Ctrl+C interrupts a run, and twice in a row exits cleanly; Ctrl+D only deletes a character
- [ ] Resize mid-session leaves no ghost rows
- [ ] Paste multi-line text into the prompt (CL-5541)
- [ ] Drag-select and copy transcript text with the mouse; `Alt+M` restores click-to-expand (CL-5540)

## Related

- Plan: `docs/plans/tui-layout-scroll-platform.md` (§5, §7, §10, §12)
- Cutover policy: `docs/tui-migration-cutover.md`
- Constitution: `docs/tui-layout-constitution.md`
- Interaction contract: `docs/tui-interaction-contract.md`
- Code: `src/tui-opentui/**`, `src/tui/runner.ts`
