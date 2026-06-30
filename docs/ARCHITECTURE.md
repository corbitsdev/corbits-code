# Intercode — Architecture

## System Overview

The system is an event-driven agent loop with a custom reactor director. The CLI parses arguments, builds a `Config`, creates an agent with sandboxed tools and a policy director, sends a task, and consumes the event stream. A custom director enforces policy on top of the reactor's default behavior. Two front ends consume the same loop: a headless renderer (stderr) and an Ink-based TUI.

## The Reactor Loop

The reactor (from `@intx/agent`) drives a single agent turn-by-turn. Each turn is:

1. **Inference** — the LLM produces an assistant turn (text plus zero or more `tool_call` blocks).
2. **Tool dispatch** — each `tool_call` runs concurrently; results return as `tool.done` events.
3. **Director decision** — `CodingDirector.decide()` receives every event and returns `ReactorAction[]` that control what happens next.

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

### Mandatory director-layer tools

Two tools exist only at the director layer and gate the loop:

- **`submit_plan`** — records the plan into durable director state; required before `submit_output` is accepted.
- **`submit_output`** — the only signal that terminates cleanly. Conversational text without it does not end the session; the reactor keeps running inference turns until `submit_output` is called or the director aborts on a stall.

## Components

### CLI Entry (`src/index.ts`)

- Parses verbs (`run` (optional), `resume`) and `--help`
- Dispatches to `runAgent` (headless) or `runTUI` (default)
- Handles resume by loading previous `RunState` + `DirectorPersistedState` and re-running with the prior task

### Config Resolution (`src/config/index.ts`, `src/config/settings.ts`)

- Resolves the inference provider from layered sources into `{ apiKey, baseURL, model, providerName }` — the struct the runtime consumes. Per field, highest wins: CLI flags (`--provider`/`--model`) > per-repo `.intercode/settings.json` (selection only) > global `~/.intercode/settings.json`. Credentials come only from the settings files — no environment-variable override, and `.env` is not loaded.
- `--config <path>` replaces the global settings file as the provider source (useful for CI per-run injection). A provider must be defined in a settings file; there is no env fallback.
- `settings.ts` owns the schema, validators (the per-repo file rejects credentials), file loaders, and the pure `resolveProvider` precedence function.
- `providers.ts` defines the `ProviderCatalogEntry` type and helpers for building TUI provider lists; `profiles.ts` handles profile-level selection logic.
- `loadConfig` is async (it reads settings files). Parses flags `--cwd`, `--config`, `--provider`, `--model`, `--force`, `--headless`/`-h`, `--dangerously-skip-permissions`; collects positional arguments as the task description.
- Both settings files are on the secret-guard denylist, so the agent cannot read its own credentials.

### Agent Runner (`src/agent/run-agent.ts`)

- Loads run state and refuses to start over an in-progress run (unless `--force`)
- Loads pricing (models.dev) and starts a background pricing refresh
- Builds the lifecycle hook manager from discovered hooks
- Constructs the permission gate (seeded with persisted approvals; non-interactive in headless)
- Creates sandboxed POSIX tools wrapped in the plugin chain
- Registers director-layer tools (`submit_plan`, `ask_operator`, `submit_output`)
- Creates the `CodingDirector` and the agent (`createAgent`), with a git-backed context dir at `.agent-state/context`
- Streams events through a turn-context collector (feeding `postTurn` hooks) and a renderer
- Saves run + director state on each turn; runs critique; dispatches the `postRun` summary; cleans up

### TUI Runner (`src/tui/runner.tsx`)

- Builds a chat-mode agent using the `ChatDirector` (with an optional plan-approval gate)
- Wires `ask_operator` to an operator-gate event resolved by a modal
- Drives the terminal alternate-screen buffer manually (Ink 7 has no alt-screen option) and renders the Ink app
- Bridges reactor events to React via an `EventEmitter`
- **Mid-run injection** — When a message arrives while the agent is running, it is queued in an `InjectionQueue`. On the next `inference.done` event (turn boundary), the queue is drained: each queued message is delivered via `agentProxy.deliver()` and a `"mid-run.delivered"` emitter event is fired so the badge count in the App updates. The queue is cleared on session rotation (`/clear`).
- **Session rotation** — Uses a serial `opQueueTail` promise chain (not a boolean flag) to prevent concurrent rotation operations. Each new rotation chains onto the tail, ensuring in-flight operations complete before the session is torn down.

