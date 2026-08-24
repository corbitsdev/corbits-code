# Corbits Code — Architecture

## System Overview

The system is an event-driven agent loop with a custom reactor director. The CLI parses arguments, builds a `Config`, creates an agent with sandboxed tools and a `ChatDirector`, and consumes the event stream through an OpenTUI-based TUI. The director layers chat semantics, compaction, and workflow coordination on the reactor's default behavior; tool-layer middleware (authorization, permission gate, verification) enforces hard constraints before tools run. Delegated work runs through a second, sub-agent director on the same loop.

## The Reactor Loop

The reactor (from `@intx/agent`) drives a single agent turn-by-turn. Each turn is:

1. **Inference** — the LLM produces an assistant turn (text plus zero or more `tool_call` blocks).
2. **Tool dispatch** — each `tool_call` runs concurrently; results return as `tool.done` events.
3. **Director decision** — the director's `decide()` receives every event and returns `ReactorAction[]` that control what happens next.

This repeats until the director emits `capabilities.done()`.

### Reactor Events (Partial)

This table is not the full reactor/stream event vocabulary. `tool.done` is
here because the sub-sections below reference it; `inference.done` and
`reactor.done` are the two events that `src/agent/reactor-events.ts`
exports guards for (`onTurnBoundary` / `onReactorShutdown`) — see the
paragraph after the table. The complete set of reactor and stream event
types the TUI maps is `PRODUCTION_REACTOR_TYPES` in
`src/tui/stream-event-map.ts:62-78` (covering `message.received`,
`inference.start`, `inference.text.delta`, `inference.tool_call.start` /
`.delta` / `.end`, `tool.start`, and `connector.reply`, among others) —
treat that as canonical rather than this table or any other doc's partial
list.

| Event            | When it fires                                                                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `inference.done` | The LLM finished one assistant turn. Carries the full turn content. Fires once per turn, every turn — this is the **turn boundary**. |
| `tool.done`      | One tool call completed. Carries the result and the original `callId`.                                                               |
| `reactor.done`   | The reactor loop shut down. Fires once, at the end of the run — not between turns.                                                   |

`inference.done` and `reactor.done` read as near-synonyms at a call site but
answer different questions: "did a turn end" versus "did the reactor shut
down." Code that needs either answer should go through the `onTurnBoundary`
/ `onReactorShutdown` guards in `src/agent/reactor-events.ts` rather than
comparing `event.type` to a string directly — naming the question makes the
right thing easier to write than the wrong one.

This is a convention, not an enforced constraint: nothing stops a future
call site from writing `event.type === "reactor.done"` directly instead of
reaching for the guard.

### ReactorActions

The director returns actions that shape the loop:

- `capabilities.continue()` — run another inference turn (implicit default).
- `capabilities.reply(text)` — inject a synthetic tool result into the next turn's context.
- `capabilities.checkpoint(label)` — persist a named checkpoint under the session state root (`~/.corbits/projects/...`).

- `capabilities.done()` — terminate the loop.

### Director-layer termination

In TUI chat mode there is no completion gate — the session stays open across turns until the operator clears or starts a new session. The ChatDirector never emits `done()`; even an operator decline is surfaced as a reply while the reactor stays alive. Sub-agents terminate themselves: a turn without tool calls ends the run with the final assistant text as the result.

## Components

### CLI Entry (`src/index.ts`)

- Parses arguments and `--help`
- Dispatches to `runTUI` (default), `runExec` for `corbits exec` / `corbits run`, or first-run onboarding when unconfigured

### Config Resolution (`src/config/index.ts`, `src/config/settings.ts`)

- Resolves the inference provider from layered sources into `{ apiKey, baseURL, model, providerName }` — the struct the runtime consumes. Per field, highest wins: CLI flags (`--provider`/`--model`) > per-repo `.corbits/settings.json` (selection only) > global `~/.corbits/settings.json`. Credentials come only from the settings files — no environment-variable override, and `.env` is not loaded.
- `--config <path>` replaces the global settings file as the provider source (useful for CI per-run injection). A provider must be defined in a settings file; there is no env fallback.
- `settings.ts` owns the schema, validators (the per-repo file rejects credentials), file loaders, and the pure `resolveProvider` precedence function.
- `providers.ts` defines the `ProviderCatalogEntry` type and helpers for building TUI provider lists; `profiles.ts` handles profile-level selection logic.
- `loadConfig` is async (it reads settings files). Parses a leading `exec`/`run` subcommand, flags `--cwd`, `--config`, `--provider`, `--model`, `--force`, `--dangerously-skip-permissions` (forces this process; TUI `/yolo` persists as the user-global default), `--auto` / `--no-auto` (auto mode defaults on); collects positional arguments as the optional initial task for the TUI or the required prompt for exec.
- Both settings files are on the secret-guard denylist for path-keyed tools, so the agent cannot `read_file` its own credentials. Shell commands that reference them still require explicit operator approval.

### TUI Runner (`src/tui/runner.ts`)

- Builds a chat-mode agent using the `ChatDirector`
- Wires `ask_operator` to an operator-gate event resolved by a modal
- Mounts the OpenTUI host via `mountRunnerHost` (`src/tui/runner-host.ts`), which mounts `mountProductHost` (`src/tui/product-host.ts`) over the shell (`src/tui/shell.ts`)
- Bridges reactor events to the OpenTUI host via a plain `EventEmitter`
- **Mid-run injection** — When a message arrives while the agent is running, it is queued in an `InjectionQueue`. On the next `inference.done` event (turn boundary), the queue is drained: each queued message is delivered via `agentProxy.deliver()` and a `"mid-run.delivered"` emitter event is fired so the badge count in the App updates. The queue is cleared on session rotation (`/clear`).
- **Session rotation** — Uses a serial session-operation queue (`createSessionOperationQueue`, not a boolean flag) so rotation, compaction continuation, and `agentProxy.deliver` never race a concurrent rebuild. Each operation chains onto the tail, ensuring in-flight work completes before the agent is torn down.

### Exec Runner (`src/exec/runner.ts`)

- Product non-TUI agent path that **shares** the TUI stack (session mode, ChatDirector, toolset, permission gate, MCP, plugins, hooks, run-sink) without the OpenTUI shell
- Bootstrap is intentionally a **forked copy** of the TUI path (not a shared factory yet). Intentional deltas vs TUI:
  - No workflow controller (`isWorkflowActive` is always false)
  - Non-interactive permission gate by default; optional stdin for `ask_operator`
- Entry: `corbits exec "prompt"` (alias `corbits run`); `loadConfig` sets `command: "exec"`
- Streams assistant text deltas to stdout; lifecycle errors to stderr
- Shares ChatDirector compaction continuation (`requestContinuation` → content-less deliver after compact) so long runs do not stall post-compact
- Single primary `agent.send(task)` turn; samples run-sink status/error **before** close (close emits `reactor.done` which would clear sticky errors); then closes the agent before draining the stream so the process exits; toolset is always disposed in `finally`
- Status: chat sessions rarely emit `reactor.done` before close, so a completed `send()` maps to `done` unless the pre-close run sink holds a real error
- Used by `scripts/demo.ts` (mode `exec`) and the capability eval suite (`scripts/eval-capability.ts` / `evals/capability/`)

### Event Stream Consumer (`src/session/stream-consumer.ts`)

- Consumes the async iterable from `agent.stream()`, invoking a sink per event, with stream error handling

### Custom Directors (`src/agent/director.ts`, `src/subagent/index.ts`)

Two directors, selected by role:

- **ChatDirector** (interactive, `src/agent/director.ts`) — Extends `DefaultDirector` with task list tracking, workflow nudges, LSP auto-activation, and multi-turn chat semantics. It never terminates the session: operator declines are surfaced as replies and the reactor stays alive for the next message. Auto mode is toggled by CLI flags (`--auto` / `--no-auto`); there is currently no in-session key to toggle it (default on; constrained envelope — workspace writes and unconstrained shell auto-allow; installs, recursive rm, force/uncontained worktree changes, sensitive-path and opaque-wrapper shell still ask; contained non-force `git worktree add`/`remove`/`prune` and `list` auto-allow; shell file-mutation denied). It is not a separate edit/plan mode.
- **SubAgentDirector** (delegated work, `src/subagent/index.ts`) — Drives a dispatched worker until a turn arrives with no tool calls, then replies with the final assistant text and ends the run. A tool-less turn **after tools** completes only with the four-heading envelope (Summary, Findings, Blockers, Paths); a missing envelope nudges once (**incomplete-report**) and a second tool-less turn still without the envelope salvages as **incomplete-report-stop**. Explore/read-only workers that used tools then replied with findings remain normal completes; `requireEvidence` (off by default, set per director) additionally requires at least one read before a tool-less spawn-only reply can complete. Reads done through `run_shell` count as evidence too — `src/subagent/shell-evidence.ts` classifies shell reads (`cat`, `grep`, `sed` without `-i`, …) over the same subject expansion the auto-shell policy uses — but there is no corresponding shell-write evidence or file-write requirement: a run that never touches a file still completes normally once it replies with the envelope. The leaf turn budget salvages as **turn-budget** only when `maxTurns` is finite (opt in via `task(maxTurns)`, agent profile `maxTurns`, or `settings.subagentMaxTurns`; no `maxTurns` at all means the leaf has no turn cap). A one-shot **report-forced** signal fires a few turns before a finite cap while the leaf is still tooling — it is not a stop: the director injects a wrap-up nudge and lets the leaf finish on its own. Operator/parent cancel after any progress returns a **cancelled** salvage report (partial findings + tool activity) instead of a bare cancel string; cancel before progress still surfaces as cancelled-by-operator. There is no repetition/no-progress/never-acted/never-edited hard stop and no fingerprint-based re-dispatch block — a genuinely stuck leaf runs until it completes, hits a finite turn budget, stalls, or is cancelled.
  Optional `task(tier=)` (`fast` | `standard` | `clever`) overrides profile inference, profile tier, and the parent provider for that spawn only, and fails closed when the tier is unconfigured. The parent `task` tool keeps a session-scoped brief-dispatch ledger (`src/subagent/brief-dispatch.ts`) that only counts dispatches per fingerprint (prompt + agent + intent + success_criteria + do_not, not maxTurns/description/tier) and resets on a successful complete — it never refuses a re-dispatch. Turn-budget salvage gets an advisory parent hint suggesting a higher `maxTurns`; once the same brief has salvaged on turn-budget 3 times without a successful complete, the hint switches to suggesting a different approach instead. Either way the hint is advisory only — an identical re-dispatch is still admitted.

#### Model-family policy (`src/agent/model-family-policy.ts`)

Both directors consume one `ModelFamilyPolicy` object, resolved once per session/leaf from the provider/model via `detectModelFamily` (`src/subagent/provider-family.ts`) — the directors branch on this data, never on per-family subclasses or forks. `resolveModelFamilyPolicy({ providerName, model, orchestrator? })` returns:

| Field                    | Meaning                                                                                                                                        |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `toolOnlyTurnNudgeAt`    | Consecutive tool-only assistant turns (tool calls, no text) before the ChatDirector injects a one-shot wrap-up nudge — a check-in, not a stop. |
| `wrapUpNudgeText`        | Ephemeral nudge text injected at the nudge threshold.                                                                                          |
| `subAgentStallTimeoutMs` | Wall-clock inactivity, in ms, before a silent sub-agent leaf gets a continuation nudge.                                                        |
| `applyGrokFinishBias`    | The existing grok anti-thrash residual (withheld from orchestrators — see `shouldApplyGrokAntiThrash`).                                        |

