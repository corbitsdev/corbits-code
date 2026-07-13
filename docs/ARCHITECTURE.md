# Intercode — Architecture

## System Overview

The system is an event-driven agent loop with a custom reactor director. The CLI parses arguments, builds a `Config`, creates an agent with sandboxed tools and a `ChatDirector`, and consumes the event stream through an Ink-based TUI. The director layers chat semantics, compaction, and workflow coordination on the reactor's default behavior; tool-layer middleware (authorization, permission gate, verification) enforces hard constraints before tools run. Delegated work runs through a second, sub-agent director on the same loop.

## The Reactor Loop

The reactor (from `@intx/agent`) drives a single agent turn-by-turn. Each turn is:

1. **Inference** — the LLM produces an assistant turn (text plus zero or more `tool_call` blocks).
2. **Tool dispatch** — each `tool_call` runs concurrently; results return as `tool.done` events.
3. **Director decision** — the director's `decide()` receives every event and returns `ReactorAction[]` that control what happens next.

This repeats until the director emits `capabilities.done()`.

### Events

| Event | When it fires |
|---|---|
| `inference.done` | The LLM finished one assistant turn. Carries the full turn content. |
| `tool.done` | One tool call completed. Carries the result and the original `callId`. |

### ReactorActions

The director returns actions that shape the loop:

- `capabilities.continue()` — run another inference turn (implicit default).
- `capabilities.reply(text)` — inject a synthetic tool result into the next turn's context.
- `capabilities.checkpoint(label)` — persist a named checkpoint to `.agent-state/`.
- `capabilities.done()` — terminate the loop.

### Director-layer termination

In TUI chat mode there is no completion gate — the session stays open across turns until the operator clears or starts a new session. The ChatDirector never emits `done()`; even an operator decline is surfaced as a reply while the reactor stays alive. Sub-agents terminate themselves: a turn without tool calls ends the run with the final assistant text as the result.

## Components

### CLI Entry (`src/index.ts`)

- Parses arguments and `--help`
- Dispatches to `runTUI` (or first-run onboarding)

### Config Resolution (`src/config/index.ts`, `src/config/settings.ts`)

- Resolves the inference provider from layered sources into `{ apiKey, baseURL, model, providerName }` — the struct the runtime consumes. Per field, highest wins: CLI flags (`--provider`/`--model`) > per-repo `.intercode/settings.json` (selection only) > global `~/.intercode/settings.json`. Credentials come only from the settings files — no environment-variable override, and `.env` is not loaded.
- `--config <path>` replaces the global settings file as the provider source (useful for CI per-run injection). A provider must be defined in a settings file; there is no env fallback.
- `settings.ts` owns the schema, validators (the per-repo file rejects credentials), file loaders, and the pure `resolveProvider` precedence function.
- `providers.ts` defines the `ProviderCatalogEntry` type and helpers for building TUI provider lists; `profiles.ts` handles profile-level selection logic.
- `loadConfig` is async (it reads settings files). Parses flags `--cwd`, `--config`, `--provider`, `--model`, `--force`, `--dangerously-skip-permissions`; collects positional arguments as the optional initial task for the TUI.
- Both settings files are on the secret-guard denylist, so the agent cannot read its own credentials.

### TUI Runner (`src/tui/runner.tsx`)

- Builds a chat-mode agent using the `ChatDirector`
- Wires `ask_operator` to an operator-gate event resolved by a modal
- Drives the terminal alternate-screen buffer manually (Ink 7 has no alt-screen option) and renders the Ink app
- Bridges reactor events to React via an `EventEmitter`
- **Mid-run injection** — When a message arrives while the agent is running, it is queued in an `InjectionQueue`. On the next `inference.done` event (turn boundary), the queue is drained: each queued message is delivered via `agentProxy.deliver()` and a `"mid-run.delivered"` emitter event is fired so the badge count in the App updates. The queue is cleared on session rotation (`/clear`).
- **Session rotation** — Uses a serial session-operation queue (`createSessionOperationQueue`, not a boolean flag) so rotation, compaction continuation, and `agentProxy.deliver` never race a concurrent rebuild. Each operation chains onto the tail, ensuring in-flight work completes before the agent is torn down.

### Event Stream Consumer (`src/session/stream-consumer.ts`)

- Consumes the async iterable from `agent.stream()`, invoking a sink per event, with stream error handling

