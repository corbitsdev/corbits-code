# interchange-code — Product

## What It Is

A single-process coding agent CLI that autonomously implements features in a codebase. It reads files, writes code, runs tests, and submits work — all without human intervention during the loop. The agent is backed by the LLM (OpenAI-compatible) and built on Interchange primitives.

## Why It Exists

Existing coding agents (like other coding agents) stall. They get stuck in thinking loops, read files endlessly without writing, drift from their own plans, or forget to signal completion. The user watches a "Thinking..." spinner and hopes. This tool replaces the chat interface with a deterministic event loop that enforces progress.

## Target Users

- Developers who want to delegate discrete feature implementations to an agent
- Teams who need reproducible, autonomous coding tasks with verifiable output
- Users who want visibility into agent progress and cost, not a black box

## Key Value Propositions

1. **Deterministic progress** — Every turn must produce a tool call. No idle thinking.
2. **Plan as contract** — The agent declares a structured plan on turn 1 and the system enforces adherence.
3. **Stall detection** — The director detects idle cycles, read-only loops, and unbounded exploration, then intervenes.
4. **Resume capability** — Interrupted runs can be resumed from the last persisted state.
5. **Post-submit critique** — Build, type-check, and tests run before the result is accepted.
6. **Live cost tracking** — A faremeter shows token cost per turn in real time.
7. **TUI mode** — Visual terminal interface showing progress, events, and cost (not just stderr logs).
8. **Interactive pause** *(Planned for v2)* — The agent can call `askOperator` to pause execution and ask the user a clarifying question. If the user does not respond within 60 seconds, the agent auto-selects the default option and continues. Not yet implemented in the current release.

## User Experience

### Headless Mode

```bash
$ interchange-code "Add JWT auth to the API"
[tool-start] read_file
[tool] read_file ("src/middleware/auth.ts")
[tool-done] call-1
[tool-start] write_file
[tool] write_file ("src/lib/jwt.ts")
...
[done]
```

### TUI Mode

```bash
$ interchange-code --tui "Add JWT auth to the API"
```

Shows a live header with status, turns used, and cost; a scrollable event log; and a chat input for interactive tasks.

### Resume

```bash
$ interchange-code resume
```

Continues from the last saved state.

## Failure Modes and Recovery

### Stall (idle cycles)

**What the user sees:** The agent stops producing tool calls. After 3 idle turns, the run aborts with status `failed` and error `Agent stalled: no tool calls for 3 turns.`

**Recovery:** The run is saved in `failed` state. The user can inspect `.agent-state/run.json` for the turn count and error, adjust the task or prompt, and start a new run.

### Read-only loop

**What the user sees:** The agent reads files repeatedly without writing. After 7 consecutive reads without a write, the run aborts with status `failed` and error `Agent stalled: too many reads without writes.`

**Recovery:** Same as stall — inspect the state, consider a more specific task, and retry.

### Max turns reached

**What the user sees:** The agent uses all 30 turns (or the configured `--max-turns`) without calling `submitOutput`. The run ends with status `failed` and error `Max turns (30) reached.`

**Recovery:** Increase `--max-turns`, break the task into smaller sub-tasks, or provide more specific instructions.

### Critique failure

**What the user sees:** The agent calls `submitOutput` but the post-submit critique fails (build error, type error, or test failure). The run ends with status `failed` and the critique error message.

**Recovery:** The agent's state is preserved. The user can inspect the error, fix the underlying issue manually, or start a new run with a more specific task. The previous run's state is in `.agent-state/run.json`.

### Resume after interruption

**What the user sees:** `Ctrl+C` mid-run, network error, or process crash. The last state is persisted.

**Recovery:** `interchange-code resume` loads the last `RunState` and `DirectorPersistedState` and continues from the last persisted turn.

## Business Justification

- Raw feature throughput: the agent completes tasks without human babysitting
- Cost transparency: every turn's token usage is tracked and visible
- Safety: destructive commands are blocked, file writes are verified, path escapes are sandboxed
- Verifiable output: only builds that pass type-check and tests are accepted
