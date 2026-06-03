# interchange-code — Implementation

Package version: **0.2.1**. CLI binary: `interchange-code` (`./dist/index.js`).

## Runtime

- **Bun** — runtime and bundler (`@types/bun` 1.3.9)
- **TypeScript 5.9.3** — strict mode, ES modules only
- **No classes** for application logic — functional programming throughout (the two directors subclass `DefaultDirector` from the runtime, the one deliberate exception)

## Dependencies

### Direct (production)

| Package | Version | Usage |
|---|---|---|
| `@intx/agent` | workspace | `createAgent`, `fromToolRunner`, `stringTool` — agent runtime |
| `@intx/inference` | workspace | `DefaultDirector`, inference runner, OpenAI-compatible provider, event types |
| `@intx/tools-posix` | workspace | `createPosixTools`, `ToolPlugin` middleware — sandboxed shell/file tools |
| `@intx/types` | workspace | Runtime types (`ReactorDirector`, `ReactorState`, `ToolDefinition`, `ToolCall`, `ToolResult`, …) |
| `@intx/storage-isogit` | workspace | Git-backed context persistence |
| `arktype` | catalog ^2.1.29 | Runtime validation |

Other Interchange workspace packages (`@intx/inference-discovery`, `@intx/mime`, `@intx/log`, `@intx/crypto-node`) are pulled transitively via the above.

### Dev

| Package | Version | Usage |
|---|---|---|
| `@intx/inference-testing` | workspace | Deterministic agent-loop test harness |
| `@types/bun` | 1.3.9 | Bun types |
| `ink` | ^7.0.4 | Terminal UI framework |
| `react` | ^19.2.6 | TUI component model |
| `@types/react` | ^19.2.15 | React types |
| `ink-testing-library` | ^4.0.0 | TUI test utilities |
| `react-devtools-core` | ^7.0.1 | React devtools |
| `ws` | ^8.21.0 | WebSocket support |
| `typescript` | 5.9.3 | Type checking |

## Developer Setup

Configure git hooks before the first commit:

```bash
git config core.hooksPath .githooks
```

Verify the environment (git hooks, bun install, interchange submodule, required env vars):

```bash
./bin/check-env
```

`check-env` sources `.env` if present before checking env vars.

## File Structure

```
bin/
  check-env               Environment check (git hooks, bun, submodule, env vars)
.githooks/
  pre-commit              Runs typecheck + build before every commit
src/
  index.ts                CLI entry: verbs, .env load, dispatch, help
  config.ts               Config resolution (env vars + flags)
  run-agent.ts            Headless runner: tools, director, hooks, critique
  stream-consumer.ts      Async stream consumer with error handling
  director.ts             CodingDirector + ChatDirector; director-layer tool defs
  prompts.ts              System prompt builders (agent + chat)
  state.ts                RunState / DirectorPersistedState JSON save/load
  critic.ts               Post-submit critique (build, typecheck, test)
  faremeter.ts            Token usage → cost
  pricing-fetcher.ts      models.dev pricing load + background refresh
  renderer.ts             Headless event-stream renderer (stderr + live cost)
  hooks.ts                Lifecycle hooks: discovery, turn collector, run summary
  permission/
    classify.ts           Tool tier + approval-request construction
    command.ts            Chained-command split + command scopes
    gate.ts               Permission gate evaluation
    matcher.ts            Approval glob matching
    store.ts              Per-directory approval persistence
    types.ts              Approval / scope / request / outcome types
  plugins/
    path-escape-plugin.ts   Path sandboxing (first)
    secret-guard-plugin.ts  Hard-deny secret files
    authz-plugin.ts         Catastrophic command blocking
    permission-plugin.ts    Tiered operator approval
    verify-plugin.ts        Write/edit verification
    re-read-block-plugin.ts Block redundant re-reads
  tui/
    app.tsx               Root full-screen layout
    runner.tsx            Chat-mode agent setup + Ink render (alt-screen)
    use-stream.ts         Event stream → React state
    git-diff.ts           Working-tree diff
    tool-formatter.ts     Human-readable tool args/results
    markdown-parser.ts    Markdown rendering
    keymap-table.ts       Keybindings
    theme.ts              Colors
    commands/
      registry.ts         Extensible slash-command registry
      built-in.ts         /help, /diff, /plan, /verbose, /model
    components/
      header.tsx, event-log.tsx, chat-input.tsx, status-bar.tsx,
      plan-view.tsx, diff-view.tsx, context-panel.tsx,
      operator-modal.tsx, permission-modal.tsx, approval-modal.tsx,
      exit-confirm.tsx, help-overlay.tsx, hook-panel.tsx,
      in-flight-indicator.tsx
    hooks/
      use-diff.ts, use-gates.ts, use-keymap.ts,
      use-scroll.ts, use-spinner.ts, use-terminal-size.ts
docs/
  PRODUCT.md, ARCHITECTURE.md, IMPLEMENTATION.md, HOOKS.md
```

## Configuration

### Settings Files (`src/settings.ts`)

Provider and model configuration lives in JSON settings files. The global file holds providers and credentials; the per-repo file selects among them and must not contain credentials.

- Global: `~/.interchange/settings.json`

  ```json
  {
    "defaultProvider": "firepass",
    "providers": {
      "firepass": {
        "baseURL": "https://firepass.example/v1",
        "apiKey": "sk-...",
        "models": ["fp-large", "fp-small"],
        "defaultModel": "fp-large"
      }
    }
  }
  ```

  `models` is always an array (single- and multi-model providers are uniform). `defaultModel` (or the first entry) is used when no model is selected. With exactly one provider configured, `defaultProvider` may be omitted.