### Event Stream Consumer (`src/session/stream-consumer.ts`)

- Consumes the async iterable from `agent.stream()`, invoking a sink per event, with stream error handling

### Custom Directors (`src/agent/director.ts`)

Two directors, selected by front end:

- **CodingDirector** (headless) — Extends `DefaultDirector` with stall detection and plan enforcement.
- **ChatDirector** (TUI) — `DefaultDirector` plus the plan-approval gate: when a plan is submitted it pauses for approve/reject before continuing. There is a single, opinionated mode — no Manager/Teammate toggle. (`createChatDirector` retains a no-gate fallback to `DefaultDirector` as an implementation detail, but the product runs one mode with the gate present.)

**ChatDirector** (TUI) operates in three modes, cycled by the user with SHIFT+TAB:

- **Edit** — full tool access; the agent can read, write, and run shell commands.
- **Auto** — same as Edit, but the agent runs continuously without per-action approval gates. Auto mode is not a blanket bypass: the auto-shell policy still denies file mutations attempted through shell tooling (steering them to `write_file`/`edit_file`) and still routes dependency installs to an operator prompt (see Permission System).
- **Plan** — write-restricted; `write_file` and `edit_file` are stripped from the infer action set. The agent may only read, search, and reason. `submit_plan` is promoted into the active tool set exactly when the user enters Plan mode (not globally), so the chat model is never advertised a tool it cannot call. When the user cycles out of Plan mode, `exitPlanPhase()` on the director undoes the write restriction. The TUI resets to Edit when the director emits a `"plan-phase"` event signaling plan approval.

Plan steps auto-show in the sidebar when `submit_plan` has been called — no manual `/plan` command is needed. The sidebar also auto-shows when a workflow is active.

**CodingDirector** behavior:
- **Idle cycle detection** — Counts consecutive turns without tool calls; after 3, checkpoints and aborts.
- **Plan storage** — Captures `submit_plan` arguments into durable director state.
- **Submit gating** — `submit_output` is rejected by its tool handler unless a plan was submitted; if a multi-turn task completes with no plan, the director appends a warning.
- **Read tracking** — Records the turn at which each file was read (`filesReadAtTurn`), which the re-read-block plugin consults to prevent redundant re-reads.

Director state persisted for resume: `turnsUsed`, `submitCalled`, `callIdToName`, `idleCycles`, `planSubmitted`, `plan` steps, and `filesRead` (path → turn).

#### Context compaction (ChatDirector)

When cumulative input tokens cross a threshold, the ChatDirector compacts the inference-facing history (the full run is always retained in the context store). The threshold is **model-aware** — roughly 60% of the active model's real context window — so small-window models compact early enough to avoid provider context-overflow while large-window models do not compact prematurely.

The compaction control flow is shaped by a reactor invariant: a `compact` action runs in its own cycle (it cannot be paired with `infer`), and **the reactor delivers no event after a compact cycle**. A director that simply emitted `compact` in place of the follow-up `infer` would leave the loop idle forever — the cause of an earlier stall. Instead the director, after emitting `compact`, self-delivers a content-less inbound message (a host-supplied `requestContinuation` callback). That message adds no turn (`createInboundTurn` returns `null` for empty content) but re-enters the loop, where the director issues the follow-up `infer` against the freshly truncated history.

Compaction replaces older turns with a structured, workflow-aware summary rather than a stats blob: sections for **What Happened / What We're Doing / Relevant Links / Action Items / Next Steps**, with the active workflow and step woven in so compacting mid-`/build` or mid-`/plan` preserves the contract. The summary is produced by a one-shot model call; on any failure it falls back to a deterministic summary so a compaction cycle never breaks the session.

### Web Tools and Providers (`src/web/`)

`web_search` and `web_fetch` resolve a single `WebProvider` (one backend implements both, avoiding duplicate tool names). The backend is a **generic, core-agnostic plugin hook**: a plugin self-describes via a `manifest` with `kind: "web"` and declared `credentials`, and is auto-discovered from the plugin directories. The active web plugin is chosen by the `web` settings key (its id), or the single enabled web plugin; it is instantiated with the credentials stored under `settings.plugins[id]`. Core has no knowledge of any specific provider. Web access is **plugin-only**: there is no built-in fetcher, so when no web plugin is active, `web_search`/`web_fetch` are simply not registered. This keeps network egress (and the SSRF concerns that come with fetching arbitrary URLs from this process) inside the external provider's infrastructure rather than core. Concrete providers (e.g. Exa) live in top-level `plugins/`, outside core, and are managed through the `/plugins` UI. When a web plugin is active, the `web_search`/`web_fetch` tool calls render under its brand (e.g. "Exa Search").

