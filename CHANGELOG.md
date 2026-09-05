# Changelog

All notable changes to Corbits Code are documented here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Versions
are `package.json` / `vX.Y.Z` git tags cut by `scripts/release.sh`.

**This file is the only release-notes source.** `/changelog` and the shipped
binary read it; `scripts/release.sh` builds the GitHub release body from the
matching `## [X.Y.Z]` section (plus install instructions). Do not maintain
parallel copies under `docs/` or `scripts/notes/`. At cut time: rename
`## [Unreleased]` to `## [X.Y.Z] - YYYY-MM-DD`, then run the release script.

## [Unreleased]

### Added

- Native-integration skill: Corbits runtime mapping for GaaS skill bodies (tools, fleet, non-git folders, GitHub review posting, tracker-agnostic issues). Baked on workers; `use_skill` on the primary. Not a slash.

### Changed

- Drop unused `@opentui/keymap`, `@opentui/solid`, and `solid-js`. The interactive TUI is imperative `@opentui/core` only.
- Align /create-issue phases and # Background / # Outcome format with GaaS linear-create. Slash stays /create-issue. Tracker selection stays (Linear MCP first, else GitHub/GitLab/MEMORY.md).
- Restore the /review skill body 1:1 with GaaS code-review. Slash stays /review. GitHub posting, Linear In Review, ask_operator, and findings-only stay on native-integration.
- Restore the scribe skill 1:1 with GaaS. ask_operator mapping stays on native-integration. Slash /scribe remains.
- Restore the ast-grep skill 1:1 with GaaS. run_shell mapping stays on native-integration. Slash /ast-grep remains.
- Restore the opsh skill 1:1 with GaaS. Tool/shell mapping stays on native-integration. user-invocable: false stays so it remains use_skill-only.
- Restore the pull-request-review skill 1:1 with GaaS. ask_operator, /review mapping, and GitHub posting stay on native-integration. Slash /pull-request-review remains.
- Restore the refactor skill 1:1 with GaaS. ask_operator mapping stays on native-integration. Slash /refactor remains.
- Ignore GaaS opsh, refactor, scribe, ast-grep, and review SKILL.md in prettier so GaaS emphasis/table alignment stays 1:1.
- Restore the git-rebase skill body 1:1 with GaaS. Intern execution recipe stays on native-integration. user-invocable: false stays so it remains use_skill-only.
- Restore the linear-issue-workflow skill body 1:1 with GaaS. Claim-first, In Review, and git-worktrees extras stay on native-integration. user-invocable: false stays so it remains use_skill-only.
- Restore the interview skill body 1:1 with GaaS (AskUserQuestion). Operator-ask mapping stays on native-integration. Slash /interview remains.
- Restore the implement skill body 1:1 with GaaS (TaskCreate, @greybeard, Acknowledgment). Tool-name mapping stays on native-integration. Slash /implement remains.
- Restore the typescript skill body 1:1 with GaaS. bun:test vs tap mapping lives on native-integration. user-invocable: false stays so it remains use_skill-only.
- Restore the philosophy skill body 1:1 with GaaS (including the review acknowledgment). `user-invocable: false` stays so it remains use_skill-only.
- Restore the style skill body 1:1 with GaaS (including the git-repo requirement and review acknowledgment). Non-git-folder policy stays on native-integration. `user-invocable: false` stays so it remains use_skill-only.

### Fixed

- Headless `corbits exec` now registers the active run so SIGINT/SIGTERM/SIGHUP finalize `run.json`.

## [0.3.15] - 2026-09-04

### Added

- Sub-agent admission queue: `spawn_agent` never refuses for worker count.
  Excess dispatches report `queued` until a burst slot is free. Nested children
  of an already-admitted parent bypass the burst window (not a 429 pause).
  Capacity changes never cancel in-flight work.
- Builder and critic bake a compact less-is-more quality bar (`idiot-proof`:
  deletion, reuse, clean only files you already touch, read first). It is not a
  slash and is not listed for `use_skill`. Critic flags correctness plus hygiene
  the diff introduced and still never implements. Skywalker no longer treats
  that hygiene lens as over-engineering theater.

### Changed

- Collapse the three runtime bootstraps into shared session assembly.
- Skywalker's prompt no longer states a hard cap of 4 workers. Fan-out width
  follows independent lanes; the runtime queues excess rather than refusing.
- Wait/list status includes live `queued`. Resume/followup inference is admitted
  through the same queue.
- Retryable provider 429s freeze new admits via the shared retry remapper.
  `quota_exhausted` does not freeze.
- Skywalker and primary orchestration guidance no longer invite auto-starting
  the next worker after an unfinished specialist.
- Cancelled salvage asks the parent to synthesize Findings and wait for the
  operator instead of auto-starting another specialist.
- Interactive TUI pins OpenTUI 0.5.10 (`@opentui/core`, keymap, solid, and native platform packages in lockstep).
- `bun run check` now runs the full test suite with the same seed CI uses
  (`--randomize --seed 424242`), so a local green can no longer mask a CI test
  failure. CI's test job invokes the same `check:projects-dir-guard` script
  instead of duplicating the test command, and the projects-dir guard no longer
  squats on the `test` script name.
- Implement/review `spawn_agent` dispatches (and their default
  directors) fail closed without non-empty `success_criteria`;
  children stay blank.
- Workers can ask their spawning director via `ask_director` when a brief is
  ambiguous. `wait_agents` returns `awaiting_director` with the question;
  soft `send_input` answers it. The operator is not in that loop unless the
  director escalates. Workers still cannot call `ask_operator`.
- Spawned workers are called fleet agents, not leaves. Director packages still
  use `tier: "leaf"` as the runtime mount key.
- Agents and contributor docs move Linear issues to In Review when a PR is ready
  for review.

### TUI

- `/plugins` uninstalls user, project, and path-installed plugins with Alt+X.
  Bundled plugins disable only and stay listed. Claude marketplace plugins
  disable in settings without deleting `~/.claude`. The screen opens with a
  how-to header.
- Operator-question and permission choice labels wrap instead of collapsing
  behind a middle ellipsis. `ask_operator` rejects option labels over 48
  characters so rationale stays in the transcript.

## [0.3.14] - 2026-09-03

### Changed

- Authorization and approval display now use one shared command-segmentation
  implementation, preventing the two views from drifting while keeping executable
  pipeline payloads visible.
- macOS Finder `.DS_Store` metadata is ignored throughout the repository.

### Fixed

- OAuth, xAI, and Codex credential-store updates are serialized so concurrent
  sessions cannot drop profiles or overwrite refreshed tokens.
- Path-restriction cache entries are invalidated when symlink resolution changes,
  preventing stale workspace decisions after filesystem mutation.
- Project-scoped grants cannot replay in a different workspace even when the
  request working directory matches the foreign grant.

## [0.3.13] - 2026-09-01

### Changed

- Implementation-worker guidance requires repository-defined typechecks, relevant
  tests, and every defined full verification command, with exact outcomes and exit
  statuses reported. Skywalker guidance requires Critic review after delegated
  Builder work and Greybeard review when architecture is in play.
- Sub-agent guidance describes completion in terms of the dispatch done-definition
  rather than a fixed inference-turn budget.

### Fixed

- Empty chat turns settle with a valid empty reply instead of ending in a fatal
  reactor error, while preserving checkpoint actions.
- Terminal provider failures show a sanitized category and upstream diagnostic in
  TUI and headless runs without duplicate or stale notices. Sub-agent failures
  return a sanitized category and recovery guidance without exposing upstream
  diagnostics.
- OpenCode Go normalizes null response-delta `role` and `tool_calls` fields before
  strict OpenAI parsing; malformed non-null values remain rejected.

## [0.3.12] - 2026-09-01

### TUI

- `/connect` opens Add Provider from any layout.
- Option+A still opens Add Provider. Terminals that emit å/Å for Option+A
  without the option modifier also open it in `/model` (US/ABC compose).
  Dedicated Nordic å in `/model` is treated as that shortcut when Add
  Provider is offered.

### Breaking

- `task` is removed. Use `spawn_agent` to start workers and `wait_agents` to
  collect reports; `search_agents` profile ids now dispatch through
  `spawn_agent(agent=...)`.

### Changed

- Cancelling a spawned worker or `wait_agents` reports wait status
  `interrupted`, not `failed`.
- Inference no longer fails over to a backup provider. A selected-provider
  failure stays on that provider; switch with `/model`.

### Fixed

- Codex ChatGPT subscription sessions no longer show a public-rate dollar
  cost estimate. Hide follows the live provider identity after `/model`
  switches, not the launch base URL. Coding-plan (Z.AI) hide uses the same
  live-identity rule. Context usage and `/cost` still work; `/cost`
  reports Codex cost as covered by ChatGPT subscription. Metered OpenAI
  API endpoints keep dollar estimates.
- CLI `--help` / `-h` is recognized in any argument position. Value flags no
  longer swallow `--*` or `-h` as their option values.
- `wait_agents` no longer collects a stale completed or interrupted stamp
  when a followup is already in flight.
- `interrupt_agent` flips the wait mailbox so soft interrupt unblocks
  `wait_agents` while the background run is still in flight.
- Credential-refresh and auth send failures tell the user to log in again
  instead of suggesting `/model`.

## [0.3.11] - 2026-08-31

### Changed

- Completing a workflow step is a `submit_output` tagged with that step's id.
  `advance_workflow` is gone. Already-complete and not-current ids are
  acknowledged without advancing. The unused `autoAdvance` workflow field is
  removed.
- `resume_agent(target, message)` starts the next turn on a retained completed
  or interrupted worker and returns immediately. `wait_agents` collects the
  reply. `send_input` steers only an in-flight running turn. Closed workers
  stay closed.
- `corbits resume` orders sessions by last persist. The picker shows the 10
  most recent sessions and type-to-filter narrows that list. Default rows are
  running and cancelled; `--force` includes failed and done.

### TUI

- `/yolo` is listed on the landing screen and on permission prompts.
- Git fatal stderr stays off the TUI when the working directory is not a
  repository.

### Fixed

- Mid-run Enter delivers a steer into the live reactor (`Agent.deliver`)
  instead of starting a second `send`. `/clear` and `/new` drop queued
  input so it cannot land in the next session.
- Failed sessions with an `error` string in `run.json` are valid resume
  candidates, not corrupt files. A truly unreadable session id prints one
  recovery line; parse diagnostics go to the structured log, not the
  terminal. Renaming a session does not overwrite an unreadable `run.json`.
- `ask_operator` no longer pre-authorizes a model-authored shell command when
  the operator picks any option, including Reject. Clarification choices
  cannot mint shell grants.
- Live `/model` switches refresh inference, permission identity, grant
  persistence identity, and advertised tool schemas together. A grant for the
  previous model no longer covers the same action, new grants store under the
  new pair, and Kimi/Moonshot sessions get non-recursive `present` schemas
  immediately (canonical schemas restore when switching away).
- A failed write of a project, global, or provider-model approval no longer
  crashes the session. The grant still applies in memory, the approved tool
  call still completes, and the operator is told remember did not stick.

## [0.3.10] - 2026-08-30

### Fixed

- Session durability checkpoints use the operator's git `user.name` and
  `user.email` when both are set, so allowlisted commit-author hooks no
  longer fail every tool cycle. Machines without a git user still fall
  back to the Interchange harness identity.
- First-run welcome plays the mountain once and holds the filled
  silhouette until continue or auto-advance. The product line is hidden
  on narrow terminals instead of wrapping mid-word.

## [0.3.9] - 2026-08-29

### Fixed

- First-run onboarding shows the orange mountain welcome and local software
  factory intro before opening provider and model setup.

## [0.3.8] - 2026-08-28

### TUI

- `ask_operator` is an inset overlay again so the transcript stays visible while
  the operator answers.
- The `full_shell` overlay mode is removed; every overlay is inset.

### Fixed

- Homebrew release reruns preserve legacy formula rename mappings so old
  `corbits` installs keep migrating to `corbits-code`.
- First-run onboarding preserves OAuth profile projection when started with
  CLI `--config`.
- Settings paths no longer collide when Corbits starts from home or an aliased
  config location; OAuth and model choices recover without writing credentials
  into settings.
- OpenAI OAuth credentials stay staged until setup validation succeeds;
  definitive scope and credential failures are not saved, including via Ctrl+S.
- Known Codex short HTTP 429s normalize to retryable rate limits, while true
  `usage_limit_reached` responses keep quota copy with reset and profile hints;
  terminal credential failures tell operators to log in again.
- Same-turn failover retracts recovered inference error rows instead of leaving
  quota or session-expired lines in the chat.
- Interrupted workers linger on the agents strip for the normal window then
  drop, and no longer inflate sticky clocks or fleet-running counts.

