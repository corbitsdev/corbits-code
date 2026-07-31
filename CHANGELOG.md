# Changelog

All notable changes to Corbits Code are documented here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Versions are `package.json` / `vX.Y.Z` git tags cut by `scripts/release.sh`.

## [Unreleased]

### Planned

- What's-new banner on interactive start after upgrade (CL-4604)
- Local context estimate for compaction when providers omit usage (CL-4345)
- Image age → rehydratable attachment URI (CL-4349)
- Always-return subagent salvage without a default wall-clock death clock (CL-4401)
- Transcript rendering engine with per-line damage tracking, replacing whole-frame repaints (CL-4426)

## [0.2.86] - 2026-07-30

Patch release: agents use the core tools. Every behavior change validated by a before/after eval matrix on grok-4.5 — pass rate 19/21 → 21/21, total turns 312 → 106, input tokens 2.8M → 1.1M, zero sub-agent churn on the stall fixture.

### New Features

- Built-in `web_fetch` (native fetch, markdown output, SSRF guards) and `web_search` (keyless hosted providers) replace the plugin-only web tools ([CL-4838]).
- Per-project `settings.env` supplies shell environment as configuration instead of commands.
- Model-family policy drives the directors: main sessions get a wrap-up nudge and a loud auto-pause on runaway tool-only loops; silent sub-agents get a continuation nudge then a clean stop; grok thresholds tightened ([CL-4839]).
- A shared prompt discipline block steers every model to dedicated tools, single-purpose commands, and finishing behavior ([CL-4837]).
- The capability eval is now a behavior gate: bait cases, behavior metrics, repeat runs, provider pinning with loud mismatch failure, and honest baseline comparison ([CL-4836]).

### Security

- Command substitution inside double quotes stays visible to grant replay ([CL-4825]).
- Persisted grants no longer key on model-authored comment lines ([CL-4827]).
- Chains of five or more segments are approved once only; env assignments (including `env -S` smuggling, scanned deny-first) and upload-shaped network commands now ask ([CL-4833]).

### Fixed

- Sub-agents receive the web tools and project env the prompt promises them; the family policy reaches interactive sessions; approval and error copy states thresholds and next steps.

## [0.2.85] - 2026-07-29

Patch release: shell permission hardening, sub-agent dispatch controls, and a live TUI test suite.

### Security

