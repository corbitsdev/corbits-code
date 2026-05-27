# interchange-code — Plan

## Goal

Single coding agent CLI using the LLM (OpenAI-compatible). Must outperform other coding agents on raw feature implementation through better prompts + interchange primitives.

---

## Interchange Primitives Used

| Package | What we use |
|---|---|
| `@intx/agent` | `createAgent` — the in-process agent runtime (send/close/stream) |
| `@intx/inference` | `DefaultDirector`, `runInference`, OpenAI adapter (composable primitives underneath) |
| `@intx/tools-posix` | `createPosixTools`, plugin middleware for path escape |
| `@intx/types` | `ConversationTurn`, `ToolCall`, `ToolDefinition`, `ReactorState` |
| `@intx/storage-isogit` | `createIsogitStore` for context persistence / resume |
| `@intx/inference-testing` | Test harness for deterministic agent loop tests |

---

## Architecture

```
CLI (src/index.ts)
  → load config, load skills
  → createPosixTools({ cwd, plugins: [pathEscapePlugin] })
  → createAgent({
      contextDir,
      sources: [xaiSource],
      defaultSource: "xai",
      systemPrompt,
      tools: posixTools,
      director: createCodingDirector(policy),
    })
  → agent.send(task)
  → for await (event of agent.stream()) { handle }
  → agent.close()
```

---

## Why other coding agents Stalls (and how the reactor fixes it)

other coding agents stalls because it is an **interactive chat interface** masquerading as a coding agent. The model has infinite degrees of freedom: it can think, explain, ask clarifying questions, read files, or do nothing — and the UI just waits. There is no deterministic loop contract forcing progress. The user watches the "Thinking..." spinner and hopes.

Interchange fixes this by replacing the chat model with an **event-driven reactor**. The reactor processes one event at a time, asks the director for the next action, validates it, and executes. There is no "Thinking..." state where the model can stall. Every `inference.done` event MUST produce a decision: infer again, execute tools, reply, or wait. Our custom director adds policy on top of this to detect and recover from model-level stalling.

---

### 1. Thinking Loop

**What the user sees:** The terminal shows "Thinking for 9.2s..." and then the model emits a long paragraph explaining the problem, the history of the codebase, and what it *might* do next. No tool calls. The user waits. This repeats. Time burns.

**Root cause:** other coding agents's prompt does not enforce tool-call discipline. The model is allowed to emit conversational text. The UI displays this text as "thinking" and waits for the model to spontaneously decide to act. There is no external pressure.

**Our fix:**
- The system prompt states: "Every turn must produce at least one tool_call. Conversational text without tool_calls is not progress."
- The custom director's `afterInference` hook inspects every assistant turn from `agent.stream()`. If the turn has no `tool_calls`, we increment an `idleCycles` counter in director state.
- At `idleCycles === 1`, the director injects a `system` turn: "You have emitted no tool calls. Read a file or run a test."
- At `idleCycles === 2`, we inject: "This is your second idle cycle. If you do not act now, the task will be marked failed."
- At `idleCycles === 3`, the director returns `done` with a failure reason. The agent loop terminates.

---

### 2. Read-Only Loop

**What the user sees:** The agent reads `src/middleware/auth.ts`, then `src/lib/jwt.ts`, then `src/routes/login.ts`, then `src/types/user.ts`, then `package.json`... 15 files later, nothing has been written. The user sees a scrolling list of `[agent] read_file(...)` and no `[agent] write_file(...)`.

**Root cause:** The model is optimizing for understanding over action. It wants complete certainty before writing. In a chat interface, there is no cost to reading another file. The model does not know it is burning turns.

**Our fix:**
- The director tracks a `lastWriteTimestamp` (turn number of the most recent `write_file` or `edit_file`).
- It also tracks a `consecutiveReads` counter that increments on every `read_file` / `list_dir` / `search_code` without an intervening write.
- At `consecutiveReads === 5`, the director injects a system turn: "You have read 5 files without writing. You have sufficient information. Pick the most important file and write the fix now. Do not read more files."
- At `consecutiveReads === 7`, the director blocks `read_file` tool calls by returning a tool result error: "Read blocked: too many reads without writes. Write a file or submit."