## [0.3.7] - 2026-08-27

### Fixed

- `web_fetch` failures now return the same complete result shape and content
  regardless of whether the default Exa provider or native fetch handles them.

## [0.3.6] - 2026-08-27

### Fixed

- The default Exa-backed `web_fetch` once again enforces HTTP(S)-only URLs and
  per-call timeouts, returns the requested markdown, text, or HTML format, and
  preserves the native tool's public result and error semantics.

## [0.3.5] - 2026-08-27

### MCP

- Exa is now a built-in MCP server enabled by default, connecting without an API
  key to the external `https://mcp.exa.ai/mcp` service. Web requests handled by
  this preset are sent to Exa and are subject to Exa's privacy practices, network
  availability, and anonymous rate limits. Disable it with
  `mcpServers.exa.enabled: false`, or override `mcpServers.exa` with a custom
  transport-bearing server entry.

## [0.3.4] - 2026-08-26

### Telemetry

- Ambient telemetry emits one parent generation per turn with aggregated tool and
  subagent counts, rolls worker usage into one terminal event per dispatch, and
  makes per-call spans opt-in. Ambient events use anonymous processing,
  successful generations support sampling while failures always ship, plugin
  loads deduplicate, and pre-usage fallback failures avoid stale provider
  attribution. A deterministic representative fleet fixture drops from 98 to 18
  billable events, an 81.6% reduction.

## [0.3.3] - 2026-08-25

### TUI

- Idle-with-fleet is real: after Skywalker dispatches workers with `spawn_agent`
  and ends its turn, the session holds itself open while they run. Enter starts
  a new primary turn immediately instead of queueing a soft-steer behind a
  parent tool that no longer exists; Alt+Enter follow-ups still wait for true
  session-idle (parent idle and no live fleet lanes), delivering the moment the
  last worker terminalizes. Ctrl+C stop policy is unchanged.

## [0.3.2] - 2026-08-25

### Agent

- Closed directors are named entities (`skywalker`, `builder`, `explorer`, `counsel`,
  `intern`, `critic`, `greybeard`, and the rest of `DIRECTOR_IDS`) instead of generic
  role ids. Write tools are mounted on every closed director; Skywalker DIYs tiny
  single-file edits and spawns specialists for substantial work. Fleet verbs
  (`spawn_agent`, `wait_agents`, `search_agents`, …) stay on the primary only.
- `spawn_agent` can isolate a worker in a git worktree, pass a tool allowlist, and
  allow nested spawn where the director's spawn rights permit it. `task()` is now
  a fused spawn-plus-wait wrapper around that path — still works, still deprecated
  for new call sites.