- Command substitution (`` `...` ``, `$(...)`) no longer auto-allows, and substituted paths stay visible to the restricted-target check ([#268](https://github.com/corbitsdev/corbits-code/pull/268)).
- Authz-hard-blocked commands deny at the gate instead of showing an Accept button ([#272](https://github.com/corbitsdev/corbits-code/pull/272)).
- Restricted targets are re-checked when replaying a stored grant ([#271](https://github.com/corbitsdev/corbits-code/pull/271)).
- Glob metacharacters are escaped in persisted exact-command grants ([#269](https://github.com/corbitsdev/corbits-code/pull/269)).
- Relative `pluginPaths` entries are dropped at trust migration instead of resolving against the launch directory ([#267](https://github.com/corbitsdev/corbits-code/pull/267)).

### New Features

- Task tiers resolve OAuth providers from the live catalog ([#262](https://github.com/corbitsdev/corbits-code/pull/262)).
- Typed task spawn contract: intent, success criteria, do-not list, report focus ([#264](https://github.com/corbitsdev/corbits-code/pull/264)), with intent-driven soft defaults for tools, tier, and turn budget ([#265](https://github.com/corbitsdev/corbits-code/pull/265)).
- Sub-agent thrash detection with re-read caps and a one-shot wrap-up nudge near the turn budget ([#263](https://github.com/corbitsdev/corbits-code/pull/263)); Grok leaf agents get a finish-bias prompt residual ([#266](https://github.com/corbitsdev/corbits-code/pull/266)).

### Fixed

- A stale approval-prompt resume no longer unfreezes a newer tool-budget pause ([#270](https://github.com/corbitsdev/corbits-code/pull/270)).
- The TUI test suite runs again (1105 tests were dark from a Bun isolate regression) ([#273](https://github.com/corbitsdev/corbits-code/pull/273)).

## [0.2.84] - 2026-07-29

Patch release: permission-approval hardening and plugin trust fixes.

### Fixed

- Tool timeout freezes while a permission prompt is open; toggle via Settings → Tools ([#261](https://github.com/corbitsdev/corbits-code/pull/261)).
- Path-added plugin trust is global, revocable from `/plugins`, and survives directory changes ([#257](https://github.com/corbitsdev/corbits-code/pull/257)).
- Install docs and package metadata point at corbits-code and the `dist/corbits` binary ([#259](https://github.com/corbitsdev/corbits-code/pull/259)).

### Changed

- Chained shell commands prompt once for the whole chain; multi-segment grants are exact-match only and the modal strips spoofing characters ([#258](https://github.com/corbitsdev/corbits-code/pull/258)).

## [0.2.83] - 2026-07-27

Patch release: reverts the inline transcript renderer.

### Fixed

- **Alternate-screen transcript restored** — the inline renderer emitted committed history into the terminal's native scrollback, so a running session could be scrolled out of, and a live tail shorter than the viewport left a large blank region between the transcript and the prompt. Reverts the differential-inline cutover ([#250](https://github.com/corbitsdev/corbits-code/pull/250)), bringing back the full-screen alternate buffer, mouse-wheel scrolling, and the app-owned viewport.

## [0.2.82] - 2026-07-26

Patch release: safety, subagent performance, TUI polish, persistence correctness, and first-class release packaging. Everything merged after `0.2.81` through `3084b44`.

### New Features

- **`corbits exec` + local capability eval harness** — non-interactive product path and fixture-based capability suite for regression gates ([#223](https://github.com/corbitsdev/corbits-code/pull/223)).
- **FIFO operator approval queue** — plan, permission, and operator modals no longer race; one gate at a time ([#236](https://github.com/corbitsdev/corbits-code/pull/236)).
- **Release packaging** — `scripts/release.sh` builds macOS/Linux binaries, checksums, debs, GitHub release assets, and Homebrew tap formula ([#244](https://github.com/corbitsdev/corbits-code/pull/244)).
- **Diff polish** — background washes on edit hunks and `+N/-M` stats on collapsed rows ([#248](https://github.com/corbitsdev/corbits-code/pull/248)).
- **Theme-routed chat chrome** — input and slash menu colors go through the theme ([#242](https://github.com/corbitsdev/corbits-code/pull/242)).

### Safety

- Scrub and truncate MCP tool results; strip terminal control sequences from tool output ([#234](https://github.com/corbitsdev/corbits-code/pull/234)).
- Secret denylist covers cloud and keychain credential shapes ([#249](https://github.com/corbitsdev/corbits-code/pull/249)).
- Fail-closed shell pre-approval: no multi-segment grants ([#220](https://github.com/corbitsdev/corbits-code/pull/220)).
- Auto-mode shell asks when the command targets paths outside the workspace ([#221](https://github.com/corbitsdev/corbits-code/pull/221)).
- Shell guard allows piped search without unblocking open-ended tree walks ([#218](https://github.com/corbitsdev/corbits-code/pull/218)).
- Reject `tool-output://` URIs before they reach ripgrep or the filesystem ([#230](https://github.com/corbitsdev/corbits-code/pull/230)).
- Constrain `@`-mention file resolution to the workspace root ([#239](https://github.com/corbitsdev/corbits-code/pull/239)).
- Allow sibling worktree paths past pre-realpath path confinement ([#245](https://github.com/corbitsdev/corbits-code/pull/245)).

### Tools

- `edit_file` line-range edits always run post-write verification ([#224](https://github.com/corbitsdev/corbits-code/pull/224)).
- Reject conflicting `edit_file` modes (substring vs line-range exclusive) ([#219](https://github.com/corbitsdev/corbits-code/pull/219)).
- Partial `grep` results on ripgrep size cap or timeout ([#231](https://github.com/corbitsdev/corbits-code/pull/231)).
- Cap long error output and show a pass/fail glyph on shell failures ([#228](https://github.com/corbitsdev/corbits-code/pull/228)).
- Coalesce stray redirect fragments back into their owning shell command ([#229](https://github.com/corbitsdev/corbits-code/pull/229) / related).

### Subagents & performance

- Cache subagent session snapshots by revision instead of cloning on every notify ([#233](https://github.com/corbitsdev/corbits-code/pull/233)).
- Dedup tool names on the `tool_call.start` path in the session store ([#243](https://github.com/corbitsdev/corbits-code/pull/243)).
- Skip retaining full turn history when no lifecycle hooks are configured ([#246](https://github.com/corbitsdev/corbits-code/pull/246)).
- Gate stream drain intervals to streaming and flush on stop ([#235](https://github.com/corbitsdev/corbits-code/pull/235)).

### Correctness

- Validate persistence boundaries with arktype and unify goal-status enums ([#226](https://github.com/corbitsdev/corbits-code/pull/226)).
- Record real cache-write token counts instead of hardcoding zero ([#237](https://github.com/corbitsdev/corbits-code/pull/237)).
- Fall back to 256-color values on non-truecolor terminals ([#240](https://github.com/corbitsdev/corbits-code/pull/240)).

## [0.2.81] - 2026-07-25

### Changed

- Rename Intercode → **Corbits Code** with `corbits` CLI hard cutover.
- Migrate legacy `.intercode` settings on first Corbits run.
- Minimal anonymous PostHog telemetry with hard opt-out (see `docs/TELEMETRY.md`).

## [0.2.80] - 2026-07-24

### New Features

- Inject full agent profile bodies into `search_agents` (CL-4325).
- Sub-agents can re-read parent `tool-output://` blobs.
- Cancel salvage and optional `task` tier override.
- Claude marketplace plugin discovery when opted in.
- Never-acted salvage when a sub-agent uses no tools.