---

### 3. Plan Without Execution

**What the user sees:** Turn 1, the agent emits a beautiful plan: "1. Update auth middleware. 2. Add JWT helper. 3. Write tests. 4. Run lint." Then turn 2, it reads a file. Turn 3, it reads another file. The plan is never referenced again. The agent drifts.

**Root cause:** The model has no memory of its own plan as a binding contract. The plan is just text in the conversation history. After a few turns, the context window pushes it out, or the model simply forgets.

**Our fix:**
- The system prompt requires the first assistant turn to call a `submitPlan` tool with a structured JSON plan: `{ steps: [{ file, action, reason }] }`.
- The director extracts this plan and stores it in `director.state.plan` — a persistent data structure, not just conversation text.
- On every subsequent turn, the director compares the tool calls issued against the plan. If the agent deviates (e.g., plan says "write src/auth.ts" but agent reads `README.md`), the director injects: "Deviation detected. Your plan says to write src/auth.ts. You are reading README.md. Follow your plan or call askOperator to request a change."
- If the agent completes all plan steps and calls `submitOutput`, the director accepts. If the agent submits without completing all steps, the director rejects the submission: "You have not completed your plan. Remaining steps: ..."

---

### 4. Tool Call Amnesia

**What the user sees:** The agent calls `read_file src/config.ts`. The result is shown. The agent's next turn: "Let me check the config file." It calls `read_file src/config.ts` again. Or worse: it asks a question that was already answered by the previous tool result.

**Root cause:** In chat interfaces, the model's context is a linear text buffer. Tool results are formatted as markdown or special tokens. The model can lose track of which results correspond to which calls, especially when multiple tools run in parallel.

**Our fix:**
- `@intx/agent` appends tool results to conversation history as formal `tool_result` turns with `callId` references. The model sees structured results, not inline markdown.
- The director maintains a `toolResultsByCallId` map in its state. On every `tool.done` event from `agent.stream()`, it verifies the `callId` matches a pending `tool_call`.
- If the model re-reads a file it already read, the director injects a note: "You already read this file at turn 4. The result was: ..."
- The system prompt says: "The system automatically shows you tool results. You do not need to restate them. Use them to decide your next action."

---

### 5. Unbounded Exploration

**What the user sees:** The agent searches for "auth", finds 40 matches, reads 12 files, searches for "token", finds 30 matches, reads 8 more files, searches for "session", reads 5 more files. The codebase is now fully loaded into context. The agent is overwhelmed and starts making incorrect changes based on outdated code paths.

**Root cause:** No exploration budget. The model treats the codebase as an infinite knowledge graph it can traverse. There is no penalty for over-exploration.

**Our fix:**
- Director tracks `filesRead: Set<string>` and `searchesPerformed: number`.
- Re-reading a file already in `filesRead` is blocked at the tool layer: "File already read at turn N. Use that result."
- `searchesPerformed` is capped at 3 per run. After 3 searches, the director blocks `search_code` / `grep` with: "Search budget exhausted. Use files you have already discovered."
- The system prompt says: "You have a budget of 3 searches and 10 file reads. Use them wisely. Read the most relevant files first."

---

### 6. Missing Submit

**What the user sees:** The agent writes the code, runs the tests, tests pass. Then... nothing. The terminal shows the last test output and hangs. The user waits. The agent never calls the equivalent of "done". The conversation is in limbo.

**Root cause:** other coding agents does not have a terminal tool. The model does not know what "done" looks like. It emits a conversational message like "The task is complete!" and the UI has no way to know this is the terminal state. The user has to manually type "done" or "exit" or click a button.

**Our fix:**
- `submitOutput` is a real tool in the tool surface. The system prompt says: "You MUST call submitOutput when the task is fully complete. No other action signals completion."
- The director's `afterInference` hook checks: if the agent has written files, run tests, and tests pass, but has not called `submitOutput` for 2 consecutive turns, inject: "Your tests pass. Call submitOutput to complete the task."
- If the agent has not called `submitOutput` after `maxTurns - 5`, inject: "You are running out of turns. Call submitOutput now or the task will fail."
- The director itself never treats a conversational message as completion. Only `submitOutput` terminates the loop.

