# interchange-code — Architecture

## System Overview

The system is an event-driven agent loop with a custom reactor director. The CLI parses arguments, builds a `Config`, creates an agent with sandboxed tools and a policy director, sends a task, and consumes the event stream. A custom director enforces policy on top of the reactor's default behavior. Two front ends consume the same loop: a headless renderer (stderr) and an Ink-based TUI.

## Components

### CLI Entry (`src/index.ts`)

- Parses verbs (`run` (optional), `resume`) and `--help`
- Auto-loads `.env` from the project root before dispatch (does not overwrite already-set env vars)
- Dispatches to `runAgent` (headless) or `runTUI` (default)
- Handles resume by loading previous `RunState` + `DirectorPersistedState` and re-running with the prior task

### Config Resolution (`src/config.ts`, `src/settings.ts`)

- Resolves the inference provider from layered sources into `{ apiKey, baseURL, model, providerName }` — the struct the runtime consumes. Per field, highest wins: CLI flags (`--provider`/`--model`) > `OPENAI_COMPATIBLE_*` env > per-repo `.interchange/settings.json` (selection only) > global `~/.interchange/settings.json`.
- `--config <path>` replaces the global settings file as the provider source (the eval harness's per-run injection seam). With no settings file, credentials come entirely from env, preserving the original `.env` workflow.
- `settings.ts` owns the schema, validators (the per-repo file rejects credentials), file loaders, and the pure `resolveProvider` precedence function.
- `loadConfig` is async (it reads settings files). Parses flags `--cwd`, `--config`, `--provider`, `--model`, `--force`, `--headless`/`-h`, `--dangerously-skip-permissions`; collects positional arguments as the task description.
- Both settings files are on the secret-guard denylist, so the agent cannot read its own credentials.

### Agent Runner (`src/run-agent.ts`)

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

### Event Stream Consumer (`src/stream-consumer.ts`)

- Consumes the async iterable from `agent.stream()`, invoking a sink per event, with stream error handling

### Custom Directors (`src/director.ts`)

Two directors, selected by front end:

- **CodingDirector** (headless) — Extends `DefaultDirector` with stall detection and plan enforcement.
- **ChatDirector** (TUI) — `DefaultDirector` plus the plan-approval gate: when a plan is submitted it pauses for approve/reject before continuing. There is a single, opinionated mode — no Manager/Teammate toggle. (`createChatDirector` retains a no-gate fallback to `DefaultDirector` as an implementation detail, but the product runs one mode with the gate present.)

**CodingDirector** behavior:
- **Idle cycle detection** — Counts consecutive turns without tool calls; after 3, checkpoints and aborts.
- **Plan storage** — Captures `submit_plan` arguments into durable director state.
- **Submit gating** — `submit_output` is rejected by its tool handler unless a plan was submitted; if a multi-turn task completes with no plan, the director appends a warning.
- **Read tracking** — Records the turn at which each file was read (`filesReadAtTurn`), which the re-read-block plugin consults to prevent redundant re-reads.

Director state persisted for resume: `turnsUsed`, `submitCalled`, `callIdToName`, `idleCycles`, `planSubmitted`, `plan` steps, and `filesRead` (path → turn).

### Director-Layer Tools (`src/director.ts`)

- `submit_plan` — Ordered steps of `{ file, action, reason }`; declared on turn 1.
- `ask_operator` — Pauses for a clarifying question with a list of options.
- `submit_output` — The only clean termination signal; requires a prior plan.

### System Prompt (`src/prompts.ts`)

The agent's identity is **Intercode**, framed as a senior teammate who owns the outcome (not an assistant). The prompt is composed from small, individually-exported sections so they can be tested and reused.

- `buildSystemPrompt` — Autonomous loop: identity + quality bar, tool-call discipline, completion rules, encoded code standards (the core `style`/`philosophy` rules — scope discipline, match surrounding code, delete superseded code, comment the why, validate at boundaries), efficiency/tool-layer limits, self-verification, authorization/escalation, plan contract, a risk-and-reversibility plan-decision rubric (not file counts), and a few-shot "locate → understand → change → verify → submit" sequence.
- `buildChatSystemPrompt` — TUI chat: same Intercode identity and code standards, conversational, without the submit/plan-required loop mechanics.

> The prompt rewrite (CL-1220) is in place; the "measured improvement vs the prior prompt" acceptance remains to be validated by running the eval harness (CL-1219) against a real provider.

### State Persistence (`src/state.ts`)

- `RunState` — `running` | `done` | `failed`, turns used, task, timestamps, error
- `DirectorPersistedState` — director internals for resume
- Atomic JSON save/load to `.agent-state/run.json` and `.agent-state/director.json`, with schema validation on load
- Conversation context is persisted separately by the git-backed store under `.agent-state/context`

### Post-Submit Critique (`src/critic.ts`)

- Runs after the agent completes, before acceptance
- Runs `build`, `typecheck`, and `test` scripts when present in the target `package.json`
- 5-minute timeout per command; accepts only if all pass; surfaces failures as errors

### Lifecycle Hooks (`src/hooks.ts`)

- Discovers `postTurn` / `postRun` hooks (TypeScript or shell) from `.interchange/hooks` (local) and `~/.interchange/hooks` (global)
- `TurnContext` aggregates per-turn data (assistant turn, tool calls/results, token usage, source, duration); a turn-context collector builds it from the event stream
- `RunSummary` aggregates the whole run for `postRun`
- The manager exposes enable/disable and emits `hooks.loaded` / `hook.updated` events for the TUI hook panel
- See `docs/HOOKS.md`

### Pricing (`src/pricing-fetcher.ts`, `src/faremeter.ts`)

- `pricing-fetcher` loads model pricing from models.dev, caches it, and refreshes in the background
- `faremeter` converts `inference.usage` token counts into a formatted cost using that pricing

### Renderer (`src/renderer.ts`)

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
- **Secret Guard** (`secret-guard-plugin.ts`) — Hard-denies tool calls that would expose a sensitive file: path-keyed arguments (`read_file`, `write_file`, …) and `run_shell` command strings, which are tokenized so `cat .env` or `cat ~/.interchange/settings.json` are blocked the same as a direct read. Runs before the permission plugin, so the deny holds even under `--dangerously-skip-permissions`. Shell containment is best-effort: token matching defeats quoting and env-assignment/redirection forms but not dynamic path construction (variable indirection, `printf` assembly).
- **Authorization** (`authz-plugin.ts`) — Denies catastrophic shell command patterns by regex.
- **Permission** (`permission-plugin.ts`) — Delegates consequential calls to the permission gate.
- **Verify** (`verify-plugin.ts`) — Re-reads after `write_file` / `edit_file` and errors on mismatch.
- **Re-read Block** (`re-read-block-plugin.ts`) — Consults the director's read tracking to block re-reading an already-read file.

### Permission System (`src/permission/`)

- **classify** — Read-only tools (`read_file`, `search_files`, `grep`, `list_dir`) are tier `allow`; everything else is tier `ask`. Builds discrete approval requests: chained shell commands split into one request per segment; file tools keyed on the target path; other tools keyed on tool name.
- **command** — Splits chained commands and derives command-shape approval scopes.
- **gate** — Evaluates a call: `skipPermissions` allows everything; `allow`-tier passes; for `ask`-tier, checks persisted approvals, otherwise requests operator approval. In a non-interactive run an unresolved `ask` becomes a denial. Newly granted scopes are appended in memory and persisted.
- **matcher** — Glob matching of an approval pattern against a request subject.
- **store** — Loads/persists approvals scoped to the working directory.
- **types** — `Approval`, `ApprovalScope`, `PermissionRequest`, `ApprovalOutcome`.

Approval scopes offered: Allow Once (persist nothing), Allow Always for a file or its directory (file tools), or a command shape (shell). There is intentionally no "all files" rung.

### TUI (`src/tui/`)

Ink 7 + React 19, full-screen via the alternate-screen buffer.

- `app.tsx` — Root layout: pinned header, scrollable event log, context panel (diff/plan), chat input, status bar, and overlay modals. Owns keymap and gate/scroll/diff state.
- `use-stream.ts` — Consumes `agent.stream()` events into typed content blocks and tracks turns/status/cost.
- Hooks: `use-diff`, `use-gates` (permission/plan/operator gates), `use-keymap`, `use-scroll`, `use-spinner`, `use-terminal-size`.
- Components: `header`, `event-log`, `chat-input`, `status-bar`, `plan-view`, `diff-view`, `context-panel`, `operator-modal`, `permission-modal`, `approval-modal`, `agent-modal`, `exit-confirm`, `help-overlay`, `hook-panel`, `in-flight-indicator`.
- Support: `git-diff.ts` (working-tree diff), `tool-formatter.ts` (human-readable tool args/results), `markdown-parser.ts`, `keymap-table.ts`, `theme.ts`.
- Slash commands: `commands/registry.ts` (extensible registry) + `commands/built-in.ts` (`/help`, `/diff`, `/plan`, `/verbose`, `/agent`; `/model` aliases `/agent`).
- `/agent` configuration surface (`components/agent-modal.tsx`): a full-screen, section-based modal. The Provider/Model section reuses the CL-927 catalog (from `config.providers`) and applies a switch live via `agent.setSource()` — the runtime's in-place source mutation, read at the next inference call, so no agent recreation. "Set as default" persists the selection (selection-only, no credentials) to the per-repo `.interchange/settings.json` via `saveLocalSettings`. The section model leaves room for system-prompt/profile sections without new slash commands, and for the CL-1224 add-provider/onboarding step.

### Plugin System (`src/plugins/skill-loader.ts`, `src/plugins/slash-registry.ts`)

interchange-code supports a plugin system that sources slash commands and context skills from external plugin directories. The contract is compatible with the `marketplace.json` + `plugins/<name>/skills/<skill-name>/SKILL.md` layout used by Claude Code and Codex plugin ecosystems, so existing plugins work without modification.

#### Discovery

Plugin discovery runs at session start and produces a slash command registry injected into the system prompt.

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

Skills discovered via fallback scan are treated as if they belong to an anonymous plugin with no namespace prefix.

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

**`workflow`**

The SKILL.md body describes a multi-step plan. When invoked, the workflow executor parses the steps and drives the agent through them sequentially, enforcing gates, dispatching sub-agents for parallel steps, and waiting on approval gates before continuing. Workflow skills are the mechanism behind commands like `/linear-issue-workflow`.

#### Slash Command Registry

At session start, all discovered skills are registered in a slash command map keyed by command name. The registry is injected into the system prompt so the agent knows which commands are available. When the agent invokes `/command-name [args]`, the director intercepts it, looks up the definition, and expands it.

For manifest-sourced plugins, commands are namespaced as `plugin:skill-name` (e.g. `gaas:style`) to avoid collisions. The short form `style` is also registered as an alias if no other skill uses that name.

For fallback-scanned skills, the command name is the bare skill name with no prefix.

#### Compatibility Matrix

| Source | Discovery method | Modification required |
|---|---|---|
| Manifest-based plugin directory | `marketplace.json` | None |
| Claude Code workspace skills (`.claude/skills/`) | Fallback scan | None |
| Codex workspace skills (`.codex/skills/`) | Fallback scan | None |
| Shared workspace skills (`.agents/skills/`) | Fallback scan | None |
| Custom plugin path (explicit config) | `marketplace.json` | None |

#### Plugin Path Configuration

The set of directories searched for manifests is configurable via `.interchange/settings.json` under `pluginPaths`. Each entry is a path (absolute or relative to the repository root) that the loader checks for a manifest file. The three fallback scan directories (`.agents/`, `.claude/`, `.codex/`) are always included and cannot be disabled.

## Data Flow

```
CLI argv
  → Config
    → RunAgent / RunTUI
      → LoadState, LoadPricing, discover hooks
      → CreatePermissionGate
      → CreatePosixTools (plugin chain)
      → Create director (Coding | Chat)
      → CreateAgent (git-backed contextDir)
      → SaveState (running)
      → agent.send(task)
      → consumeStream(agent.stream(), sink)
          → turnCollector.observe → postTurn hooks
          → render (headless) | emit to React (TUI)
          → on tool.done: saveState, saveDirectorState
      → RunCritique
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
