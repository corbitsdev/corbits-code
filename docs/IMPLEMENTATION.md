# interchange-code — Implementation

## Runtime

- **Bun 1.3.9+** — runtime and bundler
- **TypeScript 5.9.3** — strict mode, ES modules only
- **No classes** — functional programming throughout

## Dependencies

### Interchange Workspace

| Package | Version | Usage |
|---|---|---|
| `@intx/agent` | workspace | `createAgent`, `fromToolRunner`, `stringTool` — agent runtime |
| `@intx/inference` | workspace | `DefaultDirector`, `runInference`, SSE adapter, OpenAI provider |
| `@intx/tools-posix` | workspace | `createPosixTools`, `ToolPlugin` middleware — sandboxed shell/file tools |
| `@intx/types` | workspace | `ReactorDirector`, `ReactorState`, `ToolDefinition`, `ToolCall`, `ToolResult` |
| `@intx/storage-isogit` | workspace | `createIsogitStore` — git-backed context persistence |
| `@intx/inference-testing` | workspace | Test harness for deterministic agent loop tests |
| `@intx/inference-discovery` | workspace | Provider discovery |
| `@intx/mime` | workspace | MIME type utilities |
| `@intx/log` | workspace | Structured logging |
| `@intx/crypto-node` | workspace | Crypto primitives |

### External Dependencies

| Package | Version | Usage |
|---|---|---|
| `arktype` | ^2.1.29 | Runtime validation |

### Dev Dependencies

| Package | Version | Usage |
|---|---|---|
| `ink` | ^7.0.4 | Terminal UI framework |
| `react` | ^19.2.6 | TUI component model |
| `@types/react` | ^19.2.15 | React types |
| `ink-testing-library` | ^4.0.0 | TUI test utilities |
| `react-devtools-core` | ^7.0.1 | React devtools |
| `ws` | ^8.21.0 | WebSocket support |

## Developer Setup

New contributors must configure git hooks before their first commit:

```bash
git config core.hooksPath .githooks
```

To verify the full environment is correctly configured (git hooks, bun install, interchange submodule, and required env vars):

```bash
./bin/check-env
```

`check-env` sources `.env` if present before checking env vars, so it works with the standard `.env` workflow.

## File Structure

```
bin/
  check-env             Environment check script (git hooks, bun, submodule, env vars)
.githooks/
  pre-commit            Runs typecheck + build before every commit
src/
  index.ts              CLI entry, argv parsing, env loading, dispatch
  config.ts             Config resolution (env vars + flags)
  run-agent.ts          Headless agent runner with critique
  stream-consumer.ts    Async stream consumer with error handling
  director.ts           Custom CodingDirector extending DefaultDirector
  prompts.ts            System prompt builders (agent + chat)
  state.ts              RunState and DirectorPersistedState JSON save/load
  critic.ts             Post-submit critique (build, typecheck, test)
  faremeter.ts          Token usage → cost calculator
  plugins/
    authz-plugin.ts     Destructive command blocking
    path-escape-plugin.ts  Path sandboxing
    verify-plugin.ts    Write/edit verification
  tui/
    runner.tsx          TUI agent setup and Ink render
    app.tsx             Root layout component
    use-stream.ts       React hook for event stream consumption
    components/
      header.tsx        Status bar with turns/cost
      event-log.tsx     Colored scrollable event log
      chat-input.tsx    User text input
      status-bar.tsx    Exit/scroll hints
```

## Configuration

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `OPENAI_COMPATIBLE_API_KEY` | Yes | API key for inference provider |
| `OPENAI_COMPATIBLE_BASE_URL` | Yes | Provider base URL (e.g., `https://api.x.ai/v1`) |
| `OPENAI_COMPATIBLE_MODEL` | Yes | Model identifier (e.g., `default-model`) |
| `OPENAI_COMPATIBLE_PROVIDER_NAME` | Yes | Provider name (e.g., `xai`) |

### CLI Flags

| Flag | Default | Description |
|---|---|---|
| `--cwd <dir>` | `process.cwd()` | Working directory |
| `--max-turns <n>` | 30 | Maximum agent turns |
| `--headless, -h` | false | Run in headless CLI mode (default: TUI) |
| `--force` | false | Override existing run state |
| `--help` | — | Show help |