### Custom Directors (`src/agent/director.ts`, `src/subagent/index.ts`)

Two directors, selected by role:

- **ChatDirector** (interactive, `src/agent/director.ts`) — Extends `DefaultDirector` with task list tracking, workflow nudges, LSP auto-activation, and multi-turn chat semantics. It never terminates the session: operator declines are surfaced as replies and the reactor stays alive for the next message. SHIFT+TAB toggles **auto mode** (auto-approve non-destructive consequential actions through the permission gate); it is not a separate edit/plan mode.
- **SubAgentDirector** (delegated work, `src/subagent/index.ts`) — Drives a dispatched worker until a turn arrives with no tool calls, then replies with the final assistant text and ends the run. Hard stops also fire after 2 consecutive identical tool-call fingerprints (no-progress) or after the default 10-turn leaf budget, returning a structured salvage report (reason, partial findings, blockers) so a thrashing child cannot burn tokens indefinitely.

Both adopt the shared **compaction governor** (`src/agent/compaction.ts`) described below.

The agent maintains an optional **`manage_tasks`** list (create/update via the homonymous tool). The TUI task panel reflects director task state; `manage_tasks` tool calls are collapsed into a dedicated content block in the event stream.

#### Context compaction (the compaction governor)

When a cycle's input tokens cross a threshold, the director compacts the inference-facing history (the full run is always retained in the context store). The threshold is **model-aware** — roughly 60% of the active model's real context window — so small-window models compact early enough to avoid provider context-overflow while large-window models do not compact prematurely. The governor covers three cases:

- **Threshold at a tool pause** — Once over threshold, the follow-up `infer` after a tool batch is swapped for a `compact` cycle, and inference resumes via a host continuation message.
- **Idle (end-of-turn)** — An interactive turn can end with a reply and then sit idle with no tool batch to intercept; the governor requests a continuation at that pause and compacts when it arrives. An operator message that races the continuation still compacts first, then re-enters inference to answer it.
- **Overflow recovery** — A `context_overflow` inference error would otherwise become a terminal error reply; the governor compacts and retries instead, bounded so a history the compactor cannot shrink does not loop forever.

The compaction control flow is shaped by a reactor invariant: a `compact` action runs in its own cycle (it cannot be paired with `infer`), and **the reactor delivers no event after a compact cycle**. A director that simply emitted `compact` in place of the follow-up `infer` would leave the loop idle forever — the cause of an earlier stall. Instead the governor, after emitting `compact`, self-delivers a content-less inbound message (a host-supplied `requestContinuation` callback). That message adds no turn (`createInboundTurn` returns `null` for empty content) but re-enters the loop, where the director issues the follow-up `infer` against the freshly truncated history.

Compaction replaces older turns with a structured, workflow-aware summary rather than a stats blob: sections for **What Happened / What We're Doing / Relevant Links / Action Items / Next Steps**, with the active workflow and step woven in so compacting mid-`/build` or mid-`/plan` preserves the contract. The summary is produced by a one-shot model call; on any failure it falls back to a deterministic summary so a compaction cycle never breaks the session.

### Web Tools and Providers (`src/web/`)

`web_search` and `web_fetch` resolve a single `WebProvider` (one backend implements both, avoiding duplicate tool names). The backend is a **generic, core-agnostic plugin hook**: a plugin self-describes via a `manifest` with `kind: "web"` and declared `credentials`, and is auto-discovered from the plugin directories. The active web plugin is chosen by the `web` settings key (its id), or the single enabled web plugin; it is instantiated with the credentials stored under `settings.plugins[id]`. Core has no knowledge of any specific provider. Web access is **plugin-only**: there is no built-in fetcher, so when no web plugin is active, `web_search`/`web_fetch` are simply not registered. This keeps network egress (and the SSRF concerns that come with fetching arbitrary URLs from this process) inside the external provider's infrastructure rather than core. Concrete providers (e.g. Exa) live in top-level `plugins/`, outside core, and are managed through the `/plugins` UI. When a web plugin is active, the `web_search`/`web_fetch` tool calls render under its brand (e.g. "Exa Search").

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
- `runtime.ts` — `WorkflowRuntime` drives execution on a call stack: it skips capability-unsatisfied steps, descends into sub-workflow references, emits step lifecycle events, and snapshots `WorkflowState`. `state.ts` persists that snapshot atomically to `.agent-state/workflow.json` for resume.
- `coordinator.ts` — bridges runtime and director: produces the `[WORKFLOW STEP i/total: label]` directive injected into each turn's system prompt, and advances the runtime when `advance_workflow` (or a `submit_output` tagged `{ step }`) completes. Shared by both directors.
- The built-in recipes: the atomics `update-ticket`, `improve-docs`, `write-tests`, `triage-bug`, `code-review`, `scope-project`, and the `build-feature` composite that chains them.