Defaults (`src/agent/model-family-policy.ts:47`): nudge at 25 consecutive tool-only turns, 5-minute stall timeout. Nudge-at-25 replaced an earlier count-only design (nudge at 12, a hard-pause at 20 by count alone, grok tightened to 6/10) that conflated any tool-only turn with no-progress — a Grok session hard-paused at 10 turns while making real progress through Linear lookups and code reads (CL-4839's original loop protection was aimed at runaway list-crawl thrash, not busy-but-progressing tool use). A grep/jq pass over real session traces under `~/.corbits/projects/*/*/context/turns.jsonl` (54 sessions with any tool-only run) found healthy tool-only streaks topping out at 13 turns (p90 12, p99 13) — 25 sits comfortably above that. **Grok** shares the default nudge threshold (its own 6/10 pair was the miscalibration this fixed) but keeps its shorter sub-agent stall timeout (90s) and `applyGrokFinishBias` residual, both independently motivated. **Kimi (Moonshot)** detection ships now (`isKimiLeafProvider`) so callers can already branch on the family, but its thresholds are provisional — pinned to the permissive default with a why-comment in the policy module — pending eval characterization of Kimi's tool-only and stall behavior.

#### Main-session loop protection

The ChatDirector counts consecutive assistant turns that contain tool calls and no text (`toolOnlyStreak`), reset by any turn with text and by every fresh operator message. At `toolOnlyTurnNudgeAt` the director arms a one-shot ephemeral wrap-up nudge (`toolOnlyNudgeFired` guards it to once per streak), regardless of what the tool calls were — a long streak of varied, productive tool calls runs straight through it every time. Because a turn with pending `tool_call` blocks must be followed by tool results before anything else, the nudge is applied by rewriting the `infer` action that follows once those pending tools have resolved (`applyToolOnlyLoopProtection`, `src/agent/director.ts`).

**There is no automated stop for the primary session.** The exact-period tool-fingerprint thrash detector, the operator-facing hard-pause, and the turns-since-user-message backstop (with its leaf-progress exemption for fleet-heavy work) that a prior release ran against this streak have all been removed, along with `src/util/period-detection.ts`. A primary session that loops on tool calls now gets the one-shot check-in nudge above and nothing further — it keeps running until the operator intervenes, a leaf-level stop fires inside a dispatched sub-agent, or some other bound (provider error, `--agent-timeout-ms` in eval mode, an opt-in tool timeout) ends the turn.

#### Sub-agent stall management

`SubAgentDirector` tracks `lastActivityAt`, updated on every real `inference.done` and `tool.done`. Directors are pure `decide(event, ...)` functions with no timer of their own and the reactor has no proactive "idle" event, so a genuinely silent leaf (e.g. parked on a long-running background command with nothing else to do) produces no event for the director to react to. `runSubAgent` (`src/subagent/index.ts`) arms an external interval, at `subAgentStallTimeoutMs`, that pings the same content-less continuation channel the compaction governor uses to re-enter an idle reactor (`requestContinuation`). The director only acts on a ping if the elapsed time since `lastActivityAt` has crossed the timeout — a ping delivered while a tool call is still executing simply queues until that cycle finishes, so "no pending harness-tracked work" falls out of when the check can run at all rather than needing separate bookkeeping. The first stall past the timeout gets one continuation nudge (asking the leaf to check on the background work or report status); a second **consecutive** stall (no activity since that nudge) escalates to the existing salvage path, returning a `stalled` `forcedStopReport` with the same structured shape (summary/findings/blockers) as `turn-budget` and `cancelled`. Any real activity between pings resets the streak, so a leaf that is genuinely working through a slow single turn is never penalized.

**Intervention log**: every stop and nudge is appended as one JSONL record to `interventions.jsonl` in the firing leaf's trace dir (`src/subagent/intervention-log.ts`), carrying the trigger's measured value beside the threshold it crossed, the provider/model/family it fired on, and the run state at that moment (turns used vs budget, tool calls, read/edit counts). A refused parent re-dispatch is recorded on the parent side, where no leaf run exists to record it. The parent also appends one `outcome` record per completed dispatch — the salvage kind `classifyBriefSalvage` assigned, or a clean-complete marker, plus the dispatch count — so the log carries dispatch outcomes as well as interventions, and a stop record can later be read alongside what the dispatch it touched actually produced. Writes are fire-and-forget and swallow their own errors — a diagnostic must not be able to fail a run. `scripts/intervention-forensics.ts` aggregates these across local sessions: per-intervention counts by model family, the measured-value distribution against the threshold, two context columns (stops that fired on runs which had already edited files; stops that fired before half the turn budget was spent — neither is a measured false-positive rate, since either is equally consistent with a correct stop or a wrong one), and outcome counts by kind. This exists because every threshold in this tree was set by judgment and four of those judgments were later reverted — a threshold change is expected to cite this data (CL-6938).

**Precedence**: stall detection sits **below** turn-budget — that is evaluated from real `inference.done` turns inside `evaluateSubAgentStop` and always takes priority; the stall check only ever fires on a continuation ping that inference/tool-result handling did not already consume that cycle. Report-forced (near-budget wrap-up) is an independent one-shot, turn-count-driven signal, not a competing stop reason in the sense turn-budget is. Stall nudging is wall-clock driven and likewise independent of it.

The reactor only persists a response turn to `turns.jsonl` on `inference.done`, so a cycle that is cancelled, aborted, errors, or is otherwise interrupted mid-stream would leave nothing behind. A cycle-text recorder (`src/session/stream-journal.ts`) closes that gap by buffering the in-flight cycle's streamed text in memory — no writes on the happy path — and appending one JSON record (`{reason, chars, text}`) to `partial.jsonl`, alongside `turns.jsonl` in the session context dir, on abnormal cycle end. It is wired into the sub-agent run loop, the exec runner (flushed on failed sends), and the TUI runner (flushed on interrupt and on session rotation, before the context dir is repointed).

Both adopt the shared **compaction governor** (`src/agent/compaction.ts`) described below.

**Removed: goal subsystem.** The ChatDirector previously attached a goal governor (`src/agent/goal.ts`, `src/agent/goal-evaluator.ts`, `src/agent/manage-goal.ts`, `src/session/goal-state.ts`, `src/permission/goal-approval-timeout.ts`) that rewrote clean terminal yields (`wait`/`reply`) into re-inference while a session-scoped `/goal` was active and not every acceptance criterion was done. It was deleted for being too complex to keep as-is; the capability it provided — deciding whether to re-enter inference after a clean yield — moves to the director, generalized beyond a single-goal acceptance checklist. The contract the replacement must satisfy:

- **Inputs:** the base terminal actions (`ReactorAction[]`, already produced by `super.decide`), the reactor capabilities (for building an `infer` action), and context — `atWorkflowGate` (bool), `lastTurnHadContent` (bool), and evidence derived from the turn history (the deleted `evidenceFromTurns` in `goal-evaluator.ts` built a bounded excerpt of recent turns for a model-backed evaluator to judge completion against; the replacement needs its own definition of what "evidence" means for its own completion signal, since nothing that shape exists anymore).
- **Return convention:** async, returns the rewritten action array or `null`; `null` means decline (let the base terminal action stand). The call site is `const rewrite = await replacement.interceptTerminal(...); if (rewrite !== null) return rewrite;` — same shape as every other terminal rewrite in `decideInner`.
- **Precedence:** called last among terminal rewrites, after compaction, workflow open-step, and open-task nudges, so those rails keep precedence; loop protection (`applyToolOnlyLoopProtection`) outranks all of them and runs first.
- **Compaction survival (the trap to avoid):** the deleted `SummaryContext.goal` field existed specifically because a continuation mechanism whose state lives only in the turn history dies at the first compaction — the goal's brief/status/criteria summary was injected into the compaction prompt so the continue-rule survived across it. Any replacement state needs the same treatment, or long auto-continue runs will silently stop continuing the moment compaction fires.
- **Token attribution:** the deleted governor's `noteMainTokens` hook fired on every `inference.done` to feed a soft token budget. If budgeted auto-continue is in scope for the replacement, it needs an equivalent hook point; if not, that's a deliberately dropped capability, not an oversight.
- **Launch-time tool gating:** the deleted `hasGoalAtLaunch` flag let persisted continuation state (loaded before the first inference call) gate which tools were advertised in the wire prefix (see `tool-search.ts` — the tools array is a provider cache prefix, so gating facts must be fixed for the session's life). A replacement that persists its own state across sessions will face the same launch-ordering constraint: state must load before the tool list is built.

The auto-deny approval timeout the goal governor armed (`timeoutMs`/`timeoutMessage` on the TUI permission gate) is generic plumbing that survives in `src/tui/gate-events.ts` / `src/tui/request-approval.ts` with no current caller — a future generalized auto-continue mechanism owns re-arming it.

The agent maintains an optional **`manage_tasks`** list (create/update via the homonymous tool). The TUI task panel reflects director task state; `manage_tasks` tool calls are collapsed into a dedicated content block in the event stream.

#### Context compaction (the compaction governor)

When a cycle's input tokens cross a threshold, the director compacts the inference-facing history (the full run is always retained in the context store). The threshold is **model-aware** — roughly 60% of the active model's real context window — so small-window models compact early enough to avoid provider context-overflow while large-window models do not compact prematurely. The compacted prefix is **append-only across passes**: the existing compacted user turn stays byte-identical; new folds become later summary turns with an assistant spacer between them so the prompt head can remain in the provider KV cache. The governor covers three cases:

- **Threshold at a tool pause** — Once over threshold, the follow-up `infer` after a tool batch is swapped for a `compact` cycle, and inference resumes via a host continuation message. After a compact that remains over the high watermark, the governor uses **growth hysteresis** (wait for usage to grow by ~10% of the window) instead of re-arming on every cycle; dropping under 60% is not required.
- **Idle (end-of-turn)** — An interactive turn can end with a reply and then sit idle with no tool batch to intercept; the governor requests a continuation at that pause and compacts when it arrives. An operator message that races the continuation still compacts first, then re-enters inference to answer it.
- **Overflow recovery** — A `context_overflow` inference error would otherwise become a terminal error reply; the governor compacts and retries instead, bounded so a history the compactor cannot shrink does not loop forever. Overflow ignores hysteresis for the compact itself.

The compaction control flow is shaped by a reactor invariant: a `compact` action runs in its own cycle (it cannot be paired with `infer`), and **the reactor delivers no event after a compact cycle**. A director that simply emitted `compact` in place of the follow-up `infer` would leave the loop idle forever — the cause of an earlier stall. Instead the governor, after emitting `compact`, self-delivers a content-less inbound message (a host-supplied `requestContinuation` callback). That message adds no turn (`createInboundTurn` returns `null` for empty content) but re-enters the loop, where the director issues the follow-up `infer` against the freshly truncated history.

Compaction replaces older turns with a structured, workflow-aware summary rather than a stats blob: sections for **What Happened / What We're Doing / Relevant Links / Action Items / Next Steps**, with the active workflow and step woven in so compacting mid-`/build` or mid-`/plan` preserves the contract. The summary is produced by a one-shot model call; on any failure it falls back to a deterministic summary so a compaction cycle never breaks the session.

### Web Tools and Providers (`src/web/`)

`web_search` and `web_fetch` are always-on core tools (`src/tools/web-search.ts`, `src/tools/web-fetch.ts`) — no plugin or API key required. `web_fetch` runs in-process on Bun's native `fetch()`: it resolves and rejects private/loopback/link-local targets before every request and again after each redirect hop (`src/tools/ssrf-guard.ts`), caps responses at 5 MB, and converts HTML to markdown by default (`text`/`markdown`/`html` formats). It opens with a browser User-Agent and retries once with an honest `corbits/<version>` UA if the first attempt is rejected as bot traffic. `web_search` calls a keyless hosted MCP search provider (Exa's public endpoint by default, `https://mcp.exa.ai/mcp`; Parallel selectable via `CORBITS_WEB_SEARCH_PROVIDER=parallel`) through the same MCP client used for configured MCP servers (`src/mcp/client.ts`), with an optional bearer key via `CORBITS_WEB_SEARCH_API_KEY`. Both tools get their own permission classes — `webfetch` (approval scoped to the requested URL) and `websearch` (scoped to the tool as a whole) — distinct from shell and file classes, defaulting to ask-with-persistable-allow like any other consequential tool. SSRF protection lives in the tool boundary itself rather than being delegated to external provider infrastructure.

### Director-Layer Tools (`src/agent/director.ts`)

- `ask_operator` — Pauses for a clarifying question with a list of options (and optional shell pre-approval via `command`).
- `present` — Renders structured UI from a JSON view spec instead of pasting tables into chat.
- `submit_output` — Workflow step advancement when `step` is set (observed by the workflow coordinator).
- `advance_workflow` — Advances the active workflow to its next step (observed by the director). Only advertised while a workflow is running.

Core agent tools (advertised in every chat turn) include `manage_tasks`, `tool_search`, `use_skill`, **`task`** (spawn a sub-agent), and **`search_agents`** when sub-agent profiles are available — see Sub-agents below.

### Workflows (`src/workflows/`)

Workflows are named, ordered recipes the agent follows step by step — a thin layer above the reactor loop, not a replacement. They ship as first-class TypeScript validated at compile time with `satisfies Workflow`; the static `WORKFLOWS` registry is the single source of truth.

- `types.ts` — `Workflow`, `WorkflowStep` (`prompt`, `capability`, `agent`, `skill`, `workflow` sub-workflow ref, `optional`, `parallel`, `type: "gate"`), and the `WorkflowState` persistence shape. `MAX_WORKFLOW_DEPTH` bounds nesting.
- `capabilities.ts` — `detectCapabilities` maps the live tool surface to abstract capabilities (`ticket-tracker`, `code-host`, `doc-search`) by name pattern; `resolveStep` decides whether a step runs. A capability override set forces integrations off per run. Adding a capability is a data edit, not a logic change.
- `runtime.ts` — `WorkflowRuntime` drives execution on a call stack: it skips capability-unsatisfied steps, descends into sub-workflow references, emits step lifecycle events, and snapshots `WorkflowState`. `state.ts` persists that snapshot atomically to `workflow.json` under the session state root for resume.

- `coordinator.ts` — bridges runtime and director: produces the `[WORKFLOW STEP i/total: label]` directive injected into each turn's system prompt, and advances the runtime when `advance_workflow` (or a `submit_output` tagged `{ step }`) completes. Shared by both directors.
- The built-in recipes: the atomics `update-ticket`, `improve-docs`, `write-tests`, `triage-bug`, `code-review`, `scope-project`, and the `build-feature` composite that chains them.

Invocation: workflows are **not** top-level slash commands. Recipe definitions load into the `WORKFLOWS` registry from **enabled workflow/command plugins** at startup; command surfaces on those plugins (e.g. a workflow plugin's command prefix such as `/mywf scope`). Slash commands may also be authored as data-only markdown (`commands/*.md`, no `index.ts`); see PLUGINS.md. The model never suggests or auto-starts workflows from ordinary chat. Skills (bundled `corbits-skills`, enabled plugins, or `.agents/skills/`) load on demand via `use_skill` or as `/<skill-name>` slash commands when `user-invocable` is not `false` (see Skills below). The TUI surfaces state via `src/tui/workflow-controller.ts` (lifecycle, capability overrides, resume) — the header shows step progress (`⟳ name · step/total label`).

### Sub-agents (`src/subagent/`, `src/agent/agent-search.ts`)

Three distinct concepts (do not conflate them):

| Concept       | What it is                                               | Surface                                                             |
| ------------- | -------------------------------------------------------- | ------------------------------------------------------------------- |
| **Agent**     | A runtime entity with its own loop, tools, and context   | Primary session or a spawned child                                  |
| **Task**      | A checklist item owned by _one_ agent via `manage_tasks` | Local work plan — not a spawn                                       |
| **Sub-agent** | A short-lived child agent for one self-contained job     | Spawned with the **`task`** tool (wire name kept for compatibility) |

The **`task`** tool **spawns a sub-agent** on a separate inference source (tier/profile resolved from settings). The dispatch brief separates durable `context`, actionable `prompt`, and optional `goals` (checklist seeds for the _child's_ own `manage_tasks` list). The child returns a structured report (`Summary` / `Findings` / `Blockers` / `Paths`) plus a tools-used footer. Parent and child never share a `manage_tasks` list.

When profiles exist (local `.agents/agents/` and/or enabled **`kind: "agent"`** plugins, including **data-only** markdown plugins with no `index.ts`), the chat model also receives **`search_agents`** — a lexical index over profile id, description, and role text so the model can discover ids before calling `task(agent=...)`. Results include each match's full loaded system prompt / body so the parent can inspect plugin or Claude marketplace agents without `read_file` on paths outside the session cwd (path-escape blocks those roots by design; writes remain blocked). `task` and `search_agents` are core tools on the primary session.

Profiles with `orchestrator: true` may themselves call `task` (one hop only): nested dispatch installs `task` + `search_agents` with `allowOrchestrator: false` so the tree bottoms out. Unknown `agent` ids fail closed.

#### Fleet authority tiers (`src/subagent/authority.ts`) (CL-6941)

Every director package carries a required `tier: SubagentTier` field (`src/agent/directors/types.ts`) — data on the package, never a prompt instruction:

| Tier                      | Who                                             | Fleet surface                                                                                                    |
| ------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| 1 — `orchestrator`        | skywalker (primary)                             | Full fleet control over the whole tree.                                                                          |
| 2 — `nested-orchestrator` | greybeard, or any package with `spawn.maySpawn` | Same fleet surface, scoped to its own subtree: may manage only its own descendants, never a sibling or ancestor. |
| 3 — `leaf`                | every other director                            | No fleet verbs at all.                                                                                           |

Enforcement is runtime code at the existing tool-mount point, not prompt wording — this is the fix for four prior mechanisms (`writePaths`, `report.requiredSections`, a `--config` comment, the thrash matcher) that were documented-as-enforced while enforcing nothing:

- **Mount-time gate — live today, and fails closed.** `task-tool.ts` resolves the caller's tier at dispatch time — a closed director's `DirectorPackage.tier` — and forwards it as `RunSubAgentParams.orchestratorTier`. `runSubAgent` (`src/subagent/run.ts`) then calls `assertTierMayMountFleetVerb(tier, toolName)` (`src/subagent/authority.ts`) before installing `task` / `search_agents`, treating a **missing** `orchestratorTier` as `"leaf"` — deny, not skip. This is the case that matters most: a project-local or plugin `AgentProfile` with `orchestrator: true` is outside the closed director set and is **not** trusted with fleet verbs just because `orchestrator: true` is set — there is no profile-level opt-in today, so the mount always throws `FleetAuthorityError` for a profile-sourced orchestrator (CL-6942/CL-6944 can add one when a real caller needs it). `FLEET_VERBS` in `authority.ts` also names the not-yet-implemented verbs (`spawn_agent`, `wait_agents`, `list_agents`, `send_input`, `interrupt_agent`, `close_agent`, `resume_agent`, `read_agent_trace`, `followup_task`) so their future mount sites inherit the same gate.
- **Subtree authority — a seam, not yet wired.** `assertCanTargetAgent(actor, targetId, nodes)` (`src/subagent/authority.ts`) implements the "root owns its tree; a child manages only its own descendants" rule (Tier 1 may target anyone, Tier 2 may target only its own descendants over the same `{id, parentSessionId}` shape `SubAgentSessionStore` already tracks, Tier 3 always fails closed) — but **it has no production call site yet**. No verb today lets one live agent address another (`task` only spawns), so this rule is exercised only by `authority.test.ts` and is not enforced at runtime in this PR. It exists so CL-6942 (split spawn from wait) and CL-6944 (`send_input` steering) — the first verbs that make an agent addressable by another — can call it from day one instead of each inventing its own check. Treat it as unenforced until one of those wires a call site.
- `task()` is unaffected and remains the only spawn verb until the new verbs land beside it (deprecated-not-deleted per the CL-6940 epic). Its argument schema and wire contract are unchanged; the tier check only gates which packages may have it mounted at all.

#### Closed director fleet (`src/agent/directors/`)

Every shipped specialist is a **director package** — a prompt-first `DirectorPackage` (system prompt, tool envelope, spawn rights, nudge budget, report contract, `modelRole`, fleet authority `tier`) registered in a **closed** set of 16 ids. There is no catch-all worker: `task` without `agent` or non-general `intent`, and `task(intent="general")`, fail closed so the primary reclassifies. Nested directors with a spawn allowlist reject off-list children at `createTaskTool` (not prompt-only). Skywalker is the primary session identity: `task(agent="skywalker")` is refused, and `directorProfiles()` omits it from the spawn catalog.

**Primary**

| Director  | Owns                                                           | Does not own                                                  |
| --------- | -------------------------------------------------------------- | ------------------------------------------------------------- |
| skywalker | Orchestrate only — classify, dispatch, track fleet, synthesize | Product tree edits; being the implementer/reviewer by default |

**Engineering directors**

| Director    | Owns                                                                    | Does not own                       |
| ----------- | ----------------------------------------------------------------------- | ---------------------------------- |
| build       | Ship product code                                                       | Pure docs, pure review             |
| explore     | Map/read codebase                                                       | Product edits                      |
| plan        | Eng change plan (steps, paths, tests, risks)                            | Arch gate, product discovery, code |
| intern      | Mechanical commands only                                                | Ambiguous or product-design work   |
| critique    | Evidence-based code review                                              | Fixing product code                |
| greybeard   | Architecture/approach review of plans/docs; limited spawn               | Authoring eng plans, implementing  |
| neckbeard   | Adversarial hygiene / refactor stress                                   | Real review substitute             |
| bruckheimer | Product discovery → PRODUCT/ARCHITECTURE/IMPLEMENTATION-oriented briefs | Eng plan, code                     |
| gaasbot     | Quick CTO opinion voice                                                 | Formal review gate, implement      |

**Design trio (dev perspective)**

| Director       | Owns                                                  |
| -------------- | ----------------------------------------------------- |
| draper         | Product visual / design-system critique               |
| emil           | Design-engineering + software laws on product UI/code |
| brand-reviewer | **DESIGN.md** create-if-missing + alignment gate      |

**Docs + QA**

| Director    | Owns                                                                                    |
| ----------- | --------------------------------------------------------------------------------------- |
| shakespeare | Docs maintain (scribe core baked into prompt); PRODUCT/ARCHITECTURE/IMPLEMENTATION lane |
| testsmith   | Test design only (what/how to test)                                                     |
| tester      | Runtime verification; never fix product code                                            |

**Intent → director** (`task(intent=…)` when `agent` is omitted)

| Intent    | Default director                   |
| --------- | ---------------------------------- |
| implement | build                              |
| explore   | explore                            |
| plan      | plan                               |
| review    | critique (override with `agent=…`) |
| general   | **none** — reclassify only         |

**Spawn matrix**

| Who                         | Spawn rights                   |
| --------------------------- | ------------------------------ |
| skywalker (primary session) | Full closed fleet              |
| greybeard                   | intern, explore, critique only |
| All other directors         | no `task`                      |

**Tool envelopes** prefer small `tools.allow` mounts over deny-everything. Shipped docs/design directors (shakespeare, brand-reviewer, bruckheimer) mount write tools with no path-level lock. Lane routing is spawn policy (shakespeare = P/A/I docs, brand-reviewer = DESIGN.md, bruckheimer = product discovery), not a file lock. There is no static per-package write-path declaration (CL-6952 removed it — no shipped director ever set one); instead the task tool records, without blocking, when two concurrently running dispatches land on the same cwd (see `intervention-log.ts`'s `conflict` class).

**Typical chain:** bruckheimer → plan → greybeard → build (+ intern) → critique (+ optional neckbeard), with skywalker coordinating throughout.

**Reasoning effort by role** (`src/provider/reasoning-effort.ts` → `resolveEffortForRole` / `defaultEffortForDirector`): package `modelRole` defaults are orchestrator/plan/review → `high`, implement/explore/docs/test → `medium`, with **intern** pinned to `low`. Spawn-time binary fallback is orchestrator → `high`, worker → `medium`, clamped to the model. Explicit profile inference pins win; parent session effort is only a fallback when the role default is unsupported. This keeps multi-agent fleets off the sol+high latency cliff — see `docs/plans/reasoning-effort-by-role.md`.

**Session records** (`src/subagent/session-store.ts`): each spawn is retained as an inspectable child session (id, profile, description, brief, status, tool activity, transcript entries). Child events land only in this store — not in the parent chat transcript. Live progress still uses the light `onProgress` channel for the status bar. Completed sessions are capped (`maxCompleted`) so a long chat does not grow without bound.

**Observe (OpenTUI)**: `shell.ts:enterSubagentObserve` swaps the transcript for a child's stream (live while running, historical when done) without stealing the parent reactor; child events are mapped to stream rows by `src/tui/observe-map.ts`. Esc leaves observe and restores the parent transcript. Parent Esc/stop and `/clear` still call `cancelAll` so live children close (`agent.close`) instead of continuing after the parent stops. The host-injection point that resolves a live session (`onObserveRequest` → `observeSessionFromSubAgents`, `src/tui/runner-host.ts`, picking the newest running child else the most recent session of any status) is triggered by Alt+O (`shell.ts:observeActiveSubagent`) — the command palette action that used to call it is gone along with `src/tui/palette.ts` itself, but the chord replaces it rather than dropping the feature.

Data-only agent plugins (`src/plugins/data-only-agent.ts`) synthesize `agentPlugin.agents[]` from `agents/*.md` or flat `*.md` in the plugin directory, with optional co-located `skills/`. `loadPluginEntry` tries JS entrypoints first, then falls back to this layout (`/plugins` add-by-path supports filesystem completion via `listPathSuggestions`).

### System Prompt (`src/agent/prompts.ts`)

The primary session identity is **Skywalker** (`buildChatRole` → `createSkywalkerSystemPrompt`). Product name remains Corbits Code; when asked its name, the primary answers Skywalker. Role: orchestrate — classify, DIY tiny/single-file/one-route product edits, dispatch closed directors via `task` for substantial work, track the fleet, synthesize. Product mutation tools (`write_file` / `edit_file` / `delete_file`) are mounted on the primary session (CORE and `SKYWALKER_TOOLS`) so Skywalker can DIY bounded edits; spawn remains the default for substantial, multi-file, parallel, or specialist work. Shell file-writes stay denied by auto-shell policy. MCP tools are not re-filtered by a product-write deny list (that list is gone). There is no static per-leaf write-path lock; concurrent lanes sharing a cwd are instead flagged (not blocked) as a `conflict` intervention. A frontier model already knows how to code; the static prompt carries harness-specific facts and the closed-fleet orchestration policy. The base is three individually-exported sections:

- `buildChatRole` — Skywalker primary identity (orchestrate; DIY tiny/bounded product edits; spawn for substantial work).
- `buildHarnessFacts` — the non-derivable rules: shell file-writes are blocked, path tools are the DIY surface on primary (spawn build/docs directors for substantial work), dependency installs and off-limits paths need approval, images are native multimodal input, only core tools are resident (load the rest via `tool_search`; use `search_agents` before dispatching specialists), workflows run only from slash-command steps, and session memory lives at `.corbits/MEMORY.md`.
- `buildGuidelines` — be concise, prefer `task` for substantial product work, DIY tiny/bounded edits on the parent, answer questions and diagnose visual/product feedback before editing, work autonomously for explicit coding tasks, use `lsp` for symbol work, and verify changes when practical.
- `buildPromptDisciplineBlock` — a shared, prohibition-form section appended exactly once to every built prompt (chat and sub-agent, every provider family). Primary vs leaf wording differs for product writes: leaves are told to use `read_file`/`edit_file`/`write_file`; Skywalker is told to DIY tiny/bounded edits with those path tools and spawn directors for substantial work. Shared rules: never `cat`/`sed`/heredoc/`echo` for file work, no setting or exporting environment variables (recurring needs belong in project settings), `web_fetch`/`web_search` instead of `curl`/`wget`/hand-rolled queries, one operation per `run_shell` call, turn semantics (a tool-less reply is the final answer, no repeat searches, stop and change approach after three failed attempts, batch independent reads in parallel), and TTY output rules (short bold headers, one-line bullets, backticks for paths/commands, no wide tables).

**Provider-conditional residuals.** Per-family additions layer on top of the shared block via the same `ModelFamilyPolicy` mechanism the directors use (`src/subagent/provider-family.ts`, `src/agent/model-family-policy.ts`) — additive lines, never prompt forks. **Grok** leaves get `buildGrokLeafAntiThrashNote` (gated by `shouldApplyGrokAntiThrash` / `applyGrokFinishBias`, withheld from orchestrators): a compact finish-bias reinforcement plus a one-line reminder to route file/web work through the dedicated tools rather than `run_shell`, motivated by observed tool-routing thrash on the same harness. **Kimi** intentionally has no residual yet — `detectModelFamily` already resolves the family so callers can branch on it, but the prompt seam is left unfilled pending eval characterization of Kimi's behavior, mirroring the provisional (permissive-default) policy in `model-family-policy.ts`.

`buildChatSystemPrompt` (TUI chat) and `buildSubAgentSystemPrompt` assemble: base → core tool list → lazy skills listing → live `<env>` block → appended extensions. Built-in catalog tools and MCP integrations load dynamically via `tool_search` rather than being enumerated. Skills follow the same lazy principle pi-style: each discovered skill contributes only its name + one-line description to the prompt, and the model pulls a skill's full instructions into context on demand by calling `use_skill`. The operator can also invoke the same skill as `/<skill-name>` (see Skills below). Skills are discovered (and deduped by name, first-wins) from enabled plugin dirs, then `.agents`/`.claude`/`.codex/skills`, in that precedence. Corbits Code ships a bundled catalog via the first-party `corbits-skills` plugin (origin `repo`); project-local skills of the same name are shadowed by an enabled plugin skill.

**Overrides.** `loadSystemPromptOverrides` (`src/agent/context-extensions.ts`) resolves a project `SYSTEM.md` (repo root, then `.corbits/`) that **replaces** the static base block, and an `APPEND_SYSTEM.md` that is **appended** as an extension. These compose with `config.systemPromptExtensions` (profile config) and the auto-discovered `AGENTS.md`, all of which attach as appended sections after the base.

### State Persistence (`src/session/state.ts`)

- `RunState` — `running` | `done` | `failed`, turns used, task, timestamps, error
- Atomic JSON save/load to `run.json` under the session state root (`~/.corbits/projects/<project-key>/<session-id>/`), with schema validation on load
- Conversation context is persisted separately by the git-backed store under that session's `context/` directory

### Lifecycle Hooks (`src/session/hooks.ts`)

- Discovers `postTurn` / `postRun` hooks (TypeScript or shell) from `.corbits/hooks` (local) and `~/.corbits/hooks` (global)
- `TurnContext` aggregates per-turn data (assistant turn, tool calls/results, token usage, source, duration); a turn-context collector builds it from the event stream
- `RunSummary` aggregates the whole run for `postRun`
- The manager exposes enable/disable and emits `hooks.loaded` / `hook.updated` events for the TUI hook panel
- See `docs/HOOKS.md`

### Pricing (`src/cost/pricing-fetcher.ts`, `src/cost/faremeter.ts`)

- `pricing-fetcher` loads model pricing from models.dev, caches it, and refreshes in the background
- `faremeter` converts `inference.usage` token counts into a formatted cost using that pricing

### Renderer (`src/agent/renderer.ts`)

- Headless event rendering: formats the event stream to stderr with live cost, seeded by start time, model, and pricing cache

### Plugins

Tool middleware applied over `createPosixTools`, in this order:

```
tool call
  → pathEscapePlugin      (resolve + sandbox paths)
    → secretGuardPlugin   (hard-deny path-keyed secret files)
      → authzPlugin       (deny catastrophic commands)
        → permissionPlugin (tiered operator approval)
          → verifyPlugin   (post-write/edit verification)
            → actual tool execution
```

**Rejection behavior:** Any plugin can short-circuit by returning a `ToolResult` with `isError: true`; the error propagates to the agent and downstream plugins/execution are skipped.

- **Path Escape** (`path-escape-plugin.ts`) — Canonicalizes path-like arguments against `cwd` and blocks `..` escapes, except into a root the permission layer's worktree-roots provider allowlists (e.g. a sibling git worktree of the same repo). Runs first so later plugins see resolved paths.
- **Tool-output URI** (`tool-output-uri-plugin.ts`) — Normalizes mistaken `read_file` blob URIs to `tool-output:///id` (corbits-only; interchange stays unpatched).
- **Secret Guard** (`secret-guard-plugin.ts`) — Hard-denies path-keyed tool calls (`read_file`, `write_file`, …) that would put a sensitive file into (or write it from) the model context. Runs before the permission plugin, so the path-arg deny holds even under `--dangerously-skip-permissions`. Shell commands that _reference_ a sensitive path (tokenized so `cat .env`, `bun --env-file=.env run …`, and quote/env-assignment forms are detected) are not hard-denied here: they require operator approval via the permission gate, and auto mode forces an ask through the auto-shell policy (`sensitive-path` rule). Once the operator approves, the command runs. Shell detection is best-effort: token matching defeats quoting and env-assignment/redirection forms but not dynamic path construction (variable indirection, `printf` assembly). Tool-result secret scrub still redacts credential-shaped output.
- **Authorization** (`run-shell-authz.ts`, wired by `authz-plugin.ts`) — Denies catastrophic shell command patterns by regex, and hard-blocks shell `find`, head-position `rg`, and recursive `grep -r` (they can walk huge trees and OOM the host). Bounded `grep`/`search_files` tools remain practical alternatives (timeout + output caps); the patterns match those three command shapes only — an `ls -R`, `fd`, or scripted `os.walk` is just as unbounded and is not caught, so the block message tells the model not to substitute one. The permission gate’s shell auto-allow path consults the same policy so it never pre-approves a command authz would reject.
- **Permission** (`permission-plugin.ts`) — Delegates consequential calls to the permission gate.
- **Shell Guard** (`shell-guard-plugin.ts`) — Corbits Code-only replacement for stock `run_shell` (interchange stays unpatched): no built-in default timeout (optional per-call or `settings.shell.timeoutMs`; `maxTimeoutMs` clamps only a resolved timeout), 512KB display cap with head+tail retention (the process keeps running when the cap is hit), process-group kill on timeout/abort only. Also applies a 10s wall-clock budget to `grep`/`search_files`.
- **Read File Guard** (`read-file-guard-plugin.ts`) — Corbits Code-only short-circuit for `read_file` on real filesystem paths and configured `tool-output://` URIs (interchange stays unpatched): streaming reads that never decode the whole file in one pass, caps model-facing output at 50KB, defaults to 2000 lines, truncates long lines with recovery hints, samples the first chunk to reject binary, and stops at an 8MB scan ceiling. Emits `offset` continuation notices so the model can page without losing file or spill content on disk.
- **Verify** (`verify-plugin.ts`) — Re-reads after `write_file` / `edit_file` and errors on mismatch. Per-path serialization (`file-mutation-lock.ts`) prevents parallel edits on one file from tripping verification.
- **Edit file line range** (`edit-file-line-range-plugin.ts`) — Corbits Code-only short-circuit for `edit_file` mode B (`start_line`/`end_line`/`new_string`), same pattern as shell-guard; schema advertised via `advertiseEditFileLineRange`. Modes are mutually exclusive: a call supplying both `old_string` and `start_line`/`end_line` is rejected with a recoverable error naming which fields to omit (no file-content disambiguation).
- **Edit file diagnostics** (`edit-file-diagnostics-plugin.ts`) — On stock substring mismatch (`old_string not found` / not unique), appends nearby file context (whitespace near-miss, occurrence lines) without changing match semantics.
- **LSP hint** (`lsp-hint-plugin.ts`) — Appends a typescript-language-server install hint when the stock `lsp` tool reports no server for TS/JS paths.

### Permission System (`src/permission/`)

- **classify** — Read-only tools (`read_file`, `search_files`, `grep`, `list_dir`) are tier `allow`; everything else is tier `ask`. Builds approval requests: shell yields one request for the full command the model asked to run (security still splits under the gate); file tools keyed on the target path; other tools keyed on tool name.
- **command** — Splits chained commands for security classification and derives command-shape approval scopes. Multi-segment chains only offer an exact-command persist pattern (a prefix like `npm *` must not cover `npm i && rm -rf /` later).
- **auto-shell-policy** — Constrains `run_shell` even when auto mode would otherwise rubber-stamp it. Before matching, `expandShellSubjects` peels `bash`/`sh`/`zsh -c`, `xargs` utility tails, and transparent prefixes (`env`, `nice`, `timeout`, …) so rules see the real payload; an unparseable wrapper (variable expansion or command substitution) sets an opaque flag that forces `ask`. Effects: `deny` blocks outright (file mutations through ad-hoc tooling — output redirection, `tee`, `sed -i`/`perl -i`, interpreter inline programs or heredocs — which must instead go through `write_file`/`edit_file`); `ask` declines to auto-allow and falls through to the operator prompt (recursive `rm`, dependency installs and remote runners: npm/yarn/pnpm/bun, pip, cargo, go, brew, npx/bunx, …, force or uncontained `git worktree` ops, shell that references a sensitive path such as `.env` or a private key, and opaque wrappers). Contained non-force `git worktree add`/`remove`/`prune` and read-only `list` auto-allow (sibling destinations like `../corbits-dispatch-wts/…` included; absolute outside, `~`, globs, and credential basenames still ask). Deny beats ask when multiple subjects match. Quoted spans are stripped before pattern matching so a quoted `>` or install word in an argument is not flagged, and program names are matched only in command position. Adding a table category is a one-line rule append in `AUTO_SHELL_RULES`.
- **gate** — Evaluates a call: `skipPermissions` allows everything; `allow`-tier passes; for `ask`-tier, checks persisted approvals, otherwise requests operator approval. Shell security classifies each chain segment (`||` / `&&` / `|` / `;` / newlines), but the operator is prompted once for the full command block — any unapproved segment fails the whole block, and execution always runs the unsplit original. Safe pipeline tails and pure shell no-ops (`true` / `false` / `:` and bare control-flow keywords stranded by chain-splitting) skip without a prompt. In a non-interactive run an unresolved `ask` becomes a denial. In auto mode: non-shell built-ins in `AUTO_ALLOWED_TOOLS` (writes/edits/deletes, `manage_tasks`, `task`, …) auto-allow when not path-restricted; for `run_shell` the gate consults the auto-shell policy — a `deny` rule fails the call, an `ask` rule skips the auto-allow shortcut and proceeds to the normal approval flow, and anything unmatched is auto-allowed. Paths outside the workspace and writes under the session state root (`~/.corbits/projects/...` and legacy `.agent-state`) still ask under auto mode. Under `--dangerously-skip-permissions` (forces this process) or `/yolo` (persists as the user-global default via `setSkipPermissions`), the gate auto-allows those same cases, and pre-gate sandboxes (path-escape, shell session cwd retention, `list_dir` / `delete_file` workspace bounds) honor `getSkipPermissions()` live so outside-workspace access is not hard-denied after the gate already allowed it — without rebuilding the plugin stack. Secret-guard path denies and authorization hard blocks still apply. Mutating MCP and unknown built-ins are not blanket-allowed outside skip. Newly granted scopes are appended in memory and persisted.

- **matcher** — Approval pattern matching via `@intx/authz` `matchPattern` (`*` wildcards). Exact-command grants store a backslash before each metacharacter; those patterns match by equality after unescape (the package has no escape syntax).
- **authz-grants** — Maps stored approvals into `@intx/authz` `GrantRule`s and evaluates them with `evaluateGrants` (allow-only; Corbits cwd/provider-model filters applied first). Exact-escaped grants bypass the package path and use equality.
- **store** — Loads/persists approvals scoped to the working directory (Corbits JSON layout; not the package GrantStore).
- **queue** — Headless settle registry (`src/permission/queue.ts`). Surfaces enqueue outstanding requests; `wirePermissionGrantReconciliation` listens for `permission.grant` and drains every queued request the new grant covers, without a second prompt. Teardown calls `drain()` so no awaited resolve is left hanging.
- **types** — `Approval`, `ApprovalScope`, `PermissionRequest`, `ApprovalOutcome`.

**Approval log** (`src/permission/approval-log.ts`, CL-5666): every consequential decision the gate makes — auto-mode allow/deny or an interactive prompt's allow-once/allow-with-scope/deny/timeout/abort — is appended as one JSONL record to `approvals.jsonl` in the session dir, carrying the classifier/auto-shell rule name that fired (the existing `auto-shell-policy.ts`/`classify.ts` rule names, plus a small closed set of additional fixed literals the log itself defines for decisions those modules don't otherwise name — `auto-allowed-tool`, `non-interactive`, `mega-chain` — never model- or user-authored text), whether the decision was `auto` or `interactive`, a shell chain's segment count, and queued/displayed/settled timestamps. `displayedAt` is set by `PermissionRequest.markDisplayed`, called from `gate-wire.ts`'s `open()` the moment a request actually reaches the overlay host — distinct from when it was raised, so the gap it exposes is the CL-5664 signal (a queued gate arming its timeout before the operator could see it). No command text, file content, path, credential, or other free text is ever recorded — only tool name, rule, mode, segment count, and timing; a sub-agent's free-text dispatch label is deliberately left out, even though it would enable a per-agent breakdown, because nothing constrains what a model puts in it. A hard size cap on the serialized line is defense in depth against a future field reintroducing free text. Writes are fire-and-forget and swallow their own errors; the log defaults to a no-op so nothing depends on it being wired. `scripts/approval-forensics.ts` aggregates across local sessions the same way `intervention-forensics.ts` does for stop/nudge events: per-tool counts by outcome and mode, duration/display-delay percentiles, mega-chain counts, and a duplicate-rate proxy (sessions that hit the same rule more than once).

**Tool wall-clock budget vs. permission prompts.** Each tool `run()` is wrapped by an outer execution watchdog (`src/tui/tool-execution-watchdog.ts`). The watchdog arms only when Settings set `tools.timeoutMs` / `tools.maxTimeoutMs`, or when `run_shell` passes a positive timeout (requested plus slack, so this layer cannot beat shell-guard). The `task` tool is always exempt, regardless of Settings: the generic per-tool budget never aborts a sub-agent run. That exemption is unconditional, not because the leaf is otherwise bounded — `maxTurns` defaults to unbounded (opt in via `task(maxTurns)`, agent profile `maxTurns`, or `settings.subagentMaxTurns`), `deadlineMs` is opt-in, and there is no no-progress or thrash stop today. A stuck leaf that never trips its own turn-budget, stall, or deadline check runs until the parent cancels it or, in eval mode, `--agent-timeout-ms` bounds it. By default (`tools.waitForApproval`, Settings → Tools, **On**), an armed budget freezes while the operator is deciding on a permission prompt, so a late approve still runs the tool and the agent waits for the decision instead of timing out under the modal. When **Off**, the budget keeps ticking during the prompt; if it expires first the tool is skipped and the permission modal is dismissed via the budget AbortSignal (auto-deny with a timeout message). The TUI permission queue (`src/tui/gate-wire.ts`, backed by `src/permission/queue.ts`) attaches that signal so ghost prompts cannot outlive an already-aborted tool.

`mcp__*` tool calls are the exception to "arms only when Settings set it": they arm unconditionally with a 5-minute default (`DEFAULT_MCP_TOOL_TIMEOUT_MS`), overridable via `mcp.timeoutMs` and still capped by `tools.maxTimeoutMs` (CL-6895). Nothing else bounds an MCP call — the stall watchdog treats an in-flight tool as activity by design, so a wedged MCP server previously hung a tool call, and the turn, forever. On expiry the call returns a normal tool-error result ("MCP tool `<name>` timed out after `<n>`s — the server may be wedged; retry or continue without it"); the turn is never aborted. The MCP client itself (`src/mcp/client.ts`, wrapping `@modelcontextprotocol/sdk`) multiplexes concurrent requests over one connection by JSON-RPC message id with no serial queue or mutex in our code or in the vendored SDK's `Protocol.request()` — so concurrent calls to the same server are not expected to deadlock each other. Live forensics for CL-6895 showed multi-minute MCP calls that eventually completed successfully, consistent with a slow server response rather than a client-side deadlock.

Approval scopes offered: Allow Once (persist nothing), Allow Always for a file or its directory (file tools), or a command shape (shell). There is intentionally no "all files" rung. Project-scoped Allow Always grants are confined to the session that minted them: they match the session root and its registered git worktrees (`cwdMatchesGrant` in `src/permission/authz-grants.ts` via `createWorktreeRootsProvider`), not bare process-cwd equality — so a grant at the repo root still covers a sub-agent running in a sibling worktree of the same project.

A queued gate's display-dependent timers (auto-deny timeout, tool-budget pause ceiling) arm when the request is actually shown to the operator, not when it is received — a request sitting behind others in the queue does not burn its timeout invisibly. `ask_operator` has the same abort/timeout safety net as the permission gate, so a queued operator question behind a stuck overlay cannot hang a run. Both live in `src/tui/gate-wire.ts`'s `onPermission`/`onOperator`.

### TUI (`src/tui/`)

OpenTUI (`@opentui/core`) is the shipping shell; the Ink/React tree has been deleted from the repo. The runner (`src/tui/runner.ts`) mounts the host via `mountRunnerHost` (`src/tui/runner-host.ts`), which mounts `mountProductHost` (`src/tui/product-host.ts`) over the shell (`src/tui/shell.ts`).

- **Shell** (`shell.ts`) — Owns the transcript window, header, status line, prompt, overlay/palette stack, and layout/relayout (`applyLayout`, `relayout`). Transcript rows are appended via `appendStreamRow`/`appendObserveStreamRow`; focus moves between prompt and transcript via `applyFocus`/`toggleShellFocus`.
- **Product host** (`product-host.ts`) — Creates the `CliRenderer`, wires the event emitter bridge, model/command catalogs, and chrome pushes.
- **Runner host** (`runner-host.ts`) — Runner-facing mount: catalog assembly from live config, chrome pushes on session change, subagent observe resolution, and session teardown (quitting is Ctrl+C twice, owned by the shell).
- **Overlays and pickers** — Resume picker (`src/tui/pick-session.ts`) uses `runListModal` (`src/tui/list-modal.ts`). Slash-command surfaces (`/model`, `/settings`, `/permissions`, `/plugins`, etc.) route through `openCommandSurface` (`src/tui/command-surfaces.ts`).
- **Auto mode** — Toggled by CLI flags only (`--auto` / `--no-auto`); there is currently no in-session key bound to it.
- `@file` mention resolution and image paste are not wired on the OpenTUI send path.

Known keybindings: `Ctrl+C` interrupts the in-flight run, and quits on a second press inside a two-second window.

### Skills (`src/extensions/skills.ts`)

Skills are Markdown capability packages (`SKILL.md`). Each skill is a **dual surface**: the model loads it on demand via the `use_skill` core tool (pi-style lazy listing), and the operator can invoke it as `/<skill-name>` unless frontmatter sets `user-invocable: false`. `loadSkillCommands` (`src/plugins/skill-commands.ts`) synthesizes a slash command that sends the SKILL.md body (plus typed args) to the primary session; untagged skills still become slashes.

Corbits Code **ships a bundled catalog** as the first-party data-only plugin `plugins/corbits-skills/` (id `corbits-skills`, kind `command`, `defaultEnabled: true`). Origin `repo` is auto-trusted. Auto-**enable** applies only when `origin === "repo"` AND `manifest.defaultEnabled` is true AND `settings.plugins[id]` is missing; an explicit `enabled: false` still disables. Marketplace (user / project / path / claude) `defaultEnabled` is ignored — those plugins stay opt-in. The id is `corbits-skills` (not `gaas`) so a later marketplace plugin cannot replace the module by id collision.

`discoverRepoPlugins` locates `plugins/` next to the source root, at `dist/plugins`, or at `dirname(execPath)/plugins`. It never scans the session cwd for the bundled catalog.

Primary is Skywalker. Bundled skill bodies that are operator slashes are **action** recipes that tell it to `task(agent="<director>")` — there is no catch-all worker. Default slashes: `/implement`, `/plan`, `/refactor`, `/review`, `/pull-request-review`, `/create-issue`, `/scribe`, `/interview`, `/ast-grep`. `/scribe` dispatches shakespeare; `/implement` spawns build / greybeard / critique as the recipe specifies; `/plan` dispatches plan director (eng change plan; does not implement; does not file tracker issues); `/review` is a code-review action (not a director name); `/create-issue` remains the tracker command — Linear MCP when available, otherwise `ask_operator` for the platform and persists `Preferred issue tracker` in `.corbits/MEMORY.md`. Dispatch is `use_skill` only, not a default slash. Draper and emil are closed directors via `task(agent=…)`, not slashes. The operator types the slash; Skywalker reads the body and dispatches.

#### Discovery and precedence

`discoverSkills(cwd, pluginDirs)` runs at session start and returns each available skill's `name` + one-line `description` for the lazy listing in the system prompt. It scans the following base directories, highest precedence first:

| Base directory        | Source                                                                                                                                  |
| --------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `<pluginDir>/skills/` | Each enabled plugin that ships skills, including the bundled `corbits-skills` catalog when auto-enabled (`skillDirsFromEnabledPlugins`) |
| `.agents/skills/`     | Shared across runtimes                                                                                                                  |
| `.claude/skills/`     | Claude Code workspace skills                                                                                                            |
| `.codex/skills/`      | Codex workspace skills                                                                                                                  |

Each `<base>/<skill-name>/SKILL.md` is one skill. Discovery dedupes by directory name: the first base dir that provides a given name wins, so an enabled plugin skill shadows a project-local skill of the same name. Plugin dirs are passed in discovery order (repo first), so a first-party catalog name wins over a later marketplace or project skill of the same name. `resolveSkillBody(cwd, ref, pluginDirs)` resolves a skill's body using the same ordered list (it accepts a bare name or a `plugin:name` ref, keying on the name).

#### SKILL.md format

A skill file begins with a YAML frontmatter block, followed by the body that holds the instructions. Discovery parses `description`; `loadSkillCommands` also reads `user-invocable`. The skill's identifier (what `use_skill` and `/<skill-name>` take) is its directory name. A skill with no `SKILL.md` or an empty body is skipped.

| Field            | Required     | Description                                                                                                                                        |
| ---------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `description`    | yes          | One-line summary shown in the prompt's lazy skills listing and the slash picker                                                                    |
| `name`           | conventional | Conventionally matches the directory name; the directory name is what is actually used as the identifier                                           |
| `user-invocable` | no           | When `false`, `loadSkillCommands` skips slash synthesis; the skill remains `use_skill` only. Untagged skills still become slashes (marketplace BC) |

There are no `type` or `disable-model-invocation` fields required for model invocation — a skill body is plain instruction text. `argument-hint` on frontmatter is preserved for the slash picker (greyed arg guidance). Multi-step orchestration is a separate mechanism (see Workflows above), not a skill `type`.

#### Loading (model and operator)

`buildSkillsSection` lists each discovered skill as `- name: description` in the system prompt — descriptions only, so the prompt stays small regardless of how many skills exist. The full instructions enter context in two ways:

1. **Model** — `use_skill` (`src/agent/use-skill.ts`) with a skill name; the handler calls `resolveSkillBody`, strips the frontmatter, and returns the body as the tool result.
2. **Operator** — `/<skill-name>` from `loadSkillCommands` sends the same SKILL.md body (plus typed args) to the primary as a user turn. Skills with `user-invocable: false` are omitted from the slash registry and remain `use_skill` only. Skywalker then follows the recipe.

Which plugin skill directories are in scope is decided in `runner.ts` / `skillDirsFromEnabledPlugins`, which passes the enabled plugins' dirs to both `discoverSkills` (for the listing) and the `use_skill` tool (for resolution). Project-local `.agents`/`.claude`/`.codex/skills` are always searched. Slash-command registration is first-wins (built-ins, then plugins in discovery order), so a first-party `/implement` stays first-party if a marketplace plugin of the same slash name is also enabled.

## Data Flow

```
CLI argv
  → src/config/index.ts (Config)
    → src/tui/runner.ts (TUI)
      → LoadState, LoadPricing, discover hooks
      → CreatePermissionGate
      → CreatePosixTools (plugin chain)
      → Create director (ChatDirector)
      → CreateAgent (git-backed contextDir)
      → SaveState (running)
      → agent.send(task)
      → src/session/stream-consumer.ts → sink
          → turnCollector.observe → postTurn hooks
          → emit to OpenTUI host (TUI)
      → saveState at session lifecycle points (initial write, progress
        snapshots on model/MCP/turn changes, and finalize on done/failed/cancelled)
      → (interactive) connector.reply → optional queue drain → next user turn
      → lifecycle hooks: postTurn per turn; postRun when a run summary is finalized
```

## State Transitions

```
[idle] → user message → [running] → connector.reply → [idle] (chat session stays open)
              ↓ gates / errors
         [blocked] → operator resolves → [running]
              ↓ fatal inference/reactor error
         [failed] (TUI may surface and allow retry; context persists under the session state root)

```

There is no post-submit `build`/`typecheck`/`test` critique step in the current tree; validation is operator- and hook-driven (`postTurn`/`postRun`) plus explicit `run_shell` during agent work.

## Design Decisions

### Event loop vs. chat interface

The reactor processes one event at a time and produces a deterministic next action; every `inference.done` must yield a decision. The director adds stall detection and compaction recovery on top of the permission and authorization middleware already enforced at the tool layer.

### Plan as contract

The plan lives in durable director state, not just conversation history, so it survives context shifts and is enforceable.

### Constraint ownership at the tool layer

Safety and budget constraints (secrets, catastrophic commands, permission, write verification) are enforced as tool-layer middleware, not as advisory prompt text — one layer owns each constraint and the agent cannot evade it by rewording.

### Resume via git-backed storage

`@intx/storage-isogit` persists conversation context to a git-backed store; combined with JSON director state, runs resume from any interrupted point.