### Director-Layer Tools (`src/agent/director.ts`)

- `submit_plan` — Ordered steps of `{ file, action, reason }` plus an optional `goal`; declared on turn 1. In the TUI, promoted into the active tool set only when the user enters Plan mode.
- `ask_operator` — Pauses for a clarifying question with a list of options.
- `submit_output` — The only clean termination signal; requires a prior plan.
- `advance_workflow` — Advances the active workflow to its next step (observed by the director). Only advertised while a workflow is running.
- `plan_enter` — Signals the director to enter plan phase; advertised in `CORE_TOOL_NAMES` for the chat model to invoke when it decides to plan before acting.

### Workflows (`src/workflows/`)

Workflows are named, ordered recipes the agent follows step by step — a thin layer above the reactor loop, not a replacement. They ship as first-class TypeScript validated at compile time with `satisfies Workflow`; the static `WORKFLOWS` registry is the single source of truth.

- `types.ts` — `Workflow`, `WorkflowStep` (`prompt`, `capability`, `agent`, `skill`, `workflow` sub-workflow ref, `optional`, `parallel`, `type: "gate"`), and the `WorkflowState` persistence shape. `MAX_WORKFLOW_DEPTH` bounds nesting.
- `capabilities.ts` — `detectCapabilities` maps the live tool surface to abstract capabilities (`ticket-tracker`, `code-host`, `doc-search`) by name pattern; `resolveStep` decides whether a step runs. A capability override set forces integrations off per run. Adding a capability is a data edit, not a logic change.
- `runtime.ts` — `WorkflowRuntime` drives execution on a call stack: it skips capability-unsatisfied steps, descends into sub-workflow references, emits step lifecycle events, and snapshots `WorkflowState`. `state.ts` persists that snapshot atomically to `.agent-state/workflow.json` for resume.
- `coordinator.ts` — bridges runtime and director: produces the `[WORKFLOW STEP i/total: label]` directive injected into each turn's system prompt, and advances the runtime when `advance_workflow` (or a `submit_output` tagged `{ step }`) completes. Shared by both directors.
- The built-in recipes: the atomics `update-ticket`, `improve-docs`, `write-tests`, `triage-bug`, `code-review`, `scope-project`, and the `build-feature` composite that chains them.

Invocation: workflows are **not** top-level slash commands. Recipe definitions load into the `WORKFLOWS` registry from **enabled `kind: "workflow"` plugins** at startup (`registerWorkflowPlugins`); command surfaces on those plugins (e.g. `plugins/linear-workflows` → `/linear scope`, `/linear build`). The model never suggests or auto-starts workflows from ordinary chat. Documentation work uses the **scribe** command plugin (`/scribe`), which injects the `gaas:scribe` skill rather than a workflow recipe. The TUI surfaces state via `src/tui/workflow-controller.ts` (lifecycle, capability overrides, resume) — the header shows step progress (`⟳ name · step/total label`).

### System Prompt (`src/agent/prompts.ts`)

The agent's identity is **Intercode**, framed as a senior teammate who owns the outcome (not an assistant). The prompt is deliberately minimal: a frontier model already knows how to be a coding agent, so the static prompt carries only what it cannot derive — harness-specific facts and the project's identity. The base is three small, individually-exported sections:

- `buildChatRole` — one-line identity and quality bar.
- `buildHarnessFacts` — the non-derivable rules: shell file-writes are blocked (use `write_file`/`edit_file`), dependency installs need approval, `.agent-state`/gitignored paths are off-limits, only core tools are resident (load the rest via `tool_search`), workflows are slash-command only, tool results render richly (use `present`), and session memory lives at `.intercode/MEMORY.md`.
- `buildGuidelines` — be concise, stay in scope, `lsp` before large files, verify before finishing.

`buildChatSystemPrompt` (TUI chat) and `buildSubAgentSystemPrompt` assemble: base → core tool list → live `<env>` block → appended extensions. Everything beyond core tools — built-in catalog tools, MCP integrations, skills — is loaded dynamically rather than enumerated in the prompt.

