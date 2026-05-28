# interchange-code — Architecture

## System Overview

The system is an event-driven agent loop with a custom reactor director. The CLI parses arguments, creates an agent, sends a task, and consumes the event stream. A custom director enforces policy on top of the reactor's default behavior.

## Components

### CLI Entry (`src/index.ts`)

- Parses command-line arguments (`run`, `resume`, `--headless`, `--cwd`, `--max-turns`, `--force`, `--help`)
- Loads environment variables from `.env`
- Dispatches to either `runAgent` (headless) or `runTUI` (terminal UI)
- Handles resume flow by loading previous state and director state

### Config Resolution (`src/config.ts`)

- Reads required environment variables: `OPENAI_COMPATIBLE_API_KEY`, `OPENAI_COMPATIBLE_BASE_URL`, `OPENAI_COMPATIBLE_MODEL`, `OPENAI_COMPATIBLE_PROVIDER_NAME`
- Parses flags: `--cwd`, `--max-turns`, `--force`, `--headless`
- Collects positional arguments as the task description

### Agent Runner (`src/run-agent.ts`)

- Loads run state and checks for in-progress runs
- Creates sandboxed POSIX tools with plugins
- Builds the agent with `createAgent` from `@intx/agent`
- Adds custom tools: `submitPlan` and `submitOutput`
- Creates the custom `CodingDirector`
- Saves state on every `tool.done` event
- Runs critique after agent completion
- Handles cleanup (close agent, dispose tools)

### Event Stream Consumer (`src/stream-consumer.ts`)

- Consumes the async iterable from `agent.stream()`
- Calls a sink function for each event
- Handles stream errors

### Custom Director (`src/director.ts`)

The system uses two director modes depending on the execution context:

- **CodingDirector** — Used in headless mode. Extends `DefaultDirector` with strict stall detection, plan storage, and tool-call discipline.
- **ChatDirector** — Used in TUI mode. Instantiates `DefaultDirector` directly with no additional policy. Permissive, conversational, designed for interactive use.

**CodingDirector** adds:
- Idle cycle detection
- Read-without-write detection
- Plan storage (requires `submitPlan` before `submitOutput`)
- Max turns enforcement
- Submit validation

**ChatDirector** delegates all decisions to the base `DefaultDirector` with no custom hooks.

#### CodingDirector stall detection:

- **Idle cycle detection** — Counts consecutive turns without tool calls. After 3 idle cycles, aborts.
- **Read-without-write detection** — Counts consecutive reads. After 7 reads without a write, aborts.
- **Plan storage** — Requires `submitPlan` on turn 1. Stores the plan in director state. `submitOutput` is only accepted if `submitPlan` was called first.
- **Max turns enforcement** — Hard limit at `maxTurns` (default 30).
- **Submit validation** — `submitOutput` only accepted if `submitPlan` was called first.

#### Planned v2 enhancements:

- **Plan adherence** — Compare subsequent tool calls against the plan. Inject deviation warnings if the agent strays from planned steps.
- **Re-read blocking** — Track `filesRead: Set<string>` and block re-reading already-read files.
- **Search budget** — Cap `searchesPerformed` at 3 per run and block further searches.

Director state is persisted and loaded for resume:
- `turnsUsed`
- `submitCalled`
- `callIdToName` mapping
- `idleCycles`
- `consecutiveReads`
- `planSubmitted`
- `plan` steps

### System Prompt (`src/prompts.ts`)

- `buildSystemPrompt` — For the autonomous agent loop. Enforces tool-call discipline, submit rules, and budgets.
- `buildChatSystemPrompt` — For the TUI chat mode. More permissive, conversational.

### State Persistence (`src/state.ts`)

- `RunState` — High-level run status (`running` | `done` | `failed`), turns used, task, timestamps, error
- `DirectorPersistedState` — Director internal state for resume
- Atomic JSON save/load to `.agent-state/run.json` and `.agent-state/director.json`
- Validation functions ensure schema integrity on load