- New fleet verbs: `list_agents` (this caller's uncollected workers only) and
  `send_input` (steer a running worker without completing `wait_agents`).
  `wait_agents` is scoped to the caller, unblocks immediately on interrupt/close,
  and no longer waits on a sibling orchestrator's fleet. Interrupted workers that
  still have tools in flight stay inspectable instead of looking idle.
- Cancelled and salvaged workers keep Findings and Paths in the parent-facing
  report. `wait_agents` now sees those salvage records when the parent cancels
  mid-wait.
- Finished leaf workers stop re-inferring after they have already produced a
  report reply. Optional first-party skill bodies are baked into worker director
  prompts so leaves do not have to `use_skill` to load them.
- Skywalker is an idle orchestrator: fire `spawn_agent`, tell the operator who is
  running, then wait — do not fuse into a long `task()` after spawn. Linear work
  must be set In Progress before explore/build thrash.
- Director system prompts (Skywalker, Builder, Explorer, Counsel, Intern, Critic,
  Greybeard, Neckbeard, Bruckheimer, Gaasbot, Draper, Emil, Rand, Shakespeare,
  Testsmith, Tester) and first-party skills (style, philosophy, typescript,
  implement, interview, review, create-issue) were rewritten as current-code
  playbooks. The dispatch skill is gone; Skywalker orchestrates natively.

### TUI

- `ask_operator` uses a full-shell overlay instead of a cramped inset, so the
  question and options are readable on a normal terminal.
- One-shot confirmation flashes (copy, mouse toggle, attach results, reasoning
  effort, stall recovery) now clear themselves after a short TTL. Rate-limit
  waits no longer park on the bottom notice row; the durable error stays in the
  transcript. Live stall notice and landing hold still omit a TTL so they stay
  until replaced.
- Decision-overlay orange is calmer: only the dithered subject spends the accent.

### Fixed

- Responses API cache tokens are no longer double-counted in context occupancy,
  so the fill bar and compaction threshold match actual window use.
- Resume skips mid-file interleaved garbage in `turns.jsonl` instead of aborting
  the session load.
- Oversized tool results pretty-spill into session files and return a
  `tool-output:///` URI (plus an on-disk path when plumbed) instead of a raw
  truncated blob.
- A TTL flash no longer paints chrome after the TUI renderer is destroyed, which
  crashed parallel TUI tests with `TextBuffer is destroyed`.
- Session `stopReason` is set from the typed `ForcedStopReason` only, not from
  free-form strings.

### Security

- **Shell chain approvals no longer skip minting once a chain gets long.**
  Chains of 5+ segments used to be accept-once only — no grant was ever
  persisted, so the same long chain re-prompted every single time no matter
  what had already been approved. Approving a multi-segment chain now mints
  one grant per real segment instead of one grant for the whole string, so
  approving `a && b` also covers `b` on its own later, and long chains behave
  the same as short ones. This is a real change in what a single approval
  buys: granting per segment is strictly more permissive on later commands
  than granting one exact whole-string match was, since a segment now reuses
  outside the chain it was first approved in. Nothing that previously
  auto-approved now prompts, and nothing that previously required a fresh
  decision now silently skips one — chains still ask for any segment that
  isn't already granted.
- Nested interpreter peels (`bash -c 'python -c …'`) that used to misparse and
  auto-allow now fall through to ask.
- Secret-guard denylist paths are realpath'd so a symlink cannot bypass the
  deny under `/yolo` or `--dangerously-skip-permissions`.

### Changed

- First-party skills are how-to playbooks (what to do, in what order, what done
  looks like), not director personas. Identity stays on director system prompts.

## [0.3.1] - 2026-08-24

### Fixed

- Retained worker sessions (`spawn_agent`, resumable via `resume_agent`) now have their own
  retention cap, separate from the TUI's finished-session display cap. Previously they shared that
  20-item cap, so `resume_agent` on an early worker failed with a bare `not_found` once a fan-out
  of more than 20 workers had finished. A session dropped by the retention cap still releases its
  sidecars/reactor/lock entry, always evicts least-recently-used first, and never evicts a running
  session. `resume_agent` against an evicted session now reports its terminal status plus a pointer
  to `read_agent_trace`, instead of `not_found`.

## [0.3.0] - 2026-08-24

### Breaking

- **Turn budgets are gone entirely.** `settings.subagentMaxTurns`, `AgentProfile.maxTurns`, and
  the `maxTurns` argument on `task()` / `spawn_agent` no longer exist. Unknown config keys are
  ignored rather than rejected, so an existing `corbits.json` carrying `maxTurns` will load
  without error and simply stop having any effect. A run now ends on the model's own finish
  signal, an operator interrupt, or a hard error.
- **`AgentProfile.fleetTier` removed** — it was declared but never populated by any loader.
- **`task()` is deprecated** in favour of `spawn_agent` / `wait_agents`. It still works and much
  still routes through it; it will be removed in a later release.
- **Eval harness:** the global soft turn-budget rubric (`--max-turns`, `maxTurns` in case files,
  `overBudget`) is removed. `--agent-timeout-ms` remains as the per-eval bound.

### Agent

- Deleted the sub-agent turn-budget mechanism entirely: `maxTurns` is gone
  from `task()`, `spawn_agent`, `AgentProfile`, director packages'
  `nudge.maxTurns`, and `settings.subagentMaxTurns`; a leaf now runs until it
  produces a report envelope, is cancelled, hits an opt-in wall-clock
  deadline, or stalls — never on a turn count. Removed
  `resolveSubAgentMaxTurns` / `resolveDefaultSubAgentMaxTurns` /
  `clampSubAgentMaxTurns` / `validateTaskMaxTurns` (`src/config/settings.ts`),
  the `turn-budget` stop reason and its report text/parent hint, the
  near-budget `report-forced` wrap-up nudge, and the re-dispatch ledger's
  turn-budget branch (the `higher maxTurns` / re-dispatch-cap hints). This
  also retires the `spawn_agent`/`task()` `nudge.maxTurns` parity fix shipped
  an hour prior — with the mechanism itself gone, that parity is moot.
  `task()` is now marked deprecated in favor of `spawn_agent` + `wait_agents`
  for new call sites; it is not removed since most dispatch still routes
  through it. Removed the false "hard cap 4 workers" claim from director
  prompt text (no such cap exists anywhere in the fleet code). The unused
  `maxTurns` field on project/named profile files (`.corbits/profile.json`,
  `~/.corbits/profiles/<name>.json`) has been removed since nothing read it —
  a silently-ignored knob is worse than no knob. If a run needs stopping, the
  operator interrupts it (`interrupt_agent`) rather than the harness enforcing
  a count.

- Added `interrupt_agent({ target })` and `resume_agent({ target, message })`,
  the second half of reusable worker sessions: `interrupt_agent` stops a
  retained worker's current turn while keeping it and its context alive
  (distinct from the permanent `close_agent`), and `resume_agent` sends new
  work into a retained worker's existing session, reusing its prior context
  and tool outputs rather than starting fresh. Both are gated to orchestrator
  tiers via the existing fleet-verb mechanism, denied to leaves. `interrupt_agent`
  fires a signal scoped only to the in-flight `agent.send()` call, never
  `close()`, so it cannot hit the close()-ordering workdir-lock issue tracked
  separately — the underlying reactor cycle keeps running in the background
  (there is no lower-level stop primitive for that in the vendored agent), so
  this is an approximation: it stops the caller from waiting, not the
  worker's compute.
- `evaluateSubAgentStop` now always requires the final assistant text; the
  omitted-text branch that unconditionally completed a tool-less turn is
  removed, so every call path gets the `incomplete-report` nudge and salvage
  when a tool-using run ends in envelope-less narration.
- `spawn_agent` no longer refuses a second concurrent implement-intent spawn
  against the same working directory — running multiple agents against one
  worktree is allowed by design, and the refusal was guarding against churn
  that resolves on its own, not corruption.
- `fleetRecords` (the store behind `wait_agents`) now caps how many full
  reports it holds in memory; past the cap, the oldest report already
  delivered to a caller is compacted to a status-only tombstone pointing at
  `read_agent_trace` for the detail, so an uncollected report is never
  evicted ahead of one that's already been picked up.
- Worker sessions spawned via `spawn_agent` now persist after their turn ends
  instead of being torn down: a clean completion leaves the session open and
  reusable. Added `close_agent(target)` to permanently close a session
  (descendants closed first, bounded by a ~30s cleanup deadline per session
  so a wedged descendant cannot hang the call) and `resume_agent(id)` to
  reopen a retained, completed session. Sessions now carry an explicit
  lifecycle status (`pending_init | running | interrupted | completed |
  shutdown | not_found`) alongside the existing display status.
- Fixed four resource-leak / false-success bugs in the retained-session
  lifecycle above: a retained session is now released (its close handle
  invoked, its reactor and LSP sidecars torn down) once it falls out of the
  same finished-session cap every other session already used, instead of
  being exempt from any bound; `cancelAll` and session teardown (`/clear`,
  closing a session) now release every still-open retained session, not
  only ones still mid-turn; `close_agent` called while a worker's agent is
  still being constructed now waits for it (bounded by the same close
  deadline) instead of reporting a false "shutdown" over a session nothing
  can ever release again; and a session salvaged by a deadline or a cancel
  no longer reports as resumable once its agent has actually been disposed.

## [0.2.109] - 2026-08-24

### Agent

- Removed `AgentProfile.fleetTier`: no loader ever populated it from any config
  format, so it was declared but unreachable. Fail-closed behavior is
  unchanged — a profile-sourced orchestrator is still denied `task`/
  `search_agents` with no supported opt-in.
- Removed the default 30-turn leaf sub-agent ceiling; an unset `maxTurns` now runs unbounded (explicit budgets still apply).
- Deleted two unenforced orchestrator prompt rules: a "4 workers at once" fan-out cap and a same-agent lane-disjointness rule.
- Sub-agent forced-stop outcomes (turn budget, no-progress, deadline,
  cancelled, etc.) are now classified from the structured stop reason the run
  reports directly, not by re-parsing the parent-facing report's prose.
  Removes the `isXxxSubAgentReport` classifier family and per-reason parent
  hint functions in favor of a single structured switch.
- Removed the `never-edited`, `never-acted`, and `no-ship` sub-agent salvage
  classes and the sticky hard-block that refused an identical re-dispatch
  after one fired. `task` re-dispatch is never refused now; turn-budget
  salvage still throttles repeated same-brief retries. Also removed the
  now-dead shell-write half of the shell-evidence detector (read detection
  for `requireEvidence` is unchanged) and the shell-write contribution to
  `editedPaths` diagnostics.

### Internal

- Removed the dead Ink-era kill ring copy (`src/tui/kill-ring.ts`); the OpenTUI
  prompt kill ring (`src/tui/prompt-kill-ring.ts`) is the sole implementation.
- Extracted the shared timeout-race helper (`src/util/budget-race.ts`) used by
  the shell-guard search budget and the tool-execution watchdog, replacing two
  independent copies of the same `AbortController` + `setTimeout` race.
- `runtime-bridge.ts` now re-exports `mapReactorLike` from `stream-event-map.ts`
  instead of wrapping it in an identical local function.
- Removed degenerate-repetition detection outright: the streamed-text loop
  detector, the tool-fingerprint period/cycle thrash check, the
  turns-since-user-message backstop, and the leaf no-progress (identical
  tool-call) counter. These were pattern-matching heuristics layered on top
  of the transport/policy line the harness actually needs — provider stream
  error handling, connection retry/backoff, and the turn budget — and had
  become a source of false-positive stalls without a clear win rate. The
  turn budget stop and the director's soft tool-only check-in nudge are
  unchanged; nothing else in this run/stop chain was touched.

## [0.2.108] - 2026-08-24

### Agent

- Tier 3 leaf workers can now report via `submit_result`, a typed channel alongside
  the markdown envelope that validates against a director-declared shape and
  returns a correction (capped at 3 rounds) on an invalid submission.
- **`spawn_agent` / `wait_agents` split the fused spawn+wait out of `task()`.**
  `spawn_agent` starts a worker and returns immediately with `{ agent_id,
  status: "running" }` — it never awaits the worker's completion. `wait_agents`
  blocks until any of the given (or, if omitted, all currently running)
  agent ids reaches a terminal state, or `timeout_ms` elapses (default
  30s, clamped to a 300s max); a timeout is not an error and never touches
  the workers — they keep running and stay waitable. Lets an orchestrator
  fire several workers in one turn instead of serializing one `task()` call
  per worker. `task()` is unchanged and remains the single-call spawn+block
  primitive for the common one-worker case.

- **Fleet authority tiers are now runtime-enforced, not documented in a prompt.**
  Every director package carries a required `tier` (`orchestrator` /
  `nested-orchestrator` / `leaf`): skywalker gets full fleet control, greybeard
  (and any package with `spawn.maySpawn`) is scoped to its own subtree, and every
  other director gets no fleet verbs at all. The gate lives in code
  (`src/subagent/authority.ts`, wired into `runSubAgent`'s tool-mount point) and
  fails closed: a caller whose tier cannot be resolved — including a
  project-local or plugin agent profile with `orchestrator: true` that has not
  explicitly opted in via `fleetTier: "nested-orchestrator"` — is denied
  `task`/`search_agents` rather than silently trusted. This is the foundation
  the next fleet-control verbs (spawn/list/steer a live agent) land against;
  the subtree-scoping rule for those is written and tested but not yet wired to
  a live call site. `task()` is unchanged and still the only spawn verb.

- **Retry recovery no longer multiplies with the harness's own retries.** The
  director's inference-recovery layer previously re-issued a full-context
  `infer()` call for `timeout`/`retryable` errors even though the harness's
  own retry policy already retries and exhausts those categories before
  surfacing them — compounding to up to 9 identical full-context sends per
  logical turn in the worst case. The director now only recovers
  internal-recovery aborts (a category the harness never retries on its
  own), so the two layers no longer multiply. Attempt counts are now logged
  on each recovery so retry storms are visible in traces.

- **`read_agent_trace` lets an orchestrator inspect a worker's on-disk trace
  directly**, so a cancelled or interrupted worker's completed work is no
  longer invisible just because its in-memory session record is gone. Reads
  turns, tool calls, and tool errors straight from the worker's
  `turns.jsonl`, tolerating a partially written or malformed line without
  failing. Every response is bounded on four independent axes — turn window,
  entry count, per-entry characters, and total output characters (the first
  three multiply, so a total-output ceiling caps them together) — each with
  a hard maximum the caller cannot exceed, and a truncated response says
  exactly what was left out and how to page for the rest. A Tier 2 nested
  orchestrator can only read its own descendants' traces, enforced by
  reusing `SubAgentSessionStore`'s existing parentSessionId chain
  (`assertCanTargetAgent`'s first live call site); leaf directors never see
  the tool at all. `progress_note` for leaf workers is a separate,
  not-yet-implemented follow-up.

### Permissions

- **Quoting or backslash-escaping a redirect target, a dangerous flag, or a
  program name no longer bypasses auto mode's shell rules.** The auto-shell
  policy used to blank out quoted text before matching its rules, so `echo hi
  > "file"`, `echo hi >|file`, a quoted `-c`/`-i` flag, a quoted `install`
  subcommand, or a quoted upload-tool name all slipped past the
  file-mutation, dependency-install, and network-upload rules — including one
  level of quoting inside a `bash -c` payload. Matching now dequotes the
  command the way a real shell would (only the operator characters `> < | &
  ; \`` are neutralized when they occur inside a quote, everything else stays
  literal, and a backslash-escaped quote never opens or closes a span), and
  the file-mutation redirect pattern now also recognizes the `>|` / `>>|`
  clobber form.

### Fixed

- **Interrupting a turn no longer risks a startup crash.** If an interrupt hit
  the agent mid-teardown, a failed close could leave its in-process workdir
  lock stuck held, and the immediate rebuild threw "an agent is already open"
  as an unhandled rejection. A failed close now short-circuits the rebuild
  with a clear, catchable error instead of retrying a doomed second
  acquisition.
### TUI

- **The approval overlay no longer pushes the prompt box off screen or clips
  itself at the bottom.** On a short terminal the fixed context budget behind
  a permission/operator approval could ask for more rows than its frame had,
  so the resolver fell back to sizing it below its own render minimum — the
  overlay's border and choices painted past the frame, or vanished entirely,
  while the prompt box was still on screen but the thing the operator needed
  to answer was not. The overlay's context text now shrinks (down to dropping
  it entirely on the shortest terminals) so the header, every choice's row
  budget, and the prompt box at its floor always fit together; choices win the
  row budget over context detail when a terminal is too short for both.

## [0.2.107] - 2026-08-24

### Agent

- **Oversized tool output is recoverable instead of lost.** When a result from
  grep, `run_shell`, `search_files`, `web_fetch`, or an MCP tool exceeds the
  inline cap, the full output is now written into the session's blob store —
  committed alongside the turn that produced it — and the truncation notice
  names the `tool-output:///` URI to read it back with `read_file`. Previously
  the tail was discarded, so recovering it meant re-running the command.

- **A worker's write scope is checked against other live workers, not declared
  up front.** The static per-director write-path allowlist is gone; it could
  never express what actually matters (this dispatch owns these paths), and no
  shipped director ever set it. Concurrent lanes sharing a working directory are
  now recorded as a conflict the operator can see, rather than pre-locked.

### Interface

- **Short xAI rate limits are no longer reported as quota exhaustion.** A brief
  HTTP 429 from xAI/Grok was classified as a spent plan, so the transcript said
  "Quota exhausted — usage limit reached" when the operator could retry
  immediately. Those are now retryable rate limits with the matching copy, and
  genuine usage-limit responses still surface as quota exhaustion.

### Internal

- Reasoning effort is a first-class axis for the capability eval runner
  (`--effort`, or a third segment in a matrix cell), and `--config` now composes
  with provider OAuth credentials instead of silently discarding them — every
  authenticated run with a settings override previously failed before its first
  turn.
- Dispatch outcome records carry the model that actually served the run, so
  intervention figures have a denominator and can be read as rates.
- Tool-name classification is unified behind one module; auto-allow membership
  is unchanged and pinned by a test.
- Director prompts no longer reference tools their tier cannot call, and the
  four-heading report contract is stated once rather than three times.
- Removed `report.requiredSections`, which every director declared and nothing
  read.

## [0.2.106] - 2026-08-23

### Agent

- **`apply_patch` can update files again.** Its Update operation read the target
  through the line-numbered `read_file` view and then tried to match the patch's
  raw context lines against it, so every context-bearing update failed with
  "failed to find expected lines in file." Updates now read the file's real
  content. This was the codex-family edit path, and its most likely symptom was
  the model retrying the identical patch.

- **A worker that succeeds is no longer refused on its next dispatch.** Salvage
  classification matched free-text substrings, so a finished report whose Summary
  merely mentioned "no progress," "cancelled," or "long silence" was recorded as a
  forced stop and blocked an identical re-dispatch for the rest of the session.
  Classification is now exact. A parallel wave where one worker salvages and
  another succeeds also stops leaving the brief blocked.

- **Large files read in one pass instead of many.** A truncated `read_file` now
  returns a continuation handle that resumes exactly where it stopped, rather
  than telling the model to re-read the same path at a new offset. Following a
  spent handle explains what happened and names the file and offset to resume
  from, instead of a bare "not found."

- **Edits show what changed.** `edit_file`, `write_file`, `delete_file`, and
  `apply_patch` return a bounded diff of the change, so nothing needs a
  verification read to confirm the edit landed. The harness already re-read and
  compared after every write; that result now reaches the operator and the model.

- **Reasoning survives resume, and corrected retries win.** On the Responses
  adapters, reasoning items were dropped whenever a turn carried no model field —
  including on resume — while the tool calls they produced were kept, a shape
  known to degenerate reasoning models. Duplicate tool results also kept the
  stale first copy, discarding a corrected retry. Tool names now route through
  the wire-safe codec on all three adapters.

- **Compaction stops discarding the prompt cache.** Compacted prompt prefixes are
  byte-stable across passes, so a compaction no longer invalidates the cache in
  full, and a shallow reclaim no longer re-triggers compaction immediately.

- **Per-model loop visibility.** Mid-stream degenerate-repetition aborts are
  recorded per detector with the measured value beside its threshold, so the loop
  rate can be read per model instead of inferred.

### Interface

- **The context meter tells the truth after `/new`, `/clear`, and compaction.**
  It resets rather than reporting pre-clear usage, and re-syncs to the compacted
  size rather than blanking to zero.

- **Compaction is visible when it happens.** Folding turns away now shows in the
  TUI instead of the transcript quietly shrinking.

- **The status indicator no longer flashes "awaiting response" mid-fan-out.**
  During parallel tool calls the first tool to finish used to mark the turn idle
  while its siblings were still running.

### Safety

- **Connecting a provider verifies the token can actually be used.** OAuth
  onboarding completed on tokens carrying no API scope, so the first real request
  failed in a way that looked like a Corbits bug. Onboarding now probes the
  provider and blocks with an actionable message when the token definitively
  lacks access — a network failure or rate limit does not block.

- **Approval volume is measurable.** Every permission ask and how it settled is
  recorded — tool, rule, mode, outcome, and timings, with no command text, path,
  or argument in the record — with `bun run scripts/approval-forensics.ts` to
  read it back.


- **Resuming a session no longer shows a blank error when the saved history
  has one corrupted line.** A malformed or schema-invalid line anywhere in the
  saved transcript used to abort the entire resume load. The TUI's resume view
  now skips just the bad line (logging it) and still shows the rest of the
  history; a corrupt file still surfaces as an error during live conversation
  loading, where correctness matters more than availability.

- **Every stop and nudge is now logged, and so is what each dispatch produced.**
  `interventions.jsonl` in the worker's trace dir records each intervention with
  its measured value beside the threshold it crossed, the model family it fired
  on, and the run state at that moment — plus refused parent re-dispatches and,
  now, one outcome record per completed dispatch (the salvage kind or a
  clean-complete marker, plus the dispatch count). `bun run
  scripts/intervention-forensics.ts` aggregates them: counts by family, value
  distribution against threshold, two context columns (stops on runs that had
  already edited files, stops before half the turn budget — not a measured
  false-positive rate), and outcome counts by kind. Threshold changes can now
  cite data instead of judgment.

- **Shell file work counts as evidence.** A worker that edited with `sed -i`, a
  heredoc, or `>` redirection had `editedPaths` empty and salvaged as
  `never-edited` — a sticky hard block that then refused the parent an identical
  re-dispatch; one that read with `cat`/`head` salvaged as `incomplete-report`.
  Both are real work classified as no work. `run_shell` commands are now scanned
  for file reads and writes using the same subject expansion the auto-shell
  policy uses, so `bash -c` and `env -S` payloads are inspected rather than
  trusted.

- **Re-read pressure no longer stops a worker.** The `reReadLimit` thrash hard
  stop and its soft `re-read-nudge` are removed: reading one file four times
  while editing another, paging a large file, or re-running a grep to verify an
  edit could all end a healthy worker with a sticky hard block that refused
  re-dispatch. Fingerprint period detection already catches a genuinely
  repeating read cycle, on the evidence that it repeats. `src/subagent/thrash.ts`
  now only tracks read/edit evidence for the `intent=implement` and critique
  completeness checks, plus the near-budget wrap-up nudge.

## [0.2.105] - 2026-08-23

### Permissions

- **Every approval ask and how it settles is now logged.** `approvals.jsonl`
  in the session dir records each consequential decision — auto-mode
  allow/deny, or an operator prompt's allow-once / allow-with-scope / deny /
  timeout / abort — with the classifier rule that triggered it, queued /
  displayed / settled timestamps, and shell chain segment count. No command
  text, path, or credential is ever recorded; writes are fire-and-forget and
  never fail a run. `scripts/approval-forensics.ts` aggregates across local
  sessions.

### Agent

- **Context estimate syncs incrementally on append.** `syncFromTurns` keys
  prefix turns by object identity and estimates only the new suffix. A rewrite,
  shrink, or middle-turn identity break still fully recomputes so image-aging
  cannot leave a stale total.
- **Thinking-only replay no longer collapses into an identical request.** Assistant turns with no text or tool_call (empty content, leftover thinking/citation) are replaced with a stable `[thinking-only turn omitted]` marker so the turn is kept, roles still alternate, and the next `buildRequest` body differs from the previous one.

- **Compaction keeps scored work, not retry loops.** Errored tool results are no
  longer auto-pinned; identical errors collapse to one representative. Anchors
  are scored (writes, successful task completions, plan updates) and pair
  closures count against `maxAnchorTurns`. The LLM summary is workflow-aware
  and skips degenerate assistant text.

- **Prefix-stable summaries and growth hysteresis.** Existing compacted user
  turns stay byte-identical across later passes; new folds become later summary
  turns with an assistant spacer so the prompt prefix can stay in the KV cache.
  After a compact that remains over the high watermark, the governor waits for
  usage to grow by 10% of the window before re-arming. Overflow recovery still
  compacts immediately.

### Plugins

- **`run_shell` no longer defaults to a 15s timeout.** Omitted timeout arms no
  timer (match Pi). Pass a per-call `timeout`, or set `shell.timeoutMs` in
  settings, to bound a command. `shell.maxTimeoutMs` still clamps a resolved
  timeout and does not invent one on its own. Abort and the output-byte cap are
  unchanged.

### Sub-agents

- **Sub-agent `maxTurns` no longer hard-caps at 100.** Default remains 30 when
  unset; values must still be integers ≥1. `task(maxTurns)`, profile
  `maxTurns`, and `settings.subagentMaxTurns` may exceed 100 for long jobs.

### Internal

- **`inference.error` partials keep the provider error.** `partial.jsonl`
  records for `inference-error` now include `error` (`category`, `message`,
  `statusCode` when present) even when the cycle streamed no text.
- **Exec `turnsUsed` follows the run-sink.** Mid-run and terminal `run.json`
  snapshots use `getTurnCount()` the same way the TUI does, instead of
  writing the initial zero until send finishes.

### Docs

- **`latest` is a symlink, not a session.** Naive globs of a project
  sessions directory double-count unless they skip `latest` (`listSessions`
  already does).

## [0.2.104] - 2026-08-23

### TUI

- **Taller live chain-of-thought preview.** Parent reasoning still paints
  through the existing thinking row (one fold per turn, settle-to-opener +
  expand) — no separate mid-turn stream lane. The hard-capped live wrap rises
  from 3 to 10 inset lines (`LIVE_THINKING_MAX_LINES`) so mid-turn CoT is
  glanceable; reveal rate stays 28 chars/sec. Sub-agent Task-row thinking is
  unchanged. Assistant mid-turn text continues to grow the open streaming
  assistant row from `inference.text.delta`.

- **Live agents sit in a chrome strip above the prompt.** Running and
  finished workers no longer compete with the transcript for vertical
  space; the strip stays parked over the input, finished rows linger
  briefly, then it clears when idle. Transcript task-row rewrites pause
  while the strip owns live status.

### Tools

- **`edit_file` filler args no longer count as a second mode.** Models pad
  the unused mode with `start_line: 0` / `end_line: 0` / `old_string: ""`.
  Those now count as absent, so substring vs line-range is chosen from the
  real fields. Mixed-mode calls still reject, and the error names exactly
  which fields to drop so a retry can differ.

- **`task` rejections name only the missing field.** A typed brief that
  omitted `prompt` used to be told both `description` and `prompt` were
  required, so the model retried the identical call. The error now names
  the actual gap and echoes the valid field back.

- **Truncation no longer promises a retrievable remainder.** Tool results
  cut at 80,000 chars now say the discarded tail is gone and re-running
  yields the same cut, instead of pointing at a `tool-output:///` blob that
  only held the truncated text.

### Sub-agents

- **Parents and the TUI see why a child stopped.** Forced stops (repetition,
  stall, deadline, turn-budget, no-progress, operator cancel, thrash) carry
  a machine-readable `Stopped:` line on the report and a reason on the
  child's session. Fleet rows announce `<lane> stopped — <reason>` instead
  of a silent done/cancelled.

- **Repetition detection covers short-phrase, counter, emoji, and
  zero-width floods.** The periodic window floor drops to 8 chars (with a
  higher repeat bar so healthy lists stay quiet). A digit-folded pass
  catches incrementing counters and fence/emoji floods; a contentless-growth
  check flags streams of invisibles that used to normalize to healthy text.

### Providers

- **Cross-provider replay no longer 400s the rest of the session.**
  Switching model/provider mid-session used to replay foreign thinking
  signatures and output-only blocks the new adapter cannot encode. Every
  adapter now sanitizes persisted history before `buildRequest`: drop
  unmappable blocks, strip foreign signatures, and synthesize dangling
  `tool_result`s.

- **Grok and OpenAI Responses set `prompt_cache_key` per session.** Codex
  already did; xAI and Go Responses did not, so Grok threads cached at
  ~66–72% versus Codex's 92%+. Parent and each sub-agent thread get a
  stable, distinct key.

- **TUI first inference waits for Codex instructions refresh.** The TUI
  used to fire the refresh un-awaited, so turn 2's request prefix could
  change under a live cache key and force a full miss. Delivery now waits
  for that promise (non-Codex profiles skip it; a failed refresh still
  falls back to cached/bundled copy).

- **Codex Responses no longer sends `reasoning.summary: "auto"`.** ChatGPT
  Codex rejects that value for gpt-5.6-terra / gpt-5.3-codex family models
  (HTTP 400 at turn 0). The adapter now sends `{ effort }` only, matching
  Codex CLI catalog `default_reasoning_summary=none`.

- **Codex native tools proxy onto Corbits tools.** `apply_patch`,
  `exec_command`, and `update_plan` from Codex-family models land on the
  real file, shell, and `manage_tasks` handlers instead of being rejected
  as unknown names.

### CI

- **Required checks are `prettier`, `eslint`, `typecheck`, and
  `build-and-test`.** The old combined `lint` job (cached, continue-on-error)
  never reported the status contexts the main ruleset required, so every PR
  sat blocked. Lint result caches are gone in CI; local `bun run lint` still
  uses `--cache`.

## [0.2.103] - 2026-08-23

### TUI

- **In-flight tool rows show elapsed time.** Ordinary pending calls (MCP,
  search, shell) tick a live clock the same way Task rows already do, so a
  slow-but-alive call is distinguishable from a hung turn.

- **The stall notice comes down the moment activity resumes.** It is a live
  diagnosis, not a sticky banner: a tool finishing or the turn settling
  clears it on that paint, even if the monitor tick has already been
  cancelled.

### Tools

- **MCP tool calls arm their own watchdog.** Default 5 minutes
  (`settings.mcp.timeoutMs`), still capped by `tools.maxTimeoutMs` when set.
  Expiry returns a model-reactable tool error; the turn is not aborted.
  `task` and `run_shell` behavior is unchanged.

### Sub-agents

- **Successful leaf `task` completions re-arm the primary backstop.** A
  productive fleet no longer hard-pauses solely from turns-since-operator
  volume. Failed or salvaged leaf reports get no credit, so true tool-only
  no-progress still nudges then pauses.

- **Leaf no-progress repeat limit raised from 2 to 5.** Legitimate polling
  / retry streaks survive longer before salvage.

### Auth / evals

- **Exec refreshes Codex instructions before first Codex inference**, same
  shared path as the TUI, with best-effort fallback to cache/bundled copy.
  Capability eval cells also stamp instructions hash, built-in tools, and
  requested reasoning effort for triage.

- **New capability eval cases:** misleading-symptom, flaky-diagnosis,
  broken-toolchain, hidden-contract-inventory (held-out tests), and
  impossible-spec (reward-hacking bait).

### CI

- **Codex instructions unit mock restores `node:fs` in `afterAll`.** The
  leaked in-memory fake had been poisoning later suites under
  `bun test ./src ./tests ./evals` since the mock landed.

## [0.2.102] - 2026-08-22

### Permissions

- **Workspace containment returns canonical real paths.** Writers receive the
  realpath from the containment allow, closing the symlink-retarget window
  between check and write; the write-path allowlist compares both sides in
  canonical space so symlinked cwds don't false-deny.

- **Dangling or looping symlink components fail closed.** A path component
  that exists but cannot resolve (dangling link, symlink loop) is denied by
  containment and the write-path allowlist instead of being treated as a
  missing tail; genuinely-new file paths still resolve via the nearest real
  ancestor.

### Trust

- **Project-trust stores are keyed by realpath.** The same repo reached via
  symlink twins (e.g. `/tmp` vs `/private/tmp`) now finds the same grants;
  the saved `repo` field and validity compare canonicalize consistently.

### TUI

- **Typeahead popups no longer leak queued permission gates.** Both the
  @-mention popup and the slash-command palette refresh their suggestion
  lists in place instead of close+reopen, so a queued gate can't open (and
  swallow keys) mid-filter. Zero matches shows "(no matches)" without
  releasing the popup; Enter there preserves the typed text.

## [0.2.101] - 2026-08-22

### Permissions

- **`/yolo` persists as the user-global skip-permissions default.** Exec
  inherits it; `--dangerously-skip-permissions` still forces the current
  process. Secret-guard and authz still apply. The TUI shows a startup notice
  (and exec a stderr warning) when prompts are disabled by the saved default.

- **Always-allow for `git worktree *` now covers later worktree commands.**
  Contained and permitted-sibling worktree add/remove segments no longer hit
  the restricted-path guard before grant matching, so a standing grant
  applies instead of re-prompting on every dispatch. Force flags, chained
  commands, and genuinely-outside destinations still prompt.

- **Empty workspace roots can no longer disable path containment.** An empty
  string in the roots list used to make every absolute path count as
  contained; it is now rejected before the prefix compare.

### TUI

- **The stall watchdog no longer aborts healthy waits for the model.** A run
  that is merely awaiting the model's next token (after submit or after a
  tool batch resolves) surfaces a persistent stall notice but is never
  auto-aborted; auto-abort is reserved for a stream that started emitting
  and then died mid-flight. Live sub-agents and open permission gates keep
  their existing exemptions.