Invocation: workflows are **not** top-level slash commands. Recipe definitions load into the `WORKFLOWS` registry from **enabled workflow/command plugins** at startup; command surfaces on those plugins (e.g. a workflow plugin's command prefix such as `/mywf scope`). Slash commands may also be authored as data-only markdown (`commands/*.md`, no `index.ts`); see PLUGINS.md. The model never suggests or auto-starts workflows from ordinary chat. Optional documentation skills (e.g. from an enabled agent plugin or `.agents/skills/`) load on demand via `use_skill` (see Skills below). The TUI surfaces state via `src/tui/workflow-controller.ts` (lifecycle, capability overrides, resume) — the header shows step progress (`⟳ name · step/total label`).

### Sub-agents (`src/subagent/`, `src/agent/agent-search.ts`)

Three distinct concepts (do not conflate them):

| Concept | What it is | Surface |
|---|---|---|
| **Agent** | A runtime entity with its own loop, tools, and context | Primary session or a spawned child |
| **Task** | A checklist item owned by *one* agent via `manage_tasks` | Local work plan — not a spawn |
| **Sub-agent** | A short-lived child agent for one self-contained job | Spawned with the **`task`** tool (wire name kept for compatibility) |

The **`task`** tool **spawns a sub-agent** on a separate inference source (tier/profile resolved from settings). The dispatch brief separates durable `context`, actionable `prompt`, and optional `goals` (checklist seeds for the *child's* own `manage_tasks` list). The child returns a structured report (`Summary` / `Findings` / `Blockers` / `Paths`) plus a tools-used footer. Parent and child never share a `manage_tasks` list.

When profiles exist (local `.agents/agents/` and/or enabled **`kind: "agent"`** plugins, including **data-only** markdown plugins with no `index.ts`), the chat model also receives **`search_agents`** — a lexical index over profile id, description, and role text so the model can discover ids before calling `task(agent=...)`. `task` and `search_agents` are core tools on the primary session.

Profiles with `orchestrator: true` may themselves call `task` (one hop only): nested dispatch installs `task` + `search_agents` with `allowOrchestrator: false` so the tree bottoms out. Unknown `agent` ids fail closed.

**Session records** (`src/subagent/session-store.ts`): each spawn is retained as an inspectable child session (id, profile, description, brief, status, tool activity, transcript entries). Child events land only in this store — not in the parent chat transcript. Live progress still uses the light `onProgress` channel for the status bar / Agents strip. Completed sessions are capped (`maxCompleted`) so a long chat does not grow without bound.

**Enter-session TUI** (`src/tui/components/agents-strip.tsx`, `subagent-session-view.tsx`): `Ctrl+E` opens Agents-strip navigation (↑/↓ select, Enter observe, `x`/Backspace cancel selected running worker, Esc leave nav). Entering a session swaps the main log for that child's transcript (live while running, historical when done/failed/cancelled) without stealing the parent reactor. Header chrome shows which agent is focused; Esc returns to the parent; `x` cancels the focused running worker. Parent Esc/stop and `/clear` call `cancelAll` so live children close (`agent.close`) instead of continuing after the parent stops.

Data-only agent plugins (`src/plugins/data-only-agent.ts`) synthesize `agentPlugin.agents[]` from `agents/*.md` or flat `*.md` in the plugin directory, with optional co-located `skills/`. `loadPluginEntry` tries JS entrypoints first, then falls back to this layout (`/plugins` add-by-path supports filesystem completion via `listPathSuggestions`).

### System Prompt (`src/agent/prompts.ts`)

The agent's identity is **Intercode**, framed as a senior coding assistant running in a terminal harness. The prompt is deliberately minimal: a frontier model already knows how to be a coding agent, so the static prompt carries only what it cannot derive — harness-specific facts and the project's identity. The base is three small, individually-exported sections:

- `buildChatRole` — one-line identity and purpose.
- `buildHarnessFacts` — the non-derivable rules: shell file-writes are blocked (use `write_file`/`edit_file`), dependency installs and off-limits paths need approval, images are native multimodal input, only core tools are resident (load the rest via `tool_search`; use `search_agents` before dispatching specialists), workflows run only from slash-command steps, and session memory lives at `.intercode/MEMORY.md`.
- `buildGuidelines` — be concise, answer questions and diagnose visual/product feedback before editing, work autonomously for explicit coding tasks, use `lsp` for symbol work, and verify changes when practical.

`buildChatSystemPrompt` (TUI chat) and `buildSubAgentSystemPrompt` assemble: base → core tool list → lazy skills listing → live `<env>` block → appended extensions. Built-in catalog tools and MCP integrations load dynamically via `tool_search` rather than being enumerated. Skills follow the same lazy principle pi-style: each discovered skill contributes only its name + one-line description to the prompt, and the model pulls a skill's full instructions into context on demand by calling `use_skill`. Skill loading is entirely model-driven — there is no operator invocation. Skills are discovered (and deduped by name) from enabled plugin dirs, then `.agents`/`.claude`/`.codex/skills`, in that precedence. Intercode does not ship a bundled skill catalog — skills come from plugins and the project tree.

**Overrides.** `loadSystemPromptOverrides` (`src/agent/context-extensions.ts`) resolves a project `SYSTEM.md` (repo root, then `.intercode/`) that **replaces** the static base block, and an `APPEND_SYSTEM.md` that is **appended** as an extension. These compose with `config.systemPromptExtensions` (profile config) and the auto-discovered `AGENTS.md`, all of which attach as appended sections after the base.

### State Persistence (`src/session/state.ts`)

- `RunState` — `running` | `done` | `failed`, turns used, task, timestamps, error
- Atomic JSON save/load to `.agent-state/run.json`, with schema validation on load
- Conversation context is persisted separately by the git-backed store under `.agent-state/context`

### Lifecycle Hooks (`src/session/hooks.ts`)

- Discovers `postTurn` / `postRun` hooks (TypeScript or shell) from `.intercode/hooks` (local) and `~/.intercode/hooks` (global)
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
    → secretGuardPlugin   (hard-deny secret files)
      → authzPlugin       (deny catastrophic commands)
        → permissionPlugin (tiered operator approval)
          → verifyPlugin   (post-write/edit verification)
            → actual tool execution
```

**Rejection behavior:** Any plugin can short-circuit by returning a `ToolResult` with `isError: true`; the error propagates to the agent and downstream plugins/execution are skipped.

- **Path Escape** (`path-escape-plugin.ts`) — Canonicalizes path-like arguments against `cwd` and blocks `..` escapes. Runs first so later plugins see resolved paths.
- **Tool-output URI** (`tool-output-uri-plugin.ts`) — Normalizes mistaken `read_file` blob URIs to `tool-output:///id` (intercode-only; interchange stays unpatched).
- **Secret Guard** (`secret-guard-plugin.ts`) — Hard-denies tool calls that would expose a sensitive file: path-keyed arguments (`read_file`, `write_file`, …) and `run_shell` command strings, which are tokenized so `cat .env` or `cat ~/.intercode/settings.json` are blocked the same as a direct read. Runs before the permission plugin, so the deny holds even under `--dangerously-skip-permissions`. Shell containment is best-effort: token matching defeats quoting and env-assignment/redirection forms but not dynamic path construction (variable indirection, `printf` assembly).
- **Authorization** (`run-shell-authz.ts`, wired by `authz-plugin.ts`) — Denies catastrophic shell command patterns by regex, and hard-blocks open-ended shell searches (`find`, `rg`, `grep -r`) that OOM the host; those must go through the bounded `grep`/`search_files`/`list_dir` tools. The permission gate’s shell auto-allow path consults the same policy so it never pre-approves a command authz would reject.
- **Permission** (`permission-plugin.ts`) — Delegates consequential calls to the permission gate.
- **Shell Guard** (`shell-guard-plugin.ts`) — Intercode-only replacement for stock `run_shell` (interchange stays unpatched): 10s default timeout, 512KB output cap, process-group kill on timeout/oversize/abort. Also applies a 10s wall-clock budget to `grep`/`search_files`.
- **Verify** (`verify-plugin.ts`) — Re-reads after `write_file` / `edit_file` and errors on mismatch. Per-path serialization (`file-mutation-lock.ts`) prevents parallel edits on one file from tripping verification.
- **Edit file line range** (`edit-file-line-range-plugin.ts`) — Intercode-only short-circuit for `edit_file` mode B (`start_line`/`end_line`/`new_string`), same pattern as shell-guard; schema advertised via `advertiseEditFileLineRange`. When a call includes both `old_string` and line-range fields, the plugin reads the file and treats the call as line-range if `old_string` matches those lines; otherwise it returns a recoverable error naming which fields to omit.
- **Edit file diagnostics** (`edit-file-diagnostics-plugin.ts`) — On stock substring mismatch (`old_string not found` / not unique), appends nearby file context (whitespace near-miss, occurrence lines) without changing match semantics.
- **LSP hint** (`lsp-hint-plugin.ts`) — Appends a typescript-language-server install hint when the stock `lsp` tool reports no server for TS/JS paths.

### Permission System (`src/permission/`)

- **classify** — Read-only tools (`read_file`, `search_files`, `grep`, `list_dir`) are tier `allow`; everything else is tier `ask`. Builds discrete approval requests: chained shell commands split into one request per segment; file tools keyed on the target path; other tools keyed on tool name.
- **command** — Splits chained commands and derives command-shape approval scopes.
- **auto-shell-policy** — A flat, first-match-wins table of rules that constrain `run_shell` even when auto mode would otherwise rubber-stamp it. Each rule carries an effect: `deny` blocks the command outright with a reason (file mutations through ad-hoc tooling — output redirection, `tee`, `sed -i`/`perl -i`, interpreter inline programs or heredocs — which must instead go through `write_file`/`edit_file`); `ask` declines to auto-allow and falls through to the operator prompt (recursive `rm`, dependency installs and remote runners: npm/yarn/pnpm/bun, pip, cargo, go, brew, npx/bunx, …). Quoted spans are stripped before matching so a quoted `>` or install word in an argument is not flagged, and program names are matched only in command position (start, after a separator, or after a brace-group open). Adding a category is a one-line rule append.
- **gate** — Evaluates a call: `skipPermissions` allows everything; `allow`-tier passes; for `ask`-tier, checks persisted approvals, otherwise requests operator approval. In a non-interactive run an unresolved `ask` becomes a denial. In auto mode the gate consults the auto-shell policy first: a `deny` rule fails the call, an `ask` rule skips the auto-allow shortcut and proceeds to the normal approval flow, and anything unmatched is auto-allowed. Newly granted scopes are appended in memory and persisted.
- **matcher** — Glob matching of an approval pattern against a request subject.
- **store** — Loads/persists approvals scoped to the working directory.
- **types** — `Approval`, `ApprovalScope`, `PermissionRequest`, `ApprovalOutcome`.

Approval scopes offered: Allow Once (persist nothing), Allow Always for a file or its directory (file tools), or a command shape (shell). There is intentionally no "all files" rung.

### TUI (`src/tui/`)

Ink 7 + React 19, full-screen via the alternate-screen buffer.

- `app.tsx` — Root layout: pinned header, scrollable event log, chat input, status bar, and overlay modals. Owns keymap, gate/scroll state, and the mid-run message queue (`pendingQueueRef` + `queuedCount`): while `isProcessing`, **Alt+Enter** enqueues outbound messages and **Enter** steers via interrupt (see interrupt/queue steering below). The queue drains one message per `connector.reply` (end of a response cycle), skipping drain while status is `blocked` (permission/operator gates). The queue is cleared on session rotation (`/clear`, `/new`). SHIFT+TAB enables auto mode, which auto-approves non-destructive consequential actions through the permission gate (`onToggleAuto`). Plan handling is a separate approval gate (`use-gates`), not a mode. `@file` mentions in chat input are resolved to file contents before the message is sent to the agent.

  **Line cache** — `app.tsx` maintains a `Map<string, StyledLine[]>` (keyed `blockId:expansion`) passed to `buildLines`. Completed blocks are cached; the last block (still streaming) is always recomputed. The cache is cleared when layout width or display options change. `buildLines` evicts entries for block IDs not in the current block list on every call, so manage_tasks/present splices do not accumulate orphaned entries.

- `use-stream.ts` — Consumes `agent.stream()` events into typed content blocks and tracks turns/status/cost. **AgentStatus** is a 7-state machine: `"idle"` (not-yet-started or post-clear), `"running"`, `"stopping"`, `"stopped"`, `"blocked"` (awaiting operator), `"done"`, `"failed"`. Initial state and post-`/clear` state are both `"idle"` (not `"running"`), so the permission-gate refcount (`setGatePending`) correctly skips terminal and idle states.

  **Rate-limited renders** — Token events (`inference.text.delta`, `inference.thinking.delta`, `inference.tool_call.delta`) set a `pendingRenderRef` flag rather than calling `setTick` directly. A 33ms `setInterval` drains the flag, batching token renders to ~30fps. Structural events (status changes, turn boundaries, tool completions) bypass the drain and call `setTick` immediately so state transitions are never delayed.

- **Interrupt and queue steering** (`chat-input.tsx`) — When `isProcessing` is true:
  - **Enter** calls `onInterrupt(message)`, which synchronously calls `requestStop()` (aborting the in-flight HTTP request) before resolving `@file` mentions and sending. The abort-before-async ordering ensures no stale `connector.reply` can race the new turn.
  - **Alt+Enter** calls `onSubmit(message)` immediately, queuing the message for delivery after the current response cycle completes.
  - A hint line (`↵ interrupt · Alt+↵ queue`) is shown in the input area while processing and the queue is empty.

- **Status bar** — Shows the working directory, model name, optional reasoning-effort suffix, terminal status, and the brand label. Token counts and cost display removed.

- **Task view** — Compact rendering: shows only the current in-progress task plus a `(N done, M todo)` count suffix. No scrolling task list.

- **In-flight indicator** — Spinner uses the `"live"` semantic color (calm blue) rather than the brand orange, reducing visual noise during long runs.

- Hooks: `use-gates` (permission/plan/operator gates), `use-keymap`, `use-scroll`, `use-mouse-scroll`, `use-spinner`, `use-terminal-size`, `use-layout-geometry`, `use-mcp-status`, `use-provider-manager`.
- Components: `header`, `event-log`, `chat-input`, `status-bar`, `task-view`, `operator-modal`, `permission-modal`, `permissions-manager`, `plugins-manager`, `settings-overlay`, `agent-modal`, `exit-confirm`, `help-overlay`, `hook-panel`, `login-provider-picker`, `codex-login-modal`, `mcp-auth-prompt`, `onboarding-animation`, `in-flight-indicator`.
- Support: `stdin-filter.ts` (strips SGR mouse sequences before Ink parses input — see below), `tool-formatter.ts` (human-readable tool args/results), `markdown-parser.ts`, `keymap-table.ts`, `theme.ts` (semantic color roles including `dim` and `live`).
- Slash commands: `commands/registry.ts` (extensible registry) + `commands/built-in.ts` (`/help`, `/model`, `/settings`, `/permissions`, `/plugins`, `/login`, `/codex`, `/xai`, `/grok`, `/clear`, `/new`, `/mcp`).
- `/agent` configuration surface (`components/agent-modal.tsx`): a full-screen, section-based modal. The Provider/Model section reuses the CL-927 catalog (from `config.providers`) and applies a switch live via `agent.setSource()` — the runtime's in-place source mutation, read at the next inference call, so no agent recreation. "Set as default" persists the selection (selection-only, no credentials) to the per-repo `.intercode/settings.json` via `saveLocalSettings`. The section model leaves room for system-prompt/profile sections without new slash commands, and for the CL-1224 add-provider/onboarding step.

#### Event log rendering

`event-log.tsx` renders the content block list to a flat `StyledLine[]` buffer; the viewport slices it by index. Notable rendering behaviors:

- **Collapsed tool calls** — Non-danger tools render dimmed with a muted summary suffix. Danger-role tools (destructive shell, writes under risk paths) retain their role color when collapsed so they remain visually salient.
- **Thinking gutter** — When `thinkingExpanded` is true, thinking content lines are prefixed with `│ ` in the `dim` color, separating them visually from model output without requiring a header.
- **Block-level cache** — `buildLines` accepts an optional `Map<string, StyledLine[]>` cache. Completed blocks are served from cache; only the streaming tail is recomputed per render tick. Individual log lines use a memoized `RenderedLine` component so padding/segment merge work is not repeated when only the viewport scroll offset changes.

#### Input handling

Ink reads stdin, parses it into string events, and broadcasts every event to *all* mounted `useInput` handlers. That broadcast model means an escape sequence not consumed by one handler leaks into another — in particular, SGR mouse tracking sequences (emitted on every terminal click, e.g. `ESC[<0;39;38M`) would surface as literal `[<...` text in whichever input is focused.

Rather than filter per component, `stdin-filter.ts` (`createFilteredStdin`) wraps `process.stdin` and is passed to Ink's `render` via the `stdin` option. It proxies the stream, intercepting `read()` to strip all `ESC[<…M/m` sequences before Ink's parser sees them — so no component's `useInput` ever receives one. A sequence split across two `read()` calls is handled by holding back an incomplete trailing `ESC[<…` (the SGR private marker is unambiguous, so this never swallows a boundary-split Esc or arrow key) and prepending it to the next chunk. This depends on Ink 7 driving its input pipeline off `stdin.read()`; bytes Ink consumes via its transient Kitty-keyboard probe are `unshift`ed back and re-enter through `read()`, so they pass through the filter too.

Mouse-wheel events are the one class of mouse input the UI acts on. Since they can no longer arrive through `useInput`, the filter detects wheel buttons (64 = up, 65 = down) and re-emits them as `scrollUp`/`scrollDown` on a dedicated `EventEmitter`. `use-mouse-scroll` subscribes to that emitter (and still owns enabling/disabling SGR mouse mode on the terminal). Bursts of wheel events within one frame are coalesced before updating scroll offset so rapid scrolling stays smooth.

### Skills (`src/extensions/skills.ts`)

Skills are Markdown capability packages (`SKILL.md`) that the model loads on demand — pi-style lazy skills. They are not slash commands and are never operator-invoked; discovery and loading are entirely model-driven.

#### Discovery and precedence

`discoverSkills(cwd, pluginDirs)` runs at session start and returns each available skill's `name` + one-line `description` for the lazy listing in the system prompt. It scans the following base directories, highest precedence first:

| Base directory | Source |
|---|---|
| `<pluginDir>/skills/` | Each enabled plugin that ships skills (`runner.tsx` includes only `pluginConfig[id].enabled`) |
| `.agents/skills/` | Shared across runtimes |
| `.claude/skills/` | Claude Code workspace skills |
| `.codex/skills/` | Codex workspace skills |

Each `<base>/<skill-name>/SKILL.md` is one skill. Discovery dedupes by directory name: the first base dir that provides a given name wins, so an enabled plugin skill shadows a project-local skill of the same name. `resolveSkillBody(cwd, ref, pluginDirs)` resolves a skill's body using the same ordered list (it accepts a bare name or a `plugin:name` ref, keying on the name).

#### SKILL.md format

A skill file begins with a YAML frontmatter block, followed by the body that holds the instructions. The loader parses only `description`; the skill's identifier (what `use_skill` takes) is its directory name. A skill with no `SKILL.md` or an empty body is skipped.

| Field | Required | Description |
|---|---|---|
| `description` | yes | One-line summary shown in the prompt's lazy skills listing |
| `name` | conventional | Conventionally matches the directory name; the directory name is what is actually used as the identifier |

There are no `type`, `argument-hint`, or `disable-model-invocation` fields — a skill body is plain instruction text. Multi-step orchestration is a separate mechanism (see Workflows above), not a skill `type`.

#### Loading (model-driven)

`buildSkillsSection` lists each discovered skill as `- name: description` in the system prompt — descriptions only, so the prompt stays small regardless of how many skills exist. The full instructions enter context only when the model calls the `use_skill` core tool (`src/agent/use-skill.ts`) with a skill name; the handler calls `resolveSkillBody`, strips the frontmatter, and returns the body as the tool result. There is no slash-command surface and no operator-side injection — the model decides when a skill applies and loads it itself.

Which plugin skill directories are in scope is decided in `runner.tsx`, which passes the enabled plugins' dirs to both `discoverSkills` (for the listing) and the `use_skill` tool (for resolution). Project-local `.agents`/`.claude`/`.codex/skills` are always searched.

## Data Flow

```
CLI argv
  → src/config/index.ts (Config)
    → src/tui/runner.tsx (TUI)
      → LoadState, LoadPricing, discover hooks
      → CreatePermissionGate
      → CreatePosixTools (plugin chain)
      → Create director (ChatDirector)
      → CreateAgent (git-backed contextDir)
      → SaveState (running)
      → agent.send(task)
      → src/session/stream-consumer.ts → sink
          → turnCollector.observe → postTurn hooks
          → emit to React (TUI)
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
         [failed] (TUI may surface and allow retry; context persists under .agent-state/)
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