**Overrides.** `loadSystemPromptOverrides` (`src/agent/context-extensions.ts`) resolves a project `SYSTEM.md` (repo root, then `.intercode/`) that **replaces** the static base block, and an `APPEND_SYSTEM.md` that is **appended** as an extension. These compose with `config.systemPromptExtensions` (profile config) and the auto-discovered `AGENTS.md`, all of which attach as appended sections after the base.

### State Persistence (`src/session/state.ts`)

- `RunState` — `running` | `done` | `failed`, turns used, task, timestamps, error
- `DirectorPersistedState` — director internals for resume
- Atomic JSON save/load to `.agent-state/run.json` and `.agent-state/director.json`, with schema validation on load
- Conversation context is persisted separately by the git-backed store under `.agent-state/context`

### Post-Submit Critique (`src/agent/critic.ts`)

- Runs after the agent completes, before acceptance
- Runs `build`, `typecheck`, and `test` scripts when present in the target `package.json`
- 5-minute timeout per command; accepts only if all pass; surfaces failures as errors

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
            → reReadBlockPlugin (block redundant re-reads)
              → actual tool execution
```

**Rejection behavior:** Any plugin can short-circuit by returning a `ToolResult` with `isError: true`; the error propagates to the agent and downstream plugins/execution are skipped.

- **Path Escape** (`path-escape-plugin.ts`) — Canonicalizes path-like arguments against `cwd` and blocks `..` escapes. Runs first so later plugins see resolved paths.
- **Tool-output URI** (`tool-output-uri-plugin.ts`) — Normalizes mistaken `read_file` blob URIs to `tool-output:///id` (intercode-only; interchange stays unpatched).
- **Secret Guard** (`secret-guard-plugin.ts`) — Hard-denies tool calls that would expose a sensitive file: path-keyed arguments (`read_file`, `write_file`, …) and `run_shell` command strings, which are tokenized so `cat .env` or `cat ~/.intercode/settings.json` are blocked the same as a direct read. Runs before the permission plugin, so the deny holds even under `--dangerously-skip-permissions`. Shell containment is best-effort: token matching defeats quoting and env-assignment/redirection forms but not dynamic path construction (variable indirection, `printf` assembly).
- **Authorization** (`authz-plugin.ts`) — Denies catastrophic shell command patterns by regex.
- **Permission** (`permission-plugin.ts`) — Delegates consequential calls to the permission gate.
- **Verify** (`verify-plugin.ts`) — Re-reads after `write_file` / `edit_file` and errors on mismatch. Per-path serialization (`file-mutation-lock.ts`) prevents parallel edits on one file from tripping verification.
- **LSP hint** (`lsp-hint-plugin.ts`) — Appends a typescript-language-server install hint when the stock `lsp` tool reports no server for TS/JS paths.
- **Re-read Block** (`re-read-block-plugin.ts`) — Consults the director's read tracking to block re-reading an already-read file.

### Permission System (`src/permission/`)

- **classify** — Read-only tools (`read_file`, `search_files`, `grep`, `list_dir`) are tier `allow`; everything else is tier `ask`. Builds discrete approval requests: chained shell commands split into one request per segment; file tools keyed on the target path; other tools keyed on tool name.
- **command** — Splits chained commands and derives command-shape approval scopes.
- **auto-shell-policy** — A flat, first-match-wins table of rules that constrain `run_shell` even when auto mode would otherwise rubber-stamp it. Each rule carries an effect: `deny` blocks the command outright with a reason (file mutations through ad-hoc tooling — output redirection, `tee`, `sed -i`/`perl -i`, interpreter inline programs or heredocs — which must instead go through `write_file`/`edit_file`); `ask` declines to auto-allow and falls through to the operator prompt (dependency installs and remote runners: npm/yarn/pnpm/bun, pip, cargo, go, brew, npx/bunx, …). Quoted spans are stripped before matching so a quoted `>` or install word in an argument is not flagged, and program names are matched only in command position (start, after a separator, or after a brace-group open). Adding a category is a one-line rule append.
- **gate** — Evaluates a call: `skipPermissions` allows everything; `allow`-tier passes; for `ask`-tier, checks persisted approvals, otherwise requests operator approval. In a non-interactive run an unresolved `ask` becomes a denial. In auto mode the gate consults the auto-shell policy first: a `deny` rule fails the call, an `ask` rule skips the auto-allow shortcut and proceeds to the normal approval flow, and anything unmatched is auto-allowed. Newly granted scopes are appended in memory and persisted.
- **matcher** — Glob matching of an approval pattern against a request subject.
- **store** — Loads/persists approvals scoped to the working directory.
- **types** — `Approval`, `ApprovalScope`, `PermissionRequest`, `ApprovalOutcome`.