### Sub-agents

- **Thinking-token loops now trip the repetition detector.** Thinking deltas
  feed the same cycle buffer and abort path as visible text, with a
  short-period digit-folded check that catches monotonic counters (`0/1 1/2
  2/3 …`) without flagging healthy templated enumeration; the looped window
  is flushed to `partial.jsonl` for diagnosis.

### Trust & plugins

- **Project-trust stores are atomic, serialized, and cwd-correct.** Saves go
  through temp-file + rename behind a per-store mutation queue; a store
  missing its `repo` field is invalid (empty grants); plugin trust paths
  resolve against the project cwd, never the process cwd, and relative
  entries are dropped on load.

- **Repo plugins with `defaultEnabled` load agent profiles**, matching how
  skills already gate; tool plugins remain consent-gated. A later same-id
  install can no longer silently turn a bundled default off.

### CI

- **ESLint + Prettier land with a split concurrent CI** (lint / typecheck /
  build-and-test) with dependency and lint caches; `bun run check` is the
  single pre-PR gate. The lint job is non-blocking until the repo-wide
  mechanical fix batch lands.

## [0.2.100] - 2026-08-22

### Plugins

- **Requested `run_shell` timeouts are no longer capped at 10 minutes.** The 15s
  default when timeout is omitted is unchanged. `shell.maxTimeoutMs` still
  clamps the command when set.