---

### Additional Edge Cases

| Edge case | Mitigation |
|---|---|
| **Malformed tool JSON** | OpenAI adapter parses partial JSON. On parse failure, emits `inference.error`. Reactor retries with error context. Director injects: "Your last tool call had invalid JSON. Ensure arguments match the schema." |
| **Truncated file writes** | `verify-plugin.ts` re-reads the file after `write_file`, compares content length and SHA. If mismatch → returns tool error: "Write truncated. Retry with complete content." |
| **Destructive shell commands** | `authz-plugin.ts` intercepts `run_shell`. Blocks commands matching `/rm\s+-rf\s+\//`, `/>\s*\/etc\/`, `/dd\s+if=/`. Returns error: "Destructive command blocked." |
| **Context window overflow** | Reactor's `size-cap` transform spills oversized tool results to blob storage. Director tracks `contextChars`. At 80% of model limit, injects `compact` action with summary of old turns. |
| **Resume mid-tool execution** | Isogit store persists every `checkpoint` commit. On resume, load turns from store. Reconstruct `filesRead`, `searchesPerformed`, `plan` from persisted director state in `.agent-state/director.json`. |
| **Pre-existing test failures** | Baseline captured in turn 2 via `run_shell({ command: "bun test" })`. If tests fail before changes, store `preExistingFailures` in director state. On critique, diff failures against baseline. Only NEW failures block submit. |
| **askOperator timeout** | If `askOperator` is called and no operator response within 60s, director auto-selects option 0 (default) and continues. State transitions from `escalated` back to `running`. |
| **Agent writes code that compiles but is semantically wrong** | Critic prompt requires semantic review, not just syntax. "Does this change actually implement the requested feature? Check logic, not just formatting." |
| **Agent ignores linter errors** | Baseline lint run in turn 2. If agent submits and linter fails, director rejects submission: "Lint fails. Run linter, fix errors, then submit." |

---

## Directory Structure

```
interchange-code/
  package.json
  tsconfig.json
  src/
    index.ts              CLI entry
    config.ts             Config resolution (env + yaml + flags)
    director.ts           Custom ReactorDirector with stall detection
    prompts.ts            System prompt + critic prompt
    skills.ts             AGENTS.md / CONVENTIONS.md loader
    path-escape-plugin.ts PosixTools plugin for sandboxing
    authz-plugin.ts       PosixTools plugin for destructive command blocking
    verify-plugin.ts      PosixTools plugin for write verification
    state.ts              Our RunState save/load (JSON, atomic)
    critic.ts             Post-submit critique + amendment loop
    faremeter.ts          Token usage → cost calculator
  tests/
    unit/                 Config, plugins, prompts, faremeter
    integration/          Agent loop with @intx/inference-testing harness
    fixtures/             Sample repos for e2e
```

---

## Core Composition

```typescript
// src/index.ts — main run
const config = loadConfig();
const skills = await loadSkills(targetDir);

const posixTools = createPosixTools({
  cwd: targetDir,
  plugins: [
    pathEscapePlugin(targetDir),
    authzPlugin(),
    verifyPlugin(),
  ],
});

const agent = await createAgent({
  contextDir: path.join(targetDir, ".agent-state", "context"),
  sources: [{
    id: "xai",
    provider: "openai",
    baseURL: config.baseURL,
    apiKey: config.apiKey,
    model: config.model,
  }],
  defaultSource: "xai",
  systemPrompt: buildSystemPrompt({ skills, config }),
  tools: fromToolRunner(posixTools),
  director: createCodingDirector({
    maxTurns: config.maxTurns,
    afterInference: stallDetectionHook,
  }),
});

// Send task and get final reply
const result = await agent.send(task);

// Stream events for live trace / TUI
for await (const event of agent.stream()) {
  if (event.type === "inference.tool_call.end") {
    console.log(`[tool] ${event.data.call.name}`);
  }
  if (event.type === "tool.done") {
    await saveState(targetDir, updateRunState(event));
  }
}

await agent.close();
await posixTools.dispose();
```

