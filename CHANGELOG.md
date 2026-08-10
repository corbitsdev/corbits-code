# Changelog

All notable changes to Corbits Code are documented here.

Format loosely follows [Keep a Changelog](https://keepachangelog.com/). Versions are `package.json` / `vX.Y.Z` git tags cut by `scripts/release.sh`.

## [Unreleased]

### Planned

- Local context estimate for compaction when providers omit usage
- Image age → rehydratable attachment URI
- Always-return subagent salvage without a default wall-clock death clock
- Transcript rendering engine with per-line damage tracking, replacing whole-frame repaints

### Operator follow-ups

- Dogfood a real pain-session PerfTrace dump and write the transport prioritization decision
- Live OTEL collector verify (Phoenix or equivalent) against the merged sink
- Dogfood session migrate: new session under `~/.corbits/projects`, one legacy `.agent-state` migrate, write under state root still asks
- Wire an in-app whats-new surface so upgrade notes can stamp `lastChangelogVersion` again (CL-5475 left stamping off until a surface returns)
- Optional opt-out / cache for the GitHub upgrade probe on TUI start

### TUI

- **Flat model picker.** Choosing a model is one type-to-filter list of
  `provider / model` rows — no nested provider drill-down. Type to narrow,
  Enter selects; Alt+F still toggles favorites when wired. Filtered accept
  uses the row's stable id (never the unfiltered catalog index).
- **Drag-select auto-copy.** With mouse capture on (the default), finishing a
  drag selection in the transcript writes the selected text to the system
  clipboard on mouse-up and flashes a short status line. Alt+M still hands the
  mouse back for native terminal selection; Alt+C remains the keyboard copy
  path for whole messages, tool outputs, and diffs. Highlight clears
  immediately; status flash only after the clipboard write settles — success
  shows the preview, throw/reject shows `Copy failed` (same honesty on Alt+C
  structured copy).
- **Install-aware upgrade notice.** When a newer GitHub release exists, a
  non-blocking startup notice names the running and latest versions and the
  right upgrade step for Homebrew, source/Bun, deb, release binary, or
  unknown. Network and detection failures skip quietly.
- **Bottom breathing room.** The prompt box sits one blank row above the
  terminal's last line on terminals tall enough to spare it
  (`BOTTOM_MARGIN_ROWS`, collapsed below 24 rows), so the layout no longer
  feels flush against the frame edge.
- **User-message breathing room.** Operator turns in the transcript keep a
  blank bar row above and below the message text, so user prompts are easier
  to spot while scrolling through assistant and tool rows (CL-5603).
- **Landing survives MCP connect failure.** An MCP status failure still
  routes through the system-notice channel and cannot wipe the mountain
  landing by falling through to a stream-row path.
- **Approval-overlay overflow tests.** Short-terminal guarantees for the
  permission/operator gate overlays are pinned: viewport shrinks under the
  host fraction cap, every choice stays reachable, and gate-wire paths still
  resolve the selected outcome.

### Session

- **Superseded read stubs.** When compaction keeps more than one successful
  `read_file` of the same path (or same path+offset+limit range), older results
  become a one-line stub and the newest stays whole. Errors stay verbatim.
  Dedup only considers turns that survive compaction, so a summarized re-read
  cannot hollow a kept older body.
- **Changelog watermark honesty.** The OpenTUI path no longer stamps
  `lastChangelogVersion` as a side effect of computing upgrade notes it never
  shows. First-install still stamps; upgrade stamps only when notes are
  actually shown (currently no surface, so upgrades never mark-seen).

### Reliability

- **Ripgrep stdout byte cap.** Close settlement waits one turn for queued
  stdout so the over-cap path cannot report a full success on Linux CI; the
  cap is re-checked on every settle path.

### Tooling

- **Vendored patch ledger.** `bin/vendor-patch-diff` and
  `vendor/intx-inference/PATCHES.md` site markers prove local patches against
  upstream without a manual re-sync checklist.
- **Single `@intx/types` identity.** `tsconfig` paths pin vendored
  `@intx/types` so local typecheck matches CI even when a nested published
  copy still exists under another package.
- **PostHog app version.** Telemetry dual-stamps package version as both
  `service_version` and PostHog's standard `$app_version` so the built-in
  Version breakdown works.
- **Permission docs truth.** Architecture notes describe the live permission
  queue and worktree-aware grants; stale `use-gates` references are gone.
- **AGENTS.md plans pointer.** `docs/plans/` is back as a Reference list item
  (gitignored, non-normative working notes).

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
  (CL-5641)
- **The clock also ran while you read an approval.** Blocked-on-the-operator is
  now part of the turn state rather than something only the painter derived, so
  the watchdog and the phase line read one source. Gates still queued behind
  another are covered, not only the one on screen. (CL-5642)

### Approvals

- **A grant no longer has to be given once per agent.** Minting one now settles
  every queued request it already covers. The reconciliation lives in the
  permission layer behind a single idempotent settle, so it holds for any
  surface and cannot double-resolve or strand a request. Session teardown denies
  whatever is still queued instead of abandoning it. (CL-4995)
- **Every approval wrote two transcript rows.** A screen of approvals read as
  twice as many requests as had happened. There is now exactly one row per
  decision — including denials, timeouts, and aborts, which previously wrote
  nothing, so a refused permission was indistinguishable from a hang. (CL-5644)
- **Project-scoped grants never matched a sub-agent.** A grant was stamped with
  the session root while a sub-agent asks from its own git worktree, and the two
  were compared as plain strings — so the agents generating the approvals could
  never benefit from an earlier answer. Both sides now resolve through the
  worktree registry that already governs path containment, by exact match rather
  than prefix. (CL-5662)

### Watching the work

- **The live agents panel is back above the prompt** — one row per running
  sub-agent with elapsed time, current tool, and whether it has gone quiet.
  Rows hold position instead of reordering on each event, the zone shrinks a row
  at a time under a short terminal rather than disappearing, and when a fan-out
  exceeds the space the quietest agent stays visible. Rows are measured in
  terminal columns, so a wide-character description cannot overflow the zone.
  (CL-5646)

### Turns that never ended

- **Goal mode stuck at "working" indefinitely.** Two events registered the same
  tool call under different identities — one by id, one by name — so a call was
  counted twice and cleared once, and the turn waited forever on work that had
  finished. Goal mode was worst affected because it continues on its own and
  never emits the fallback that settles a stalled turn. (CL-5645)
- `run.json` records its turn count at every turn boundary rather than only at
  session start and end, so a resumed session reports what it actually did.
  (CL-5570, CL-5534)

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
  `tiers` still loads; the key is dropped on save. (CL-5591)
- **The context meter was wrong by nearly four times** for any provider with a
  custom name. An account-qualified identity did not match the registry, so a
  500k window read as the 128k default. Resolution now tries the identity as
  given, the bare model id, and the canonical provider/model form, and marks a
  figure as estimated only when it genuinely falls back. (CL-5587)
- The current model is read from the live session rather than inferred from the
  most recent pick, which mislabelled any session that never opened the picker.
  (CL-5597)

### Sessions could be killed outright

- **Switching models poisoned the conversation permanently.** A reasoning
  signature issued by one provider was replayed to another that could not
  decrypt it, and every subsequent turn failed with HTTP 400. Signatures now
  carry the provider that issued them, so two backends sharing a model name
  cannot replay each other's. Switching accounts on the same provider still
  preserves reasoning continuity. (CL-5592, CL-5594)
- **A model that fell into a loop ran unbounded.** Repetition is detected by
  character period within a streaming cycle, and by comparing cycle
  fingerprints across tool calls, so a loop that emits a tool call each pass is
  still caught. Ordinary narration repeated before successive tool calls is
  not. (CL-5577)

### The screen

- Plugin diagnostics wrote raw to stderr and corrupted the frame. They now go
  through the log sink, and the warnings that used to vanish with them are
  surfaced where the operator can see them. (CL-5411)
- The provider setup screen garbled its own text on short terminals — rows were
  compressed into one another instead of clipping. (CL-5363)
- The command palette matches the prompt box width, drops its marker column,
  kind column, and title rule, and marks the selected row by colour rather than
  a grey band. (CL-5581, CL-5582, CL-5583, CL-5584)
- An open overlay reserves its own border, title, and content rows before any
  other chrome is allowed to starve it. (CL-5584)
- **`/resume` was offering sessions that did not exist.** Demo fixture data was
  shipping in the production bundle and rendering whenever a dependency was
  missing. A missing dependency now produces an honest empty state. (CL-5596)
- Dialog choices read as plain English rather than internal names. (CL-5586)

### Context and state

- Compaction stopped hollowing out the turns it had just decided to keep. A file
  edit inside the recent window keeps its content. (CL-5595)
- `run.json` is finalized when the process crashes, without reading from disk on
  the crash path. (CL-5574)
- An `@`-mentioned file outside the workspace is inlined once rather than
  blocked, gated by the sensitive-path list and a total byte cap. That list now
  covers shell histories, system credential files, keychains, browser cookie and
  login stores, and cloud credentials. (CL-5479)

### Agents and the machine

- **An agent could rewrite your global git configuration to push**, altering
  every repository on the machine. That now requires operator approval, and a
  scoped push path applies credentials per invocation with nothing written to
  any config file. (CL-4762)
- `present`, `manage_goal`, `manage_tasks`, and `lsp` are advertised only when
  they apply. (CL-5588)
- Live progress appears on a dispatched sub-agent's transcript row. (CL-5576)
- The most recently queued message can be cancelled. (CL-5572)

### Development

- **The test suite only passed in one order.** Bun mutates the namespace object
  returned by `await import()` when a module is later mocked, so the usual
  capture-then-restore idiom silently reinstalled the mock process-wide. Under
  randomized order the suite produced over a hundred failures; it now passes
  across every seed tried, and CI runs a fixed seed on each change plus a
  rotating seed nightly. (CL-5579)
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
  resolves it as a denial. (CL-5569)
- Goal-mode auto-deny and the tool-watchdog abort were both inert. The
  producer sent a timeout and an abort signal; a locally redeclared event type
  in the renderer silently dropped both, so an unattended run could park on a
  permission prompt forever. (CL-5568)
- A permission or operator prompt raised before any transcript row existed
  rendered its title and footer but clipped its choices, because the layout
  asked for room for exactly one option regardless of how many there were.
  (CL-5560)
- Messages typed while the agent was working were queued and never sent. The
  drain waited on a signal that fires once at shutdown rather than at each
  turn boundary. (CL-5563)
- A detached throw left the process alive with the event loop held open. Real
  `uncaughtException` and `unhandledRejection` handlers now write a crash
  report and exit non-zero. (CL-5565)

**Memory and state grew or drifted without bound.**

- Transcript rows were retained for the life of the process; a 600-row cap was
  lost during the cutover and never restored. (CL-5551)
- History past 500 rows could not be reached by scrolling, and every appended
  row rebuilt the whole painted window. (CL-5553)
- Concurrent writes to a session's `run.json` are serialized per session, so a
  late progress snapshot can no longer resurrect a finished run as `running`.
  (CL-5567)
- Resuming a session reset `turnsUsed` to zero and dropped its connected MCP
  servers. (CL-5566)
- Quitting during an @-mention lookup or a clipboard read could write into
  freed renderer memory. (CL-5554)

**The context meter lied, and compaction could not act.**

- The meter read only provider-reported usage with no fallback, so a provider
  that omitted usage left it frozen while real occupancy climbed. It now falls
  back to a local estimate and marks the number as approximate. (CL-5564)
- The meter and the compaction governor computed context size from different
  fields, so they could disagree by the full size of the prompt cache.
- The system prompt and tool schemas are counted, having previously been
  omitted from the estimate entirely.
- Compaction armed at a turn count where the compactor was guaranteed to do
  nothing, then re-armed, spinning without progress. Both now derive their
  floor from one definition.

**Input and rendering.**

- Pasting several lines into a terminal that does not negotiate bracketed
  paste sent each line as a separate message. (CL-5541)
- Markdown headings no longer flicker while the text below them streams.
  (CL-5559)
- Parallel `task` dispatches paired results to calls by tool name, so three
  concurrent sub-agents could resolve the wrong rows and append orphans. They
  are keyed by call id. (CL-5562)
- The onboarding and session pickers no longer turn on mouse reporting, so
  drag-select works there. (CL-5540)

### Changed

- The sub-agent concurrency cap is removed. Sub-agents run unbounded, and the
  `maxConcurrentSubAgents` setting no longer exists — an existing settings
  file containing it still loads. Setting it to `0` previously disabled
  sub-agents entirely; that capability is gone with it. (CL-5575)

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
  an explicit collapse order, replacing React reconciliation. (CL-4426)
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
  simply has no tools. (CL-5555)
- **`/mcp` is a real surface** listing every configured server and its live
  state — connected with tool count, needs auth, or failed with the reason.
  Enter on an unauthorized row opens its authorization page in the browser and
  copies the link, so the flow also works over SSH. (CL-5555)
- **The OAuth callback page carries the brand.** One page now serves MCP
  servers and inference providers alike, on the terminal's own palette, with
  the mark animating through the same dithered draw/fill timeline as the
  landing. It names what happened — "Linear connected successfully", "Granola
  failed to connect" — and humanizes server names and error codes on the way
  in. Entirely inline: a local authorization callback makes no network call.
  (CL-5556)

### Permissions

- **Shell-block messaging** cites host safety and OOM risk, and names the
  bounded `grep`/`search_files` tools as the alternative, rather than reading as
  a tool-routing preference. Open-ended `find`/`rg`/`grep -r` still hard-deny.
  (CL-5421, #328)
- **Pure directory listing outside the workspace auto-allows again** — `ls`, and
  `tree` bounded by `-L`/`--max-depth` to depth 10. Content readers still ask.
  Unbounded recursive listing (`ls -R`, bare or over-deep `tree`) asks even
  inside the workspace. (CL-5422, #329)
- **`tree -o` no longer auto-allows** — a listing command that writes a file is
  not a listing command, and it had been bypassing `write_file` review. Long
  `--recursive` spellings on `ls`, down to every unambiguous abbreviation, are
  caught too. (#329)

### Known Issues

- **Shift+Enter** does not insert a newline on terminals that do not report the
  modifier. Ctrl+Enter and Ctrl+J do.
- **Markdown flickers mildly while streaming.** The deterministic cause is
  fixed; a residue remains from the async highlighter.
- Transcript history past 500 rows cannot be scrolled to, and rows are retained
  for the life of the process. (CL-5553, CL-5551)
- A detached throw or a signal can leave a session marked running. (CL-5552)

## [0.2.89] - 2026-08-05

Patch: models-first `/model` picker and OpenCode Go subscription billing pin.

### New Features

- **Models-first `/model`** — open on a Recent / Favorites / all-models list; Alt+A / Alt+F for favorites; connect is auth-only for Tier A first-class providers. (CL-5355, #327)
- **Tier A connect catalog** — OpenAI dual-path (ChatGPT login vs API key), Anthropic, xAI, Z.AI, OpenCode Zen, OpenCode Go; no OpenRouter/Copilot in the first-run list. (CL-5355, #327)

### Fixed

- **OpenCode Go billed as Zen PAYG** — central `isOpenCodeGoProvider` / `isOpenCodeGoProviderId` identity; force subscription `OPENCODE_GO_BASE_URL` at catalog load, `buildProviderEntry`, `resolveProvider`, and inference source build so a wrong disk `baseURL` cannot mis-bill. (CL-5356, #327)
- **Go model on Zen path** — `isGoModelOnZenPath` warning when a known Go model sits on a credits-billed Zen provider. (#327)
- Recent/favorite model prefs serialize writes so concurrent toggles cannot clobber each other. (#327)
- Empty success toasts and double-recording of recent models on apply. (#327)

## [0.2.88] - 2026-08-04

Hotfix: Homebrew standalone binary failed on first TUI launch.

### Fixed

- Standalone release binaries no longer externalize `react-devtools-core`, which broke first TUI launch after Homebrew install (`Cannot find package 'react-devtools-core'`).

### Changed

- Homebrew formula is **`corbits-code`** (`brew install corbitsdev/tap/corbits-code`). The CLI binary remains `corbits`.

## [0.2.87] - 2026-08-04

Patch release: always-on PerfTrace measurement stack, session state under `~/.corbits/projects`, post-upgrade release notes in the interactive banner, and related Codex/TUI polish.

### New Features

- **Always-on PerfTrace** — in-process span API, ring buffer, and privacy-strict tag allowlist (`src/perf/`). One span model for turns, inference (TTFT/stream), tools, permission waits, and subagents. No settings required for local measurement. (CL-5160, #303; CL-5171, #305; CL-5170, #308)
- **Offline dump + rollup** — `dumpSpans` and pure rollups by phase/turn/session; TTFT vs stream shares. (CL-5169, #307)
- **Attribution report** — exclusive wall-time shares (inference / tools / permission / subagent / other), open-turn stall dumps, CLI `bun scripts/perf-report.ts`, operator guide in `docs/perftrace-attribution-guide.md`. (CL-5167, #311)
- **Opt-in OTEL export** — settings/env surface (`OTEL_EXPORTER_OTLP_*`, `~/.corbits/settings.json` `otel` block) plus OTLP HTTP JSON sink. Fail-closed config; dump-safe header redaction. Targets Phoenix, PostHog OTEL, or any OTLP collector — separate from PostHog product analytics. (CL-5175, #306; CL-5173, #309)
- **Latency eval harness** — assert phase presence and relative magnitudes in tests (`assert-spans`, multi-tool fixture). (CL-5174, #310)
- **Reasoning effort by agent role** — orchestrator vs task-leaf defaults so high-effort leaves stop multiplying wall time. (CL-5162, #302)
- **Session state under `~/.corbits/projects`** — project key from git toplevel (worktrees share); dual-read migrate from in-repo `.agent-state`; path-restriction exception for the global state root. (CL-5257, #313)
- **Post-upgrade release notes** — on a fresh interactive start after upgrade, show bounded Keep-a-Changelog sections in the session banner; stamp `lastChangelogVersion` in global settings; first install is quiet; `/changelog` and `/changelog full` for on-demand history. Ships `CHANGELOG.md` next to release binaries. (CL-5333, CL-5332, CL-5334, #314)
- **Streaming stall / loop detection** — trailing-window repetition detection; preserve partial streamed output in exec and TUI; partial-capture lifecycle owned by the cycle recorder. (#280, #281)
- **Nested UI polish** — quieter chrome, context meter, task/shell rows, observe-leave behavior. (#312)
- **Approval queue re-eval** — when a grant widens, re-check the pending queue; stored approvals evaluated through `@intx/authz`. (#288, #295)
- **Task re-dispatch cap** — parents stop re-dispatching identical thrashing / budget-exhausted briefs. (#294)

### Fixed

- Hard-deny shell authz through `env -S` / split-string payloads (including empty payload and end-of-options forms). (#278)
- Streaming markdown tables stay on one column-width set (no mid-stream realign / raw-pipe degradation). (#277)
- Shell approval modal scroll, expand, and agent-label display; shared scroll-window math. (#279 train / related)
- Worktree preserve: do not drop stash when unknown or detached HEAD advanced; count gitignored-but-present files as content worth keeping. (related main commits)
- Judge shell auto-allow and restriction against the process cwd; queued-grant coverage uses the session path restriction.

### Changed

- Package rename: root package is `@corbits/code` (was `corbits`). (#282)
- Homebrew release tap points at `corbitsdev/homebrew-tap`. (#283)
- TUI root and event log split into focused modules (assembly vs presentation). (#285, #286)
- Sub-agent tool description no longer claims an incorrect working-tree isolation model.

### Docs / tooling

- `docs/PERFTRACE.md` — local sink, OTEL config, collector examples, relationship to product telemetry.
- Codex request parity checklist (spike, no production behavior change). (CL-5168, #304)
- Codex SSE golden fixture pack + parse tests. (CL-5166, #301)

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