- Capability evals accept `--concurrency <n>` (env `CORBITS_EVAL_CONCURRENCY`,
  default 1); overlapping `httpFixture` cells isolate `EVAL_HTTP_URL` so
  parallel web-bait runs do not share a process.env origin.

### TUI

- **Tool `run()` no longer has an implicit 11-minute wall-clock abort.** The
  outer watchdog arms only when Settings set `tools.timeoutMs` /
  `tools.maxTimeoutMs`, or when `run_shell` passes a positive `timeout`
  (requested plus slack, so this layer cannot beat shell-guard). Unset
  settings leave `task` and other tools unbounded; parent cancel, maxTurns,
  and eval `--agent-timeout-ms` still bound the run. `tools.maxTimeoutMs`
  still clamps non-shell tools when set and does not cap a longer requested
  `run_shell`.

- **`task` (sub-agent dispatch) is always exempt from the generic tool-execution
  watchdog**, even when Settings arm it. Workers past 11 minutes with healthy
  activity complete and return their own report instead of surfacing as
  operator cancels; maxTurns, no-progress, thrash, and the opt-in `deadlineMs`
  remain the operative bounds.

### Directors

- **Skywalker spawn-target for product code is `build`.** Prompt and
  skill copy that still said `spawn implement` / `task(agent="implement")`
  now dispatch `build`. Intent graph `explore → implement → critique`
  and slash `/implement` are unchanged.

- **Skywalker may DIY tiny product writes (CL-6629).** Path tools
  (`write_file` / `edit_file` / `delete_file`) remount on the primary
  session. Tiny/single-file/one-route bounded edits are the exception;
  spawn remains default for substantial/multi-file/parallel/specialist
  work (hard cap 4 workers). Docs/design still spawn shakespeare /
  bruckheimer / brand-reviewer except one-line fixes. Greybeard stays
  write-free. Shell file-writes stay denied. Spawn is a judgment call,
  not a tool ban.

- **Exec and capability evals can run as a chosen primary director.**
  `corbits exec --director <id>` (and eval `--director`) overlays that
  package's system prompt and initially-advertised tool set on the product exec path.
  Omit / skywalker keep the default Skywalker session. Directors that
  cannot spawn (for example build) do not mount `task`. This is an
  exec/eval/CI override, not a TUI or single-agent mode.

## [0.2.99] - 2026-08-21

Skywalker is the primary orchestrator over a closed director fleet: product write tools stay off the primary, and you cannot spawn Skywalker as a task leaf. Workers are not done until they return the four-heading report. First-party action skills ship as slashes; eval runners require an explicit provider/model pair; the style skill no longer refuses non-git folders.

### MCP

- **Late-connected MCP tools are callable the same turn they appear in `tool_search`.**
  `@intx/agent` snapshots dispatch names at `createAgent`, and the post-connect
  reload that used to rebuild that snapshot waited for every server — including
  one stuck on OAuth. Cataloged `mcp__*` tools then returned `unknown tool`.
  Construction now dispatches misses through the live runner, so Linear/Exa
  (and any other server that finished) work even while another server still
  needs auth.

### TUI

- **Model picker rows are model-first.** Each leaf is `model * [provider]`;
  `(current)` still marks the live session model. **Alt+D** persists the
  focused pair as the default (global `defaultProvider` + provider
  `defaultModel` + project-local selection) without switching the live
  session or closing the picker.

- **Settled permission and operator prompts no longer recap into the chat.**
  The overlay is the question; answering it used to leave a grey
  `permission` / `operator` card restating the same command and the chosen
  option. After a decision those recap rows are gone — the tool row that
  follows is the outcome. Expanding a collapsed payload while the overlay is
  still open still writes the full payload into the transcript, because that
  text would otherwise be unreachable before approval.

### Directors

- **Shipped directors have no writePaths lock.** Docs/design leaves
  (shakespeare, brand-reviewer, bruckheimer) still mount write tools, but
  package `writePaths` is omitted. Lane routing (P/A/I, DESIGN.md, product
  discovery) is spawn policy, not a file lock. Optional `writePaths` remains
  and the permission gate still enforces it when a profile sets it.
- **Skywalker is not a task leaf.** `task(agent=skywalker)` is refused. The
  spawn catalog (`directorProfiles()`) lists the other 15 closed directors;
  the primary session is still Skywalker.

### Sub-agents

- **Tool-less mid-run narration is not a finished report.** A worker that
  stops tooling with Summary-only (or other incomplete) prose is not
  complete. The director injects one wrap-up nudge asking for the four
  headings (Summary / Findings / Blockers / Paths), then salvages as
  incomplete-report if the next tool-less turn is still missing the envelope.

### Plugins

- **First-party skills catalog is on out of the gate.** `corbits-skills`
  ships action slashes `/implement`, `/plan`, `/refactor`, `/review` (was
  `/code-review`), `/pull-request-review`, `/create-issue` (was
  `/linear-create`), `/scribe`, `/interview`, `/ast-grep`. Dispatch,
  git-rebase, linear-issue-workflow, style, philosophy, typescript, and
  opsh stay `use_skill` only (`user-invocable: false`). Draper and emil
  are not skills or slashes — closed directors via `task(agent=…)` only.
  `/plan` is the eng change-plan recipe (`task(agent="plan")`; does not
  implement or file tracker issues). `/create-issue` remains the tracker
  command: Linear MCP when available; otherwise `ask_operator` for the
  platform and persists `Preferred issue tracker` in `.corbits/MEMORY.md`
  (GitHub via `gh issue create`). Each recipe tells Skywalker to spawn
  closed directors — the operator types the slash; the primary does not
  do the work. Turn the catalog off in `/plugins` if you want those
  commands gone.
- **Style skill no longer refuses non-git folders.** Edits, tests, and
  reports are allowed without a repository. Do not `git init` unless
  asked. Commits, amends, rebases, and isolated worktree dispatch still
  require an existing repo.

### Evals

- **Capability eval workdirs are git repos.** After copying the fixture
  and seeding skill stubs, the runner initializes the tmp workdir (`git
  init`, `git add -A`, one unsigned hermetic `eval fixture` commit) so isolated
  workers have HEAD and git-aware skills have a baseline.
- **Eval runners require an explicit model pair.** `eval:capability` and
  `eval:public-swe-one` take `--provider` / `--model` (capability also
  accepts `--matrix` with complete cells) so local `.corbits/settings.json`
  is not the implicit target.
- **Capability eval records `task` tool calls.** `taskToolCallCount` is derived
  from the turn stream (informational). Older result files without the field
  default from `toolCallsByName.task` so the frozen baseline still parses.
- **Capability eval smoke cases for dispatch and recall.** `complex-dispatch-spawn`
  requires at least one `task()` plus a working GET /readyz.
  `complex-recall-after-bulk-read` plants a token, asks the agent to read the
  fixture, then write it back. Informational only — not in the frozen
  baseline-0286 gate until a deliberate refreeze. Neither case proves
  compaction fired or that the primary skipped implementing the route.

### Session

- **Resume is keyed to this checkout's git toplevel.** Linked worktrees no
  longer share (or list) each other's sessions — `--git-common-dir` made
  every worktree show every other worktree's history. Sessions previously
  created from a worktree remain under the main checkout key; resume from
  the main path to recover them.

## [0.2.98] - 2026-08-17

Corrupt resume state no longer kills sessions, Codex quota errors name the
reset window, and provider/model selection is more reliable across restarts and
mid-session switches.

### Session

- **Poisoned resumes recover.** Resume loads no longer die on null-padded
  `turns.jsonl` data after a stale compaction window. Usable turns are recovered,
  valid metadata is preserved, and pending gates re-arm instead of leaving the
  session wedged.

### Codex

- **Quota errors explain the reset.** Codex `usage_limit_reached` responses are
  parsed as quota exhaustion, show the plan/profile when available, include the
  reset ETA, and point `/model` at another subscription instead of looping on a
  doomed retry.

### Sub-agents

- **Workers follow a mid-session model switch.** Sub-agents spawned after you
  switched models kept running against the provider the session started on, so
  switching away from an exhausted or disconnected account left every new
  worker failing until a restart. Provider, model catalog, and settings are now
  read live at spawn time, so tier settings written mid-session are visible too.

### Breaking

- **Single-agent session mode is gone.** The primary session is always
  orchestrator-capable (`task` / `search_agents` always available). The first-run
  mode picker and Settings → Session rows are removed. Legacy `sessionMode` in
  settings files still loads without error and is ignored (CL-5814).
- **Dual-column fleet rail removed.** TUI geometry is stack-only forever
  (`layoutMode: "stack"`, `railWidth: 0`). `DUAL_MIN_COLUMNS` / `RAIL_WIDTH_*`
  constants and dual absolute-positioning of the agents box are gone. Live
  fleet status remains `● Task` transcript rows; the agents chrome zone stays
  empty.

### Fixed

- **Parent live reasoning no longer sideways-scrolls.** Streaming thinking used
  a one-line marquee onto the newest tokens. It now paints a short wrapped
  preview (up to three inset lines of the newest revealed prose); expand still
  opens the full block. Sub-agent Task-row thinking is unchanged.
- **Skywalker dig fleets cascading into stalled Task floods.** "Why stalled /
  why no thinking / spawn looks broken" asks were reclassified as orchestration
  and fanned into parallel explore waves; Grok leaves then sat quiet mid-think
  or looped, which looked like spawn failure and invited another dig wave.
  Skywalker now hard-caps concurrent leaves at 4, classifies digs/screenshots/
  why-how as COMMUNICATION (answer or one explore leaf), and forbids re-fan-out
  diagnostic waves when leaves stall or salvage.
- **Grok sub-agent stall false positives.** Live fleets on grok-4.6 show routine
  60–180s gaps between tool cycles while the model thinks. UI stall paint and
  Grok's salvage kill were far shorter, so healthy thinking looked hung and got
  nudged/stopped mid-inference. `DEFAULT_STALL_MS` and parent `STALL_NOTICE_MS`
  are both 300s (aligned with the 5-minute `subAgentStallTimeoutMs`). The
  grok-responses path asks for `reasoning.summary: "detailed"` so summary
  deltas keep the activity clock moving (auto summaries were tiny vs billed
  thinking tokens).
- **Live fleet status is `● Task` transcript rows again.** The FLEET board /
  dual-rail agents chrome restated the same workers above chat and made
  progress hard to read. `task` calls paint live rows (clock + current tool)
  via `syncAgentProgress`; `formatChromeZones` keeps the agents zone empty and
  suppresses the manage_tasks checklist while any lane is running.
- **`web_fetch` / `web_search` always advertised.** They were registered but only
  discoverable via `tool_search`, so strict providers (and thrashy models) never
  saw them on the wire despite Skywalker saying they were mounted. Both are now
  in `CATALOG_TOOL_NAMES`. Capability `web-bait` hard-requires
  `webFetchToolCallCount >= 1` via `requireBehaviors`.

### Added

- **Public SWE-bench one-shot smoke.** `bun run eval:public-swe-one` runs Corbits
  product exec on a single SWE-bench Lite instance (default
  `psf__requests-3362`), taking `--provider` and `--model` on the CLI, and
  writes `preds.jsonl` under `evals/public/results/`. Official Docker
  resolved/not-resolved grading stays optional/manual.
- **Capability eval: `complex-stock-gate`.** Multi-file stock-gated `POST /orders`
  (404/409/201 + stock decrement) on the demo-comparison fixture; sync API grader.
- **Capability eval: `complex-idempotent-orders`.** Header-driven Idempotency-Key
  on POST /orders (201/200/409) with multi-file order store; sync API grader.
- **Capability eval: `complex-bugfix`.** SWE-bench-style issue→patch→tests on the
  new `tests/fixtures/buggy-service` fixture (intentional post GET bug; users green).
- **Capability eval: `complex-pagination`.** Query `limit`/`offset` on GET /products
  (demo-comparison); sync Response grader + slice semantics.
- **Capability eval: `complex-rename-user`.** Cross-file rename of user `name` →
  `displayName` on multi-file-service; runtime + source checks.
- **Fixture: `tests/fixtures/buggy-service`.** multi-file-service clone with a
  deliberate post-route defect for bugfix capability evals.