---

## Prompt Engineering

The system prompt must be designed for the **agent's event loop**, not a chat interface.

Key differences from generic prompts:
1. **The agent knows the loop** — "You are operating inside an event-driven loop. After each action, the system automatically shows you results and asks for your next move. Do not explain what you will do before doing it. Just call the tool."
2. **Progress is mandatory** — "Every turn must either read a new file, write a file, run a test, or call submitOutput. You may not emit a conversational message without a tool call."
3. **Submit is sacred** — "Calling submitOutput means you are 100% confident the task is complete. If tests are failing, you MUST NOT submit."
4. **Plan is a contract** — "Your first turn must produce a plan. The plan lists every file you will touch. You may not deviate without calling askOperator."

---

## Test Suite

**Unit tests:**
- `config.test.ts` — resolution order
- `path-escape-plugin.test.ts` — `..`, symlinks, absolute paths
- `authz-plugin.test.ts` — `rm -rf /` blocked, `bun test` allowed
- `verify-plugin.test.ts` — truncated write detected
- `faremeter.test.ts` — cost calculation with known token counts
- `prompts.test.ts` — prompt contains all required sections

**Integration tests** (using `@intx/inference-testing`):
- Register expected SSE responses with `harness.scenario.replyOnce`
- Assert agent issues `read_file` → `write_file` → `run_shell` → `submitOutput` in order
- Assert state transitions: `running` → `critiquing` → `done`
- Assert faremeter accumulates correctly across turns

**E2E tests:**
- Run against fixture repo with local HTTP mock
- Assert files written, tests pass, report generated

---

## Implementation

### Phase 1 — Infrastructure
- [ ] Add workspace deps: `@intx/inference`, `@intx/tools-posix`, `@intx/types`, `@intx/storage-isogit`, `@intx/inference-testing`
- [ ] `config.ts` + `skills.ts`
- [ ] `path-escape-plugin.ts`, `authz-plugin.ts`, `verify-plugin.ts`
- [ ] `prompts.ts` — v1 system prompt
- [ ] `index.ts` — basic `run` verb

### Phase 2 — Agent + Director
- [ ] `director.ts` — custom `ReactorDirector` extending `DefaultDirector` with stall detection
- [ ] Wire `createAgent` in `index.ts`
- [ ] `agent.stream()` handler for stderr trace + state tracking
- [ ] Manual test against simple task

### Phase 3 — Critique + State
- [ ] `critic.ts` + critic prompt
- [ ] `state.ts` — RunState save/load
- [ ] `resume` verb
- [ ] Amendment loop (max 3 rounds)

### Phase 4 — Tests + Polish
- [ ] Unit tests for all plugins
- [ ] Integration tests with `@intx/inference-testing`
- [ ] E2E test with fixture
- [ ] `bun run typecheck`, `bun run build`, `bun test` — all green
- [ ] Faremeter + cost tracking
- [ ] Final report generation

### Phase 5 — TUI (v1.5, immediately after core loop works)
- [ ] Add `ink` + `react` + `@types/react` to devDependencies
- [ ] `src/tui/app.tsx` — root Ink component with layout shell
- [ ] `src/tui/hooks/use-agent-stream.ts` — bridge `agent.stream()` events to React state
- [ ] `src/tui/components/header.tsx` — status badge, progress %, live faremeter
- [ ] `src/tui/components/event-log.tsx` — scrollable colored log of all agent events
- [ ] `src/tui/components/operator-modal.tsx` — blocks on `askOperator`, keyboard-driven Continue/Abort
- [ ] Keyboard navigation: arrow keys scroll log, `q` exits, `Tab` switches focus
- [ ] `bun run tui` launches Ink app; abort with `Ctrl+C` leaves state intact
- [ ] Side-by-side demo script: run against same fixture task, compare to other coding agents output

---

## Side-by-Side Demo Strategy

The TUI is not polish — it's the proof. other coding agents *is* a TUI. If we demo with plain stderr text, we look like a downgrade.

The TUI must make three things visible that other coding agents hides:

1. **The plan is a contract** — show the plan DAG in a top panel. other coding agents's plan is prose that disappears after the first turn.
2. **Progress is mandatory** — show every tool call as a colored row with timestamp. If the agent stalls, the log stops scrolling. Obvious.
3. **Cost is real** — show the faremeter ticking up per turn. other coding agents burns tokens silently.

Demo flow:
```
$ interchange-code --tui "Add JWT auth to the API"
[header] interchange-code | running | $0.0034 | 12 turns
[event log]
  [12:34:01] read_file src/middleware/auth.ts
  [12:34:02] write_file src/lib/jwt.ts (234 lines)
  [12:34:03] run_shell bun test (passed)
  [12:34:04] submitOutput ✅
[faremeter] $0.0034 total
```

Contrast with other coding agents: "Thinking for 9.2s..." → scroll of prose → user hopes something happened.

---

## Verification

1. `bun install` resolves workspace deps
2. `bun run typecheck` zero errors
3. `bun run build` zero errors
4. `bun test` all green
5. Manual: run against fixture, agent completes task, submits, critique passes
6. Manual: `Ctrl+C` mid-run, `resume` continues from last persisted turn

---

## Design Decisions

### createAgent vs createReactorAssembly (direct)

**Initially considered:** Using `createReactorAssembly` directly, as `interchange-demo-dispatch` does, for maximum control over the reactor event loop.

**Decision:** Use `createAgent` from `@intx/agent`.

**Rationale:**
- `createAgent` is explicitly designed for "a CLI, a worker, a test, an embedded assistant" per the package README. That matches our use case exactly.
- It handles send queuing, stream backpressure, storage locking, and graceful shutdown — all things we'd have to rebuild manually with `createReactorAssembly`.
- The director policy hooks (`afterInference`) give us the same stall-detection control without managing the raw reactor event queue.
- Speed to PoC: ~1-2 days with `createAgent` vs ~3-4 days with raw reactor.

**Tradeoff accepted:** We lose some visibility into the raw event queue, but `agent.stream()` exposes every `inference.*` and `tool.*` event we need for tracing and state tracking.

### Standalone vs workspace dependencies

**Initially considered:** Building standalone with direct fetch calls, avoiding the `../interchange` workspace dependency mess.

**Decision:** Use interchange workspace packages.

**Rationale:**
- The inference harness (`runInference`) with SSE parsing, retry logic, and provider adapters is ~800 lines of battle-tested code. Rebuilding it is waste.
- `createPosixTools` with plugin middleware gives us path escape, authz, and verify as composable plugins — clean architecture.
- `createIsogitStore` gives us git-backed context persistence + resume for free.
- `@intx/inference-testing` is purpose-built for deterministic agent tests.

**Tradeoff accepted:** The project must live in a directory where workspace resolution works (e.g., as a workspace in the interchange monorepo, or with correct relative paths).

### TUI timing: v1.5, not v2

**Initially considered:** No TUI for PoC v1. CLI only with stderr trace.

**Decision:** TUI immediately after core loop works (Phase 5, v1.5).

**Rationale:**
- other coding agents *is* a TUI. A side-by-side demo without visual contrast is invisible.
- The TUI makes the value proposition visceral: structured plan vs. prose wall, mandatory progress vs. "Thinking...", live cost vs. silent burn.
- `agent.stream()` already emits every event needed. Ink is just a renderer on top.
- Effort is medium (~2-3 days) because the event feed is free.

**Tradeoff accepted:** Adds React + Ink dependency. Core loop must be stable before TUI work starts.

### Plan-approval mode vs autonomous execution

**Initially considered:** Adding a plan-approval step where the user reviews the agent's plan before execution.

**Decision:** Skip for PoC v1. Autonomous execution with `submitOutput` as the only terminal.

**Rationale:**
- Plan approval is a UX feature, not an agent capability feature.
- The prompt enforces structured planning in turn 1; the director tracks plan adherence.
- Adding approval gates requires interactive state management (pause, display, wait for input) that complicates the PoC.

**Tradeoff accepted:** The agent may deviate from an optimal plan. The director's deviation detection + correction mitigates this.