- Per-repo: `.interchange/settings.json` — **selection only**, e.g. `{ "provider": "firepass", "model": "fp-small" }`. Any other key (notably `apiKey`) is rejected by the loader, and the file is gitignored. It is also on the secret-guard denylist, as is the global file, so the agent cannot read its own credentials.

### Resolution Precedence

`loadConfig` resolves the active provider down to `{ apiKey, baseURL, model, providerName }` (the same struct the runtime consumes). Per field, highest wins:

- providerName: `--provider` > `OPENAI_COMPATIBLE_PROVIDER_NAME` > local file > `defaultProvider` > sole provider
- model: `--model` > `OPENAI_COMPATIBLE_MODEL` > local file > provider `defaultModel` > first model
- baseURL / apiKey: `OPENAI_COMPATIBLE_BASE_URL` / `OPENAI_COMPATIBLE_API_KEY` > selected provider

`--config <path>` replaces the global settings file as the provider source (used by CI and the eval harness to inject a provider per run). When the resolved provider is not in any settings file, credentials come entirely from env — preserving the original `.env`-only workflow.

### Environment Variables (override)

| Variable | Description |
|---|---|
| `OPENAI_COMPATIBLE_API_KEY` | Overrides the resolved API key |
| `OPENAI_COMPATIBLE_BASE_URL` | Overrides the resolved base URL |
| `OPENAI_COMPATIBLE_MODEL` | Overrides the resolved model |
| `OPENAI_COMPATIBLE_PROVIDER_NAME` | Overrides the resolved provider name |

`.env` in the project root is auto-loaded by `index.ts` (existing env vars are not overwritten). Env vars are no longer required when a settings file is present.

### CLI Verbs and Flags

| Verb / Flag | Default | Description |
|---|---|---|
| `run` (optional) | — | Run a task (default verb) |
| `resume` | — | Resume the last run in the working directory |
| `--cwd <dir>` | `process.cwd()` | Working directory |
| `--config <path>` | `~/.interchange/settings.json` | Settings file to use |
| `--provider <name>` | from settings | Select a configured provider |
| `--model <id>` | provider default | Select a model for the active provider |
| `--headless`, `-h` | false | Headless CLI mode (default is the TUI) |
| `--force` | false | Override an existing run state |
| `--dangerously-skip-permissions` | false | Auto-allow anything not denied by the authorization layer |
| `--help` | — | Show help |

Positional arguments are joined into the task description. In headless mode a task is required.

### Agent Source

`createAgent` is configured with a single OpenAI-compatible source built from the resolved config, `defaults.maxTokens = 16384`, and a git-backed `contextDir` at `.agent-state/context`.

## Protocols and Formats

### Inference

- OpenAI-compatible chat completions, streamed via `@intx/inference`
- JSON-schema tool definitions for `submit_plan`, `ask_operator`, `submit_output`

### State Persistence

- `.agent-state/run.json` — `RunState`
- `.agent-state/director.json` — `DirectorPersistedState`
- `.agent-state/context/` — git-backed conversation context (`@intx/storage-isogit`)
- Atomic JSON writes with schema validation on load

### Event Stream

`agent.stream()` emits `ReactorEmittedEvent` objects, including:
- `inference.tool_call.start` / `inference.tool_call.end` — tool call lifecycle
- `tool.start` / `tool.done` — tool execution (with `isError`)
- `inference.usage` — token usage (faremeter)
- `connector.reply` — model reply content
- `inference.error` / `reactor.error` — parse/inference and fatal errors
- `reactor.done` — loop completion

### Lifecycle Hooks

- Discovered from `.interchange/hooks` (local) and `~/.interchange/hooks` (global)
- Types: `typescript` (imported by file URL) and `shell` (executed)
- `postTurn(TurnContext)` fired per turn; `postRun(RunSummary)` fired once at completion
- See `docs/HOOKS.md`

### Pricing

- Pricing fetched from models.dev, cached, refreshed on a background interval
- `faremeter` converts `inference.usage` counts into a formatted `$X.XXXX` cost

## Build and Validation

```bash
bun run build      # bun build ./src/index.ts --outdir ./dist --target bun
bun run typecheck  # tsc --noEmit
bun test           # run the full test suite
```

Run all three before declaring work complete.

## Testing

- **Unit tests** are co-located with source as `*.test.ts` (e.g. `config.test.ts`, `director.test.ts`, `prompts.test.ts`, `renderer.test.ts`, `permission/permission.test.ts`, each `plugins/*.test.ts`, and TUI tests under `tui/`).
- **Integration / e2e** use the `@intx/inference-testing` harness with deterministic SSE responses to assert real tool sequences (`read_file` → `write_file` → `run_shell` → `submit_output`) and that critique passes.
- **Fixtures** live under `tests/fixtures/` (e.g. `demo-comparison/` for side-by-side comparison runs).
- **TUI tests** use `ink-testing-library` with mock `EventEmitter`s to simulate real-time event streams; they verify stream-hook accumulation, event-log formatting/filtering, keyboard handling, and cost formatting.

## Deployment

- Single bundled entry: `./dist/index.js`
- CLI name: `interchange-code`
- Self-contained: runtime dependencies are workspace-linked or bundled; no container or orchestration required