Approval scopes offered: Allow Once (persist nothing), Allow Always for a file or its directory (file tools), or a command shape (shell). There is intentionally no "all files" rung.

### TUI (`src/tui/`)

Ink 7 + React 19, full-screen via the alternate-screen buffer.

- `app.tsx` — Root layout: pinned header, scrollable event log, chat input, status bar, and overlay modals. Owns keymap, gate/scroll state, and the mid-run message queue badge count (driven by `"mid-run.delivered"` emitter events from the runner). SHIFT+TAB enables auto mode, which auto-approves non-destructive consequential actions through the permission gate (`onToggleAuto`). Plan handling is a separate approval gate (`use-gates`), not a mode. `@file` mentions in chat input are resolved to file contents before the message is sent to the agent.

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
- **Block-level cache** — `buildLines` accepts an optional `Map<string, StyledLine[]>` cache. Completed blocks are served from cache; only the streaming tail is recomputed per render tick.

#### Input handling

Ink reads stdin, parses it into string events, and broadcasts every event to *all* mounted `useInput` handlers. That broadcast model means an escape sequence not consumed by one handler leaks into another — in particular, SGR mouse tracking sequences (emitted on every terminal click, e.g. `ESC[<0;39;38M`) would surface as literal `[<...` text in whichever input is focused.

Rather than filter per component, `stdin-filter.ts` (`createFilteredStdin`) wraps `process.stdin` and is passed to Ink's `render` via the `stdin` option. It proxies the stream, intercepting `read()` to strip all `ESC[<…M/m` sequences before Ink's parser sees them — so no component's `useInput` ever receives one. A sequence split across two `read()` calls is handled by holding back an incomplete trailing `ESC[<…` (the SGR private marker is unambiguous, so this never swallows a boundary-split Esc or arrow key) and prepending it to the next chunk. This depends on Ink 7 driving its input pipeline off `stdin.read()`; bytes Ink consumes via its transient Kitty-keyboard probe are `unshift`ed back and re-enter through `read()`, so they pass through the filter too.

Mouse-wheel events are the one class of mouse input the UI acts on. Since they can no longer arrive through `useInput`, the filter detects wheel buttons (64 = up, 65 = down) and re-emits them as `scrollUp`/`scrollDown` on a dedicated `EventEmitter`. `use-mouse-scroll` subscribes to that emitter (and still owns enabling/disabling SGR mouse mode on the terminal).

### Extension System (`src/extensions/skill-loader.ts`, `src/extensions/slash-registry.ts`)

Intercode supports an extension system that sources slash commands and context skills from external skill directories. The contract is compatible with the `marketplace.json` + `plugins/<name>/skills/<skill-name>/SKILL.md` layout used by Claude Code and Codex plugin ecosystems.

#### Discovery

Extension discovery runs at session start and produces a slash command registry injected into the system prompt.

**Primary path — manifest-driven:**

A `marketplace.json` (or `.claude-plugin/marketplace.json`) file at the root of a plugin directory declares the available plugins. The loader reads each plugin entry's `source` path and enumerates skills under `<source>/skills/<skill-name>/SKILL.md`.

Required manifest fields per plugin entry:

| Field | Type | Description |
|---|---|---|
| `name` | string | Plugin identifier, used for namespacing slash commands |
| `description` | string | Human-readable summary of the plugin |
| `source` | string | Relative path to the plugin directory |
| `version` | string | Semantic version |

**Fallback path — manifest-free scan:**

When no manifest is present, the loader scans three well-known local directories for `SKILL.md` files directly:

| Directory | Convention |
|---|---|
| `.agents/skills/<skill-name>/SKILL.md` | Shared across runtimes |
| `.claude/skills/<skill-name>/SKILL.md` | Claude Code workspace skills |
| `.codex/skills/<skill-name>/SKILL.md` | Codex workspace skills |

Skills discovered via fallback scan are treated as if they belong to an anonymous plugin with no namespace prefix. When two fallback-scanned skills share the same name, the discovery order is `.agents/skills/` > `.claude/skills/` > `.codex/skills/`, and later entries are silently skipped.

#### SKILL.md Frontmatter

Every skill file begins with a YAML frontmatter block:

| Field | Required | Description |
|---|---|---|
| `name` | yes | Skill identifier; becomes the slash command name (e.g. `name: style` → `/style`) |
| `description` | yes | One-line summary shown in the slash command registry and system prompt |
| `type` | no | `context` (default) or `workflow` — controls how the skill is expanded |
| `argument-hint` | no | Usage hint displayed alongside the command name |
| `disable-model-invocation` | no | When `true`, injects the skill body directly without triggering a new inference turn |

#### Skill Types

**`context` (default)**

The SKILL.md body is injected verbatim into the system prompt (or as a synthetic tool result) when the skill is invoked. Used for style guides, conventions, and any reference material the agent should internalize.

**`workflow`** *(not yet implemented — planned for a future iteration)*

The SKILL.md body describes a multi-step plan. When invoked, the workflow executor parses the steps and drives the agent through them sequentially, enforcing gates, dispatching sub-agents for parallel steps, and waiting on approval gates before continuing. Workflow skills are the mechanism behind commands like `/linear-issue-workflow`.

#### Slash Command Registry

At session start, all discovered skills are registered in a slash command map keyed by command name. The registry is injected into the system prompt so the agent knows which commands are available. When the agent invokes `/command-name [args]`, the director intercepts it, looks up the definition, and expands it.

For manifest-sourced plugins, commands are namespaced as `plugin:skill-name` (e.g. `gaas:style`) to avoid collisions. The short form `style` is also registered as an alias if no other skill uses that name.

For fallback-scanned skills, the command name is the bare skill name with no prefix.

> **Note:** This registry is agent-visible only — skills are injected into the system prompt and intercepted by the director. These commands are distinct from the TUI slash command registry (`src/tui/commands/`), which handles client-side dispatch for built-in TUI commands (`/help`, `/model`, etc.) and populates TUI autocomplete. Extension-sourced slash commands do not appear in the TUI autocomplete registry.

#### Compatibility Matrix

All skill files must begin with a YAML frontmatter block. Files without frontmatter are skipped during discovery.

| Source | Discovery method | Modification required |
|---|---|---|
| Manifest-based plugin directory | `marketplace.json` | Requires SKILL.md frontmatter |
| Claude Code workspace skills (`.claude/skills/`) | Fallback scan | Requires SKILL.md frontmatter |
| Codex workspace skills (`.codex/skills/`) | Fallback scan | Requires SKILL.md frontmatter |
| Shared workspace skills (`.agents/skills/`) | Fallback scan | Requires SKILL.md frontmatter |
| Custom plugin path (explicit config) | `marketplace.json` | Requires SKILL.md frontmatter |

#### Plugin Path Configuration

The set of directories searched for manifests is configurable via `.intercode/settings.json` under `pluginPaths`. Each entry is a path (absolute or relative to the repository root) that the loader checks for a manifest file. The three fallback scan directories (`.agents/`, `.claude/`, `.codex/`) are always included and cannot be disabled.

## Data Flow

```
CLI argv
  → src/config/index.ts (Config)
    → src/agent/run-agent.ts (headless) | src/tui/runner.tsx (TUI)
      → LoadState, LoadPricing, discover hooks
      → CreatePermissionGate
      → CreatePosixTools (plugin chain)
      → Create director (Coding | Chat)
      → CreateAgent (git-backed contextDir)
      → SaveState (running)
      → agent.send(task)
      → src/session/stream-consumer.ts → sink
          → turnCollector.observe → postTurn hooks
          → render (headless) | emit to React (TUI)
          → on tool.done: saveState, saveDirectorState
      → src/agent/critic.ts (RunCritique)
      → dispatch postRun summary
      → SaveState (done | failed) → Cleanup
```

## State Transitions

```
[running] → tool.done → save → ... → submit_output → critique → [done]
                                          ↓
                                    [failed] (stall, critique failure, or error)
```

## Design Decisions

### Event loop vs. chat interface

The reactor processes one event at a time and produces a deterministic next action; every `inference.done` must yield a decision. The director adds policy to detect and recover from model-level stalling.

### Plan as contract

The plan lives in durable director state, not just conversation history, so it survives context shifts and is enforceable.

### Constraint ownership at the tool layer

Safety and budget constraints (secrets, catastrophic commands, permission, re-read prevention, write verification) are enforced as tool-layer middleware, not as advisory prompt text — one layer owns each constraint and the agent cannot evade it by rewording.

### Resume via git-backed storage

`@intx/storage-isogit` persists conversation context to a git-backed store; combined with JSON director state, runs resume from any interrupted point.