### Post-Submit Critique (`src/critic.ts`)

- Runs after the agent completes (before accepting)
- Checks `build`, `typecheck`, and `test` scripts if present in target `package.json`
- 5-minute timeout per command
- Only accepts the submission if all checks pass
- Failures are surfaced as errors

### Plugins

Plugins are applied as middleware over `createPosixTools` in a fixed chain:

```
tool call
  → pathEscapePlugin
    → authzPlugin
      → verifyPlugin
        → actual tool execution
```

**Rejection behavior:** Any plugin can short-circuit the chain by returning a `ToolResult` with `isError: true`. The error propagates directly to the agent as a tool error, bypassing downstream plugins and the actual tool execution.

#### Path Escape (`src/plugins/path-escape-plugin.ts`)

- Sanitizes path-like arguments in tool calls
- Resolves paths relative to `cwd`
- Blocks paths that escape the working directory (`..`)
- Covers arguments named `path`, `file_path`, `target`, `cwd`, `directory`, `dir`, `dest`, `source`, `from`, `to`, `filename`, and any key ending in `Path`
- **Position in chain:** First. Must run before authz so that paths are canonicalized before authorization checks.

#### Authorization (`src/plugins/authz-plugin.ts`)

- Blocks destructive shell commands via regex patterns
- Covers: `rm -rf`, redirects to system directories, `mkfs`, `dd`, `chmod`/`chown` on system paths, `sudo`, `eval`, `exec`, `shutdown`, `reboot`, fork bombs, `curl | bash`, etc.
- Returns a tool error: "Destructive command blocked by policy"
- **Position in chain:** Second. Runs after path escape so paths are resolved before authorization checks.

#### Verify (`src/plugins/verify-plugin.ts`)

- Re-reads files after `write_file` to verify content matches
- Re-reads files after `edit_file` to verify the replacement was applied correctly
- Returns a tool error on mismatch
- **Position in chain:** Third. Runs after the tool executes so it can inspect the actual result.

### Faremeter (`src/faremeter.ts`)

- Tracks token usage across turns
- Configurable input/output price per token
- Default: $0.000002 per input token, $0.00001 per output token
- Formats cost as `$X.XXXX`

### TUI (`src/tui/`)

- `runner.tsx` — Creates a chat-mode agent, wires event emitter, renders Ink app
- `app.tsx` — Root Ink component with layout: header, event log, chat input, status bar
- `use-stream.ts` — React hook that consumes `agent.stream()` events and accumulates them into typed content blocks
- `components/header.tsx` — Shows agent name, status, turns used, cost
- `components/event-log.tsx` — Scrollable colored log of events (filters out thinking/reply blocks)
- `components/chat-input.tsx` — Text input with submit handling
- `components/status-bar.tsx` — Shows exit and scroll hints

## Data Flow

```
CLI argv
  → Config
    → RunAgent
      → LoadState
      → CreatePosixTools (plugins)
      → CreateCodingDirector
      → CreateAgent
      → SaveState (running)
      → agent.send(task)
      → consumeStream(agent.stream(), traceEvent)
        → On tool.done: saveState, saveDirectorState
      → RunCritique
      → SaveState (done | failed)
      → Cleanup
```

## State Transitions

```
[running] → tool.done → save → ... → submitOutput → critique → [done]
                                          ↓
                                    [failed] (critique fails or error)
```

## Design Decisions

### Event loop vs. chat interface

The reactor processes one event at a time and produces a deterministic next action. The model cannot stall because every `inference.done` event must produce a decision. The director adds policy on top of this to detect and recover from model-level stalling.

### Plan as contract

The plan is stored in director state, not just conversation history. This makes it durable across context window shifts and enforceable by the director.

### Resume via git-backed storage

`@intx/storage-isogit` persists context to a git-backed store. Combined with JSON director state, this enables resuming from any interrupted point.