- **Director API-contract loop (launch tuning iter1).** Implement preserves sync
  public surfaces; critique ranks sync→async signature drift as blocking;
  Skywalker puts stated signatures into success_criteria, skips explore/critique
  on tiny green ships, re-dispatches implement on blocking critique findings,
  and routes URL reads through mounted `web_fetch` (no shell thrash). complex-jwt
  case prompt states the sync Response contract.


- **Closed director fleet (CL-5818 Level 6 wiring).** Sixteen director packages
  under `src/agent/directors/<id>/` (prompts, tool envelopes, spawn rights, nudge
  budgets, report contract) register in `DIRECTOR_REGISTRY`. `task(agent=…)`
  resolves directors without requiring plugin profiles; `task(intent=…)` maps
  implement/explore/plan/review→critique (`general` is refused). Default agent
  profiles are the closed fleet via `directorProfiles()`.
- **Primary is Skywalker by name.** System role answers "Skywalker"; agent id
  `skywalker`. Product mutation tools are not mounted on the primary session
  (structural never-implement), not only prompt policy.
- **Director identity at spawn.** Every package system prompt is prefixed with
  agent id, model role, and optional skills; profiles include `agent id:` in
  description so search_agents / re-spawn are unambiguous.
- **modelRole drives leaf effort.** Spawn effort cascade is pin → package
  modelRole default (intern=low) → orchestrator/leaf → parent. Env block adds
  arch + runtime alongside platform/date/git.
- **No general leaf at the wire.** Bare `task` (no `agent`, no `intent`) and
  `intent=general` fail closed; nested directors enforce `spawn.allowlist`
  (greybeard → intern/explore/critique).