### Task Input

Positional arguments are joined into the task description. If `--headless` is set and no task is provided, the CLI exits with error.

## Protocols and Formats

### Inference

- OpenAI-compatible chat completions API
- SSE (Server-Sent Events) streaming via `@intx/inference`
- JSON schema tool definitions for `submitPlan` and `submitOutput`

### State Persistence

- JSON files with schema validation
- `.agent-state/run.json` — `RunState`
- `.agent-state/director.json` — `DirectorPersistedState`
- Atomic writes via `node:fs/promises`

### Event Stream

`agent.stream()` emits `ReactorEmittedEvent` objects:
- `inference.tool_call.start` — Tool call beginning
- `inference.tool_call.end` — Tool call with arguments
- `tool.start` — Tool execution beginning
- `tool.done` — Tool result (with `isError` flag)
- `inference.error` — Parse or inference error
- `reactor.error` — Fatal reactor error
- `reactor.done` — Agent loop completion
- `connector.reply` — Model reply content
- `inference.usage` — Token usage for faremeter

## Build and Validation

```bash
bun run build    # bun build ./src/index.ts --outdir ./dist --target bun
bun run typecheck  # tsc --noEmit
bun test         # bun test ./src ./e2e
```

## Deployment

- Single binary: `./dist/index.js`
- CLI name: `interchange-code`
- Self-contained: all runtime dependencies are workspace-linked or bundled
- No container or orchestration required

## Testing

### Unit Tests

Co-located with source (`src/`):
- `src/config.test.ts` — Config resolution
- `src/plugins/authz-plugin.test.ts` — Command blocking
- `src/plugins/path-escape-plugin.test.ts` — Path sandboxing
- `src/plugins/verify-plugin.test.ts` — Write verification

In `tests/unit/`:
- `tests/unit/faremeter.test.ts` — Cost calculation
- `tests/unit/index.test.ts` — CLI entry
- `tests/unit/run-agent.test.ts` — Agent runner
- `tests/unit/tui/app.test.tsx` — TUI root component
- `tests/unit/tui/chat-input.test.tsx` — Chat input
- `tests/unit/tui/event-log.test.tsx` — Event log
- `tests/unit/tui/header.test.tsx` — Header
- `tests/unit/tui/runner.test.ts` — TUI runner
- `tests/unit/tui/status-bar.test.tsx` — Status bar
- `tests/unit/tui/use-stream.test.ts` — Stream hook

### Integration Tests

- `@intx/inference-testing` harness
- Deterministic SSE responses
- Assert agent issues `read_file` → `write_file` → `run_shell` → `submitOutput`

### E2E Tests

- `e2e/agent-loop.test.ts` — Integration test using `@intx/inference-testing` harness
- Fixture repos with local HTTP mock
- Assert files written, tests pass, report generated

### Fixture Repos

- `tests/fixtures/flaky-baseline/` — Simple calculator for stress testing
- `tests/fixtures/large-read/` — Multi-file project for read-budget testing
- `tests/fixtures/multi-file-service/` — Service with routes, middleware, and tests

### TUI Tests

- `ink-testing-library` v4.x provides `render`, `waitFor`, and `cleanup` for Ink components
- Components are tested in isolation with mock event emitters
- `useAgentStream` hook tests verify content block accumulation and state transitions
- `event-log.tsx` tests verify filtering (thinking/reply blocks suppressed) and color mapping
- `chat-input.tsx` tests verify keyboard input handling (type, backspace, submit)
- `header.tsx` tests verify status color changes and cost formatting
- Async stream events are simulated via `EventEmitter` to test real-time updates

## TUI Details

- Ink 7.x with React 19
- Flex layout: header (fixed), event log (grow), chat input (fixed), status bar (fixed)
- Event filtering: thinking blocks and reply blocks are suppressed from the log
- Keyboard: `Ctrl+C` or `Escape` to exit, `Enter` to submit chat input, `Backspace`/`Delete` to edit
- Color coding: green (user), cyan (tool_call), yellow (tool_result), red (error)
