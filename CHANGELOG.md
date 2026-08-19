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

### MCP

- **Late-connected MCP tools are callable the same turn they appear in `tool_search`.**
  `@intx/agent` snapshots dispatch names at `createAgent`, and the post-connect
  reload that used to rebuild that snapshot waited for every server — including
  one stuck on OAuth. Cataloged `mcp__*` tools then returned `unknown tool`.
  Construction now dispatches misses through the live runner, so Linear/Exa
  (and any other server that finished) work even while another server still
  needs auth.

### TUI

- **Settled permission and operator prompts no longer recap into the chat.**
  The overlay is the question; answering it used to leave a grey
  `permission` / `operator` card restating the same command and the chosen
  option. After a decision those recap rows are gone — the tool row that
  follows is the outcome. Expanding a collapsed payload while the overlay is
  still open still writes the full payload into the transcript, because that
  text would otherwise be unreachable before approval.

### Evals

- **Capability eval records `task` tool calls.** `taskToolCallCount` is derived
  from the turn stream (informational). Older result files without the field
  default from `toolCallsByName.task` so the frozen baseline still parses.
- **Capability eval smoke cases for dispatch and recall.** `complex-dispatch-spawn`
  requires at least one `task()` plus a working GET /readyz.
  `complex-recall-after-bulk-read` plants a token, asks the agent to read the
  fixture, then write it back. Informational only — not in the frozen
  baseline-0286 gate until a deliberate refreeze. Neither case proves
  compaction fired or that the primary skipped implementing the route.

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
  `psf__requests-3362`), pinned to prepaid `xai/thegreataxios` + `grok-4.5`, and
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