- **Director write-path locks.** Docs/design packages may write only under
  package `writePaths` (shakespeare: PRODUCT/ARCHITECTURE/IMPLEMENTATION;
  brand-reviewer: DESIGN.md; bruckheimer: PRODUCT.md + docs/*), enforced in
  the permission gate.
- **PRODUCT / ARCHITECTURE / IMPLEMENTATION** document the closed director
  fleet, spawn matrix, intent map, and tool envelopes.

### Providers

- **Named API-key instances.** First-class API-key providers (OpenAI key,
  Anthropic, Google, OpenCode Zen/Go, Z.AI, ...) ask for an instance name before
  the key, so personal and team keys can coexist (`openai/default`,
  `anthropic/work`, ...). Reusing an existing name replaces that instance after
  an explicit confirm. Custom endpoints stay free-form and single-entry.
- **API-key connect keeps the project selection.** Connecting an API-key or
  Custom provider now writes the same project-local provider/model selection
  OAuth already wrote, so a restart in that repo resolves to the account just
  connected. Secrets stay in global credential storage only.
- **Grok 4.6 is selectable.** xAI OAuth accounts now list `grok-4.6` alongside
  Grok 4.5 and Composer 2.5 Fast.

### TUI

- **Custom from Alt+A.** The add-provider selector now includes Custom alongside
  first-class kinds, so free-form OpenAI-compatible endpoints are reachable from
  the model picker without dropping into onboarding. Custom still uses the full
  manual form (name, base URL, key, model).
- **MCP auth is `mcp !` on the prompt box.** A server waiting on authorization
  no longer takes a notice-row sentence (`mcp granola needs auth (/mcp)`). The
  top rule carries a compact `mcp !` immediately left of the model label;
  `/mcp` still names the servers.

### Docs

- **Contribution rules are codified.** The pull request template and agent docs
  now spell out the expected commit, review, and Linear-linking discipline.
- **Models-only connect prose.** PRODUCT, IMPLEMENTATION, and operator-facing
  error strings document `/model` as models-only with **Alt+A** to add a
  provider. Stale bare-`c` / Ctrl+A / in-list "connect ->" instructions are gone.

## [0.2.97] - 2026-08-10

Codex connect works again: streaming responses no longer die on a missing
header, multiple ChatGPT accounts can be connected by name, and providers are
added from the model picker with Alt+A.

### Providers

- **Codex streaming repaired.** Some Codex models (the gpt-5.6 family) stream
  valid responses with no Content-Type header, which failed every turn with
  "Cannot detect response kind". The response protocol is now recovered from
  what the request asked for, so those models work; genuinely malformed
  responses still fail loudly.
- **Named accounts with re-auth.** Browser sign-in asks for an account name
  first, so any number of ChatGPT or Grok accounts can be connected side by
  side (`codex/work`, `codex/personal`, …). Reusing an existing name
  re-authorizes that account after an explicit confirmation — the recovery
  path for expired sign-ins. Second sign-ins can no longer silently overwrite
  an existing account's credentials.

### TUI

- **Alt+A adds providers.** The model picker lists only connected accounts
  and their models; Alt+A opens an add-provider selector that always shows
  every provider with its connected-account count, so adding a second account
  is never blocked. After connecting, the picker reopens focused on the new
  account.
- **Connect works mid-session.** Adding a provider from a running session no
  longer crashes with a renderer conflict; the sign-in surface shares the
  session's screen and hands control back when done.
- **Pickers stay on screen.** Overlays opened after using one on the launch
  screen no longer render below the prompt box.

## [0.2.96] - 2026-09-08

Drag-select auto-copy, a flat type-to-filter model picker, install-aware upgrade
notices, quieter long-session compaction, and layout breathing room.

### TUI

- **Drag-select auto-copy.** With mouse capture on (the default), finishing a
  drag selection in the transcript writes the selected text to the system
  clipboard on mouse-up. Highlight clears immediately; the status flash waits
  for the clipboard write (`Copied …` on success, `Copy failed` on error).
  Alt+C structured copy uses the same honesty. Alt+M still hands the mouse
  back for native terminal selection.
- **Flat model picker.** Choosing a model is one type-to-filter list of
  `provider / model` rows — no nested provider drill-down. Type to narrow,
  Enter selects; Alt+F still toggles favorites when wired.
- **Install-aware upgrade notice.** When a newer GitHub release exists, a
  non-blocking startup notice names the running and latest versions and the
  right upgrade step for Homebrew, source/Bun, deb, release binary, or
  unknown. Network and detection failures skip quietly.
- **Bottom breathing room.** The prompt box sits one blank row above the
  terminal's last line on tall enough terminals, so the layout no longer
  feels flush against the frame edge.
- **User-message breathing room.** Your turns in the transcript keep a blank
  bar row above and below the message text, so prompts are easier to spot
  while scrolling.
- **Landing survives MCP connect failure.** An MCP status failure still shows
  as a system notice and no longer wipes the mountain landing screen.

### Session

- **Quieter re-reads under compaction.** When the same file is read more than
  once in a long session, older successful `read_file` results become a short
  stub and the newest stays whole, so context is not filled with duplicate
  file bodies. Chunked reads of different ranges stay distinct. Errors stay
  verbatim.
- **Changelog watermark honesty.** Upgrade notes are no longer marked as
  “already shown” when nothing was actually displayed.

## [0.2.95] - 2026-08-09

Tool-only auto-pause that no longer stops healthy work, resume the last session
in a folder, and `/feedback` that just sends.

### Tool-only pause that tracks real thrash

- **Hard pause requires a repeating tool-call cycle**, not a bare tool-only turn
  count. Period detection catches identical repeats, A/B alternation, and longer
  fixed rotations; a short identical poll (re-run a flaky test, check a build)
  no longer false-positives.
- **Soft wrap-up nudge at 25 tool-only turns** for every model family — a
  check-in, never a stop. Grok drops its miscalibrated 6/10 pair and shares the
  default; its shorter sub-agent stall timeout and finish-bias residual stay.
- **Raw-count backstop** for cycles above the period ceiling or phase-broken
  patterns: first a progress-summary nudge, then a hard pause only if another
  full interval passes with no genuine operator message. Synthetic system sends
  (compaction continuations and the like) no longer reset the counter.
- Shared **period-detection** helper lifts the character-stream repetition search
  so tool fingerprints reuse the same shape; a local forensics script re-derives
  thresholds against real session traces.

### Resume and continue

- **`corbits resume` / `corbits continue`** reopen the latest session for the
  current project folder, a specific session id, or the interactive picker.
- Invalid ids error instead of silently falling through to “last”; id and
  `--pick` cannot be combined. Legacy session trees still migrate on resume by
  id.

### Feedback

- **`/feedback`** sends free-text product feedback when you choose to. Bare
  `/feedback` waits for the next line; text on the same line sends immediately;
  empty Enter cancels. Other slash commands clear a pending arm.
- The reply is a short system notice (**Thanks — feedback sent.**), not a model
  turn — no busy state, no queue.

### Usage analytics

- Settings describe optional ambient analytics clearly, and say when an
  environment setting has disabled them so the toggle cannot re-enable.
- Generation properties use PostHog cost names: `$ai_cache_read_input_tokens`,
  `$ai_cache_creation_input_tokens`, `$ai_reasoning_tokens`.
- Broader auth and slash product events.

### TUI and CI

- Markdown settle waits for body paint so heading-only frames no longer flake CI.
- `--help` exits 0 cleanly.

## [0.2.94] - 2026-08-09

Orchestrator-first release: a truthful fleet board, thrash salvage that stops
false completes, steering that keeps your input, and one TUI root. Goal mode
is gone. Coupled Interchange packages are vendored at head.

### Fleet

- **One fleet board** replaces the agents strip and task panel — identity,
  elapsed time, and what each leaf is doing, clamped to the rows it was granted.
- **Lane tools show a subject**, not just a tool name: a bounded, secret-scrubbed
  preview of path / command / pattern on the board and dispatch trailer.
- **Task dispatch collapses to a sentence** (description, else prompt) instead of
  dumping raw argument JSON; expanded detail uses real line breaks.
- **Fleet progress reports without a prompt**; bursts settle to one row per agent;
  a mid-rebuild drop surfaces a not-delivered notice.
- **`/new` and `/clear` wipe the painted transcript** and cancel live sub-agents
  so orphans do not keep burning tokens under the old session.

### Thrash and leaf salvage

- **`intent=implement` that never edits is not a successful complete.** Tool-using
  leaves that never write salvage as never-edited and hard-block identical
  re-dispatch (same path as never-acted and thrash).
- **Soft mid-run re-read nudge** before the hard thrash stop: implement leaves are
  asked to edit or wrap up; explore leaves are asked to expand findings or change
  approach — never forced into edit.
- **Format characters no longer break loop detection.** Zero-width spaces, BOM,
  bidi marks, soft hyphens, and word joiners are stripped before period detection.

### Steering and interrupt

- **Queue and steer are one mid-run gesture**; stop-and-reinject cuts the current
  turn and puts a new instruction in its place.
- **Queued operator input survives Ctrl+C** instead of being discarded.

### Permissions and workspace

- **`--dangerously-skip-permissions` reaches pre-gate sandboxes** (path-escape,
  delete, list_dir, shell cwd). Secret-guard path denies and authz hard blocks
  are unchanged.
- **Contained git worktree ops auto-allow in auto mode**, through the same
  workspace-containment authority as shell path restrictions.
- **`manage_tasks` no longer asks for approval.**
- **Queued approval timers arm only when the gate is shown.**

### Goal mode removed

The goal subsystem is gone end to end — runtime, TUI chrome, slash commands, and
docs. Continuous work is the orchestrator plus task dispatch.

### TUI

- **OpenTUI shell flattened into `src/tui/`** — one product root (path rewrite only).
- **Landing snow paints**; mountain and hero survive startup load notices.
- **Slash popup** shows `/name` only; Ctrl+O palette and bare `?` are removed.
- **Semantic activity ticker**; skill and agent names highlight in the prompt;
  duplicate pasted images are rejected by content hash.
- **MCP auth banner clears** after mid-session re-auth succeeds.

### Sessions and process

- **Active-run liveness is one write**; crashed sessions no longer list as running
  forever; a rotated session stays crash-coverable.
- **SIGINT / SIGTERM / SIGHUP terminate the process**; a detached throw restores
  the terminal before exit.

### Providers and onboarding

- **In-session provider connect actually connects**; onboarding validates a
  credential before reporting a provider as configured.
- **Model picker no longer overwrites the persisted default** when you only
  inspect models.
- OAuth success footer links the product site and GitHub.

### Vendoring, telemetry, hygiene

- **`@intx/types`, `@intx/storage-isogit`, and `@intx/inference` vendored at
  Interchange head** (local inference patches reapplied); licenses recorded and
  re-sync documented.
- Process-wide session id on every capture; PostHog AI events in privacy mode;
  expanded anonymous product event catalog.
- **Grep results go through the secret scrub.**
- Shared helpers for grep truncation, MCP tool identifiers, pricing tree walks,
  and grant scoping; nightly random-seed CI job dropped.

## [0.2.93] - 2026-08-08

Running several sub-agents at once was close to unusable. The watchdog meant to
catch a hung run was killing healthy ones, approvals piled up one at a time and
printed twice, and the panel showing what each agent was doing had collapsed to
a line of counts. This release fixes that path end to end.

### Sub-agents were being killed mid-run

- **The stall watchdog aborted healthy parallel fan-outs.** Any silence counted
  as a hang, and in a fan-out the first sub-agent to finish flipped the run back
  to awaiting-a-response while the rest still worked. Since the parent emits
  nothing while children run, the whole run read as silent: a no-response notice
  at ninety seconds, then an abort of everything in flight at fifteen minutes.
  The watchdog now consults the outstanding tool calls it was already tracking.
- **The clock also ran while you read an approval.** Blocked-on-the-operator is
  now part of the turn state rather than something only the painter derived, so
  the watchdog and the phase line read one source. Gates still queued behind
  another are covered, not only the one on screen.

### Approvals

- **A grant no longer has to be given once per agent.** Minting one now settles
  every queued request it already covers. The reconciliation lives in the
  permission layer behind a single idempotent settle, so it holds for any
  surface and cannot double-resolve or strand a request. Session teardown denies
  whatever is still queued instead of abandoning it.
- **Every approval wrote two transcript rows.** A screen of approvals read as
  twice as many requests as had happened. There is now exactly one row per
  decision — including denials, timeouts, and aborts, which previously wrote
  nothing, so a refused permission was indistinguishable from a hang.
- **Project-scoped grants never matched a sub-agent.** A grant was stamped with
  the session root while a sub-agent asks from its own git worktree, and the two
  were compared as plain strings — so the agents generating the approvals could
  never benefit from an earlier answer. Both sides now resolve through the
  worktree registry that already governs path containment, by exact match rather
  than prefix.

### Watching the work

- **The live agents panel is back above the prompt** — one row per running
  sub-agent with elapsed time, current tool, and whether it has gone quiet.
  Rows hold position instead of reordering on each event, the zone shrinks a row
  at a time under a short terminal rather than disappearing, and when a fan-out
  exceeds the space the quietest agent stays visible. Rows are measured in
  terminal columns, so a wide-character description cannot overflow the zone.

### Turns that never ended

- **Goal mode stuck at "working" indefinitely.** Two events registered the same
  tool call under different identities — one by id, one by name — so a call was
  counted twice and cleared once, and the turn waited forever on work that had
  finished. Goal mode was worst affected because it continues on its own and
  never emits the fallback that settles a stalled turn.
- `run.json` records its turn count at every turn boundary rather than only at
  session start and end, so a resumed session reports what it actually did.

## [0.2.92] - 2026-08-07

A second sweep over the OpenTUI cutover, plus a rebuilt model surface. Two of
these faults could end a session outright, and several were behaviour that had
been fixed once already and lost when the renderer was replaced.

### Model selection

The picker lists providers first and descends into models on select, with
Escape returning to the provider level. Recents and favourites stay flat at the
top, and each account appears as its own row.

- **Model tiers are gone.** `settings.tiers`, `profile.tier`, and the
  `task(tier=)` argument no longer exist, and `/fast`, `/standard`, and
  `/clever` are retired rather than remapped — a tier was a per-name fallback
  chain, which neither a favourite nor a pinned model expresses. Per-agent
  selection continues through `profile.inference`. A settings file containing
  `tiers` still loads; the key is dropped on save.
- **The context meter was wrong by nearly four times** for any provider with a
  custom name. An account-qualified identity did not match the registry, so a
  500k window read as the 128k default. Resolution now tries the identity as
  given, the bare model id, and the canonical provider/model form, and marks a
  figure as estimated only when it genuinely falls back.
- The current model is read from the live session rather than inferred from the
  most recent pick, which mislabelled any session that never opened the picker.

### Sessions could be killed outright

- **Switching models poisoned the conversation permanently.** A reasoning
  signature issued by one provider was replayed to another that could not
  decrypt it, and every subsequent turn failed with HTTP 400. Signatures now
  carry the provider that issued them, so two backends sharing a model name
  cannot replay each other's. Switching accounts on the same provider still
  preserves reasoning continuity.
- **A model that fell into a loop ran unbounded.** Repetition is detected by
  character period within a streaming cycle, and by comparing cycle
  fingerprints across tool calls, so a loop that emits a tool call each pass is
  still caught. Ordinary narration repeated before successive tool calls is
  not.

### The screen

- Plugin diagnostics wrote raw to stderr and corrupted the frame. They now go
  through the log sink, and the warnings that used to vanish with them are
  surfaced where the operator can see them.
- The provider setup screen garbled its own text on short terminals — rows were
  compressed into one another instead of clipping.
- The command palette matches the prompt box width, drops its marker column,
  kind column, and title rule, and marks the selected row by colour rather than
  a grey band.
- An open overlay reserves its own border, title, and content rows before any
  other chrome is allowed to starve it.
- **`/resume` was offering sessions that did not exist.** Demo fixture data was
  shipping in the production bundle and rendering whenever a dependency was
  missing. A missing dependency now produces an honest empty state.
- Dialog choices read as plain English rather than internal names.

### Context and state

- Compaction stopped hollowing out the turns it had just decided to keep. A file
  edit inside the recent window keeps its content.
- `run.json` is finalized when the process crashes, without reading from disk on
  the crash path.
- An `@`-mentioned file outside the workspace is inlined once rather than
  blocked, gated by the sensitive-path list and a total byte cap. That list now
  covers shell histories, system credential files, keychains, browser cookie and
  login stores, and cloud credentials.

### Agents and the machine

- **An agent could rewrite your global git configuration to push**, altering
  every repository on the machine. That now requires operator approval, and a
  scoped push path applies credentials per invocation with nothing written to
  any config file.
- `present`, `manage_goal`, `manage_tasks`, and `lsp` are advertised only when
  they apply.
- Live progress appears on a dispatched sub-agent's transcript row.
- The most recently queued message can be cancelled.

### Development

- **The test suite only passed in one order.** Bun mutates the namespace object
  returned by `await import()` when a module is later mocked, so the usual
  capture-then-restore idiom silently reinstalled the mock process-wide. Under
  randomized order the suite produced over a hundred failures; it now passes
  across every seed tried, and CI runs a fixed seed on each change plus a
  rotating seed nightly.
- `docs/TUI.md` states how the terminal UI is meant to look and behave —
  overlays, selectors, the palette, the prompt box, scrolling, and key macros.
  Nine documents describing the finished migration are retired.

## [0.2.91] - 2026-08-07

A bug-fix release on the OpenTUI cutover. Most of these faults had no visible
symptom: sessions that hung with no way out, memory that grew without bound,
and session state that quietly corrupted itself.

**One behaviour reverses from 0.2.90.** That release gave the mouse to your
terminal so drag-select and copy worked normally. Scrolling then landed in the
prompt instead of the chat, because a terminal with mouse reporting off
translates a wheel tick into arrow-key bytes indistinguishable from a real
keypress — and arrows drive prompt history. The main session shell now takes
the mouse: the wheel scrolls the transcript, arrows still cycle prompt history,
and click-to-expand on tool rows and drag-to-scroll work without pressing
Alt+M first. The cost is native drag-select in the transcript; Alt+M hands the
mouse back when you want to select text, and Alt+C copies a message, tool
output or diff without the mouse at all. The onboarding and session pickers
keep native selection either way.

### Fixed

**Sessions could hang with no way out.**

- Pressing Esc on a permission or operator prompt abandoned the request the
  agent was waiting on. The session hung permanently and Ctrl+C did not
  recover it — the interrupt path never reached that promise. Dismissing now
  resolves it as a denial.
- Goal-mode auto-deny and the tool-watchdog abort were both inert. The
  producer sent a timeout and an abort signal; a locally redeclared event type
  in the renderer silently dropped both, so an unattended run could park on a
  permission prompt forever.
- A permission or operator prompt raised before any transcript row existed
  rendered its title and footer but clipped its choices, because the layout
  asked for room for exactly one option regardless of how many there were.
- Messages typed while the agent was working were queued and never sent. The
  drain waited on a signal that fires once at shutdown rather than at each
  turn boundary.
- A detached throw left the process alive with the event loop held open. Real
  `uncaughtException` and `unhandledRejection` handlers now write a crash
  report and exit non-zero.

**Memory and state grew or drifted without bound.**

- Transcript rows were retained for the life of the process; a 600-row cap was
  lost during the cutover and never restored.
- History past 500 rows could not be reached by scrolling, and every appended
  row rebuilt the whole painted window.
- Concurrent writes to a session's `run.json` are serialized per session, so a
  late progress snapshot can no longer resurrect a finished run as `running`.
- Resuming a session reset `turnsUsed` to zero and dropped its connected MCP
  servers.
- Quitting during an @-mention lookup or a clipboard read could write into
  freed renderer memory.

**The context meter lied, and compaction could not act.**

- The meter read only provider-reported usage with no fallback, so a provider
  that omitted usage left it frozen while real occupancy climbed. It now falls
  back to a local estimate and marks the number as approximate.
- The meter and the compaction governor computed context size from different
  fields, so they could disagree by the full size of the prompt cache.
- The system prompt and tool schemas are counted, having previously been
  omitted from the estimate entirely.
- Compaction armed at a turn count where the compactor was guaranteed to do
  nothing, then re-armed, spinning without progress. Both now derive their
  floor from one definition.

**Input and rendering.**

- Pasting several lines into a terminal that does not negotiate bracketed
  paste sent each line as a separate message.
- Markdown headings no longer flicker while the text below them streams.
- Parallel `task` dispatches paired results to calls by tool name, so three
  concurrent sub-agents could resolve the wrong rows and append orphans. They
  are keyed by call id.
- The onboarding and session pickers no longer turn on mouse reporting, so
  drag-select works there.

### Changed

- The sub-agent concurrency cap is removed. Sub-agents run unbounded, and the
  `maxConcurrentSubAgents` setting no longer exists — an existing settings
  file containing it still loads. Setting it to `0` previously disabled
  sub-agents entirely; that capability is gone with it.

## [0.2.90] - 2026-08-07

The interactive TUI is now OpenTUI. The Ink renderer is deleted, not
feature-flagged, so rollback is the prior tag rather than a setting.

**What moved under your hands.** Ctrl+Enter (or Ctrl+J) inserts a newline;
Shift+Enter only works on terminals that report the modifier. The mouse belongs
to your terminal by default, so drag-select and copy behave normally — Alt+M
takes the mouse when you want click-to-expand or drag-scroll. Quitting is
unchanged: Ctrl+C interrupts, twice exits.

### New Features

- **OpenTUI renderer** — zone-based geometry resolver with per-zone minimums and
  an explicit collapse order, replacing React reconciliation.
- **Multi-line composer** that wraps and grows to 40vh before it scrolls.
- **Copy mode** (Alt+C) writes to the system clipboard on macOS, Windows, and
  Linux, with an OSC 52 fallback for content selection cannot reach.
- **Free-text answers to operator questions** — type a reply instead of picking
  from a list, which the tool had always promised and the interface never had.
- **Live status for hooks, subagent progress, MCP connections and grants**,
  which were emitted but had nothing listening.

### Fixed

- **Standalone binary could not start.** `build:bin` excluded its own native
  module, so a distributed binary had no `node_modules` to resolve it from.
- **Terminal-owned selection.** Mouse reporting is off by default; while it is
  on, the terminal forwards drags to the app and cannot select text.
- **Copy wrote nowhere.** Alt+C had always written to an in-memory array.
- **A crash left the terminal wedged.** An uncaught throw kept the alternate
  screen, mouse reporting and raw mode, and the process survived.
- **Bidirectional overrides reached the approval overlay**, so text could read
  as one thing and run as another at the moment of approval. Model output is
  sanitized too, including sequences split across streaming deltas.
- **Search output ignored its byte cap** on a breach, and had no cap at all on
  hosts without ripgrep.
- **Repeated tool calls dropped every result after the first.**
- **A retried turn painted itself twice.**
- **Approval text wrapped by code units, not columns**, so wide characters
  overflowed the subject being approved.
- **Native buffers leaked** on every transcript repaint, landing clear and
  shell dispose.
- **Onboarding truncated a pasted API key at 1000 characters** without saying so.
- **A question could arrive with no way to answer it** when another overlay
  already held the screen.
- **Resumed sessions dropped `view`, `plan` and `tasks` blocks** silently.
- **Ctrl+D quit mid-edit.** The host claims no key of its own now.

### MCP

- **Authorization moved out of the transcript and into `/mcp`.** A server
  needing OAuth used to dump a raw authorization URL as a transcript row at
  session start — unactionable, uncopyable, and gone once it scrolled away. The
  notice row now names the servers waiting (`mcp granola needs auth (/mcp)`)
  and clears when they connect; nothing blocks usage, an unauthorized server
  simply has no tools.
- **`/mcp` is a real surface** listing every configured server and its live
  state — connected with tool count, needs auth, or failed with the reason.
  Enter on an unauthorized row opens its authorization page in the browser and
  copies the link, so the flow also works over SSH.
- **The OAuth callback page carries the brand.** One page now serves MCP
  servers and inference providers alike, on the terminal's own palette, with
  the mark animating through the same dithered draw/fill timeline as the
  landing. It names what happened — "Linear connected successfully", "Granola
  failed to connect" — and humanizes server names and error codes on the way
  in. Entirely inline: a local authorization callback makes no network call.

### Permissions

- **Shell-block messaging** cites host safety and OOM risk, and names the
  bounded `grep`/`search_files` tools as the alternative, rather than reading as
  a tool-routing preference. Open-ended `find`/`rg`/`grep -r` still hard-deny.
- **Pure directory listing outside the workspace auto-allows again** — `ls`, and
  `tree` bounded by `-L`/`--max-depth` to depth 10. Content readers still ask.
  Unbounded recursive listing (`ls -R`, bare or over-deep `tree`) asks even
  inside the workspace.
- **`tree -o` no longer auto-allows** — a listing command that writes a file is
  not a listing command, and it had been bypassing `write_file` review. Long
  `--recursive` spellings on `ls`, down to every unambiguous abbreviation, are
  caught too.

### Known Issues

- **Shift+Enter** does not insert a newline on terminals that do not report the
  modifier. Ctrl+Enter and Ctrl+J do.
- **Markdown flickers mildly while streaming.** The deterministic cause is
  fixed; a residue remains from the async highlighter.
- Transcript history past 500 rows cannot be scrolled to, and rows are retained
  for the life of the process.
- A detached throw or a signal can leave a session marked running.

## [0.2.89] - 2026-08-05

Patch: models-first `/model` picker and OpenCode Go subscription billing pin.

### New Features

- **Models-first `/model`** — open on a Recent / Favorites / all-models list; Alt+A / Alt+F for favorites; connect is auth-only for Tier A first-class providers.
- **Tier A connect catalog** — OpenAI dual-path (ChatGPT login vs API key), Anthropic, xAI, Z.AI, OpenCode Zen, OpenCode Go; no OpenRouter/Copilot in the first-run list.

### Fixed

- **OpenCode Go billed as Zen PAYG** — central `isOpenCodeGoProvider` / `isOpenCodeGoProviderId` identity; force subscription `OPENCODE_GO_BASE_URL` at catalog load, `buildProviderEntry`, `resolveProvider`, and inference source build so a wrong disk `baseURL` cannot mis-bill.
- **Go model on Zen path** — `isGoModelOnZenPath` warning when a known Go model sits on a credits-billed Zen provider.
- Recent/favorite model prefs serialize writes so concurrent toggles cannot clobber each other.
- Empty success toasts and double-recording of recent models on apply.

## [0.2.88] - 2026-08-04

Hotfix: Homebrew standalone binary failed on first TUI launch.

### Fixed

- Standalone release binaries no longer externalize `react-devtools-core`, which broke first TUI launch after Homebrew install (`Cannot find package 'react-devtools-core'`).

### Changed

- Homebrew formula is **`corbits-code`** (`brew install corbitsdev/tap/corbits-code`). The CLI binary remains `corbits`.

## [0.2.87] - 2026-08-04

Patch release: always-on PerfTrace measurement stack, session state under `~/.corbits/projects`, post-upgrade release notes in the interactive banner, and related Codex/TUI polish.

### New Features

- **Always-on PerfTrace** — in-process span API, ring buffer, and privacy-strict tag allowlist (`src/perf/`). One span model for turns, inference (TTFT/stream), tools, permission waits, and subagents. No settings required for local measurement.
- **Offline dump + rollup** — `dumpSpans` and pure rollups by phase/turn/session; TTFT vs stream shares.
- **Attribution report** — exclusive wall-time shares (inference / tools / permission / subagent / other), open-turn stall dumps, CLI `bun scripts/perf-report.ts`, operator guide in `docs/perftrace-attribution-guide.md`.
- **Opt-in OTEL export** — settings/env surface (`OTEL_EXPORTER_OTLP_*`, `~/.corbits/settings.json` `otel` block) plus OTLP HTTP JSON sink. Fail-closed config; dump-safe header redaction. Targets Phoenix, PostHog OTEL, or any OTLP collector — separate from PostHog product analytics.
- **Latency eval harness** — assert phase presence and relative magnitudes in tests (`assert-spans`, multi-tool fixture).
- **Reasoning effort by agent role** — orchestrator vs task-leaf defaults so high-effort leaves stop multiplying wall time.
- **Session state under `~/.corbits/projects`** — project key from git toplevel (worktrees share); dual-read migrate from in-repo `.agent-state`; path-restriction exception for the global state root.
- **Post-upgrade release notes** — on a fresh interactive start after upgrade, show bounded Keep-a-Changelog sections in the session banner; stamp `lastChangelogVersion` in global settings; first install is quiet; `/changelog` and `/changelog full` for on-demand history. Ships `CHANGELOG.md` next to release binaries.
- **Streaming stall / loop detection** — trailing-window repetition detection; preserve partial streamed output in exec and TUI; partial-capture lifecycle owned by the cycle recorder.
- **Nested UI polish** — quieter chrome, context meter, task/shell rows, observe-leave behavior.
- **Approval queue re-eval** — when a grant widens, re-check the pending queue; stored approvals evaluated through `@intx/authz`.
- **Task re-dispatch cap** — parents stop re-dispatching identical thrashing / budget-exhausted briefs.

### Fixed

- Hard-deny shell authz through `env -S` / split-string payloads (including empty payload and end-of-options forms).
- Streaming markdown tables stay on one column-width set (no mid-stream realign / raw-pipe degradation).
- Shell approval modal scroll, expand, and agent-label display; shared scroll-window math.
- Worktree preserve: do not drop stash when unknown or detached HEAD advanced; count gitignored-but-present files as content worth keeping. (related main commits)
- Judge shell auto-allow and restriction against the process cwd; queued-grant coverage uses the session path restriction.

### Changed

- Package rename: root package is `@corbits/code` (was `corbits`).
- Homebrew release tap points at `corbitsdev/homebrew-tap`.
- TUI root and event log split into focused modules (assembly vs presentation).
- Sub-agent tool description no longer claims an incorrect working-tree isolation model.

### Docs / tooling

- `docs/PERFTRACE.md` — local sink, OTEL config, collector examples, relationship to product telemetry.
- Codex request parity checklist (spike, no production behavior change).
- Codex SSE golden fixture pack + parse tests.

## [0.2.86] - 2026-07-30

Patch release: agents use the core tools. Every behavior change validated by a before/after eval matrix on grok-4.5 — pass rate 19/21 → 21/21, total turns 312 → 106, input tokens 2.8M → 1.1M, zero sub-agent churn on the stall fixture.

### New Features

- Built-in `web_fetch` (native fetch, markdown output, SSRF guards) and `web_search` (keyless hosted providers) replace the plugin-only web tools ().
- Per-project `settings.env` supplies shell environment as configuration instead of commands.
- Model-family policy drives the directors: main sessions get a wrap-up nudge and a loud auto-pause on runaway tool-only loops; silent sub-agents get a continuation nudge then a clean stop; grok thresholds tightened ().
- A shared prompt discipline block steers every model to dedicated tools, single-purpose commands, and finishing behavior ().
- The capability eval is now a behavior gate: bait cases, behavior metrics, repeat runs, provider pinning with loud mismatch failure, and honest baseline comparison ().

### Security

- Command substitution inside double quotes stays visible to grant replay ().
- Persisted grants no longer key on model-authored comment lines ().
- Chains of five or more segments are approved once only; env assignments (including `env -S` smuggling, scanned deny-first) and upload-shaped network commands now ask ().

### Fixed

- Sub-agents receive the web tools and project env the prompt promises them; the family policy reaches interactive sessions; approval and error copy states thresholds and next steps.

## [0.2.85] - 2026-07-29

Patch release: shell permission hardening, sub-agent dispatch controls, and a live TUI test suite.

### Security

- Command substitution (`` `...` ``, `$(...)`) no longer auto-allows, and substituted paths stay visible to the restricted-target check.
- Authz-hard-blocked commands deny at the gate instead of showing an Accept button.
- Restricted targets are re-checked when replaying a stored grant.
- Glob metacharacters are escaped in persisted exact-command grants.
- Relative `pluginPaths` entries are dropped at trust migration instead of resolving against the launch directory.

### New Features

- Task tiers resolve OAuth providers from the live catalog.
- Typed task spawn contract: intent, success criteria, do-not list, report focus, with intent-driven soft defaults for tools, tier, and turn budget.
- Sub-agent thrash detection with re-read caps and a one-shot wrap-up nudge near the turn budget; Grok leaf agents get a finish-bias prompt residual.

### Fixed

- A stale approval-prompt resume no longer unfreezes a newer tool-budget pause.
- The TUI test suite runs again (1105 tests were dark from a Bun isolate regression).

## [0.2.84] - 2026-07-29

Patch release: permission-approval hardening and plugin trust fixes.

### Fixed

- Tool timeout freezes while a permission prompt is open; toggle via Settings → Tools.
- Path-added plugin trust is global, revocable from `/plugins`, and survives directory changes.
- Install docs and package metadata point at corbits-code and the `dist/corbits` binary.

### Changed

- Chained shell commands prompt once for the whole chain; multi-segment grants are exact-match only and the modal strips spoofing characters.

## [0.2.83] - 2026-07-27

Patch release: reverts the inline transcript renderer.

### Fixed

- **Alternate-screen transcript restored** — the inline renderer emitted committed history into the terminal's native scrollback, so a running session could be scrolled out of, and a live tail shorter than the viewport left a large blank region between the transcript and the prompt. Reverts the differential-inline cutover, bringing back the full-screen alternate buffer, mouse-wheel scrolling, and the app-owned viewport.

## [0.2.82] - 2026-07-26

Patch release: safety, subagent performance, TUI polish, persistence correctness, and first-class release packaging. Everything merged after `0.2.81` through `3084b44`.

### New Features

- **`corbits exec` + local capability eval harness** — non-interactive product path and fixture-based capability suite for regression gates.
- **FIFO operator approval queue** — plan, permission, and operator modals no longer race; one gate at a time.
- **Release packaging** — `scripts/release.sh` builds macOS/Linux binaries, checksums, debs, GitHub release assets, and Homebrew tap formula.
- **Diff polish** — background washes on edit hunks and `+N/-M` stats on collapsed rows.
- **Theme-routed chat chrome** — input and slash menu colors go through the theme.

### Safety

- Scrub and truncate MCP tool results; strip terminal control sequences from tool output.
- Secret denylist covers cloud and keychain credential shapes.
- Fail-closed shell pre-approval: no multi-segment grants.
- Auto-mode shell asks when the command targets paths outside the workspace.
- Shell guard allows piped search without unblocking open-ended tree walks.
- Reject `tool-output://` URIs before they reach ripgrep or the filesystem.
- Constrain `@`-mention file resolution to the workspace root.
- Allow sibling worktree paths past pre-realpath path confinement.

### Tools

- `edit_file` line-range edits always run post-write verification.
- Reject conflicting `edit_file` modes (substring vs line-range exclusive).
- Partial `grep` results on ripgrep size cap or timeout.
- Cap long error output and show a pass/fail glyph on shell failures.
- Coalesce stray redirect fragments back into their owning shell command.

### Subagents & performance

- Cache subagent session snapshots by revision instead of cloning on every notify.
- Dedup tool names on the `tool_call.start` path in the session store.
- Skip retaining full turn history when no lifecycle hooks are configured.
- Gate stream drain intervals to streaming and flush on stop.

### Correctness

- Validate persistence boundaries with arktype and unify goal-status enums.
- Record real cache-write token counts instead of hardcoding zero.
- Fall back to 256-color values on non-truecolor terminals.

## [0.2.81] - 2026-07-25

### Changed

- Rename Intercode → **Corbits Code** with `corbits` CLI hard cutover.
- Migrate legacy `.intercode` settings on first Corbits run.
- Minimal anonymous PostHog telemetry with hard opt-out (see `docs/TELEMETRY.md`).

## [0.2.80] - 2026-07-24

### New Features

- Inject full agent profile bodies into `search_agents`.
- Sub-agents can re-read parent `tool-output://` blobs.
- Cancel salvage and optional `task` tier override.
- Claude marketplace plugin discovery when opted in.
- Never-acted salvage when a sub-agent uses no tools.
