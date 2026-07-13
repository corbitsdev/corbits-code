# Intercode — Implementation

Package version: **0.2.35**. CLI binary: `intercode` (`./dist/index.js`).

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
| `typescript-language-server` | ^4.3.4 | TS/JS language server for the `lsp` tool (`bin/check-env` checks for it) |

## Interchange submodule

The `interchange/` git submodule tracks **`origin/main`** with no intercode-specific patches inside it. Behavior overrides (URI normalization, LSP hints, verify locking, etc.) live under `src/plugins/` and `src/util/` in this repo.

## Developer Setup

Configure git hooks before the first commit:

```bash
git config core.hooksPath .githooks
```

Verify the environment (git hooks, bun install, interchange submodule, provider settings):

```bash
./bin/check-env
```

`check-env` confirms a provider catalog exists in `~/.intercode/settings.json` (or that onboarding will create one).

## File Structure

```
bin/
  check-env               Environment check (git hooks, bun, submodule, provider settings)
.githooks/
  pre-commit              Runs typecheck + build before every commit
src/
  index.ts                CLI entry: verbs, dispatch, help
  agent/
    director.ts           ChatDirector; director-layer tool defs
    prompts.ts            System prompt builders (agent + chat)
    tools.ts              Agent tool registration helpers
    agent-search.ts       search_agents tool + profile lexical index
    renderer.ts           Event-stream renderer (stderr + live cost; used by tests/utilities)
  session/
    index.ts              Session lifecycle (was session.ts)
    state.ts              RunState JSON save/load
    compactor.ts          Context compactor (was context-compactor.ts)
    summarizer.ts         Model-backed structured compaction summary (+ deterministic fallback)
    run-sink.ts           Run-level event sink
    stream-consumer.ts    Async stream consumer with error handling
    hooks.ts              Lifecycle hooks: discovery, turn collector, run summary
  subagent/
    index.ts              Sub-agent spawn + SubAgentDirector
    session-store.ts      Retained child session transcripts for observe UI
  config/
    index.ts              Config resolution (settings files + flags) (was config.ts)
    settings.ts           Settings schema, validators, loaders, resolveProvider
    providers.ts          ProviderCatalogEntry type + TUI provider list helpers
    profiles.ts           Profile-level selection logic
  cost/
    faremeter.ts          Token usage → cost
    pricing-fetcher.ts    models.dev pricing load + background refresh
  util/
    alt-screen.ts         Terminal alternate-screen helpers
    list-dir.ts           Directory listing utility
  permission/
    classify.ts           Tool tier + approval-request construction
    command.ts            Chained-command split + command scopes
    auto-shell-policy.ts  Auto-mode run_shell deny/ask rule table
    gate.ts               Permission gate evaluation
    matcher.ts            Approval glob matching
    store.ts              Per-directory approval persistence
    types.ts              Approval / scope / request / outcome types
  plugins/
    data-only-agent.ts         Markdown-only agent plugins (agents/*.md)
    loader.ts                  Plugin discovery + loadPluginEntry
    path-escape-plugin.ts      Path sandboxing (first)
    tool-output-uri-plugin.ts  Normalize read_file tool-output URIs
    secret-guard-plugin.ts     Hard-deny secret files
    authz-plugin.ts            Catastrophic command blocking (thin wrapper)
    permission-plugin.ts       Tiered operator approval
  shell/
    run-shell-authz.ts         Shared run_shell deny policy (authz + permission)
    verify-plugin.ts           Write/edit verification (per-path lock)
    file-mutation-lock.ts      Serialize mutations per file for verify
    lsp-hint-plugin.ts         TS/JS LSP setup hint on unavailable server
  tui/
    app.tsx               Root full-screen layout
    runner.tsx            Chat-mode agent setup + Ink render (alt-screen)
    use-stream.ts         Event stream → React state (AgentStatus machine)
    tool-formatter.ts     Human-readable tool args/results
    markdown-parser.ts    Markdown rendering
    keymap-table.ts       Keybindings
    theme.ts              Colors
    commands/
      registry.ts         Extensible slash-command registry
      built-in.ts         /help, /model, /settings, /permissions, /plugins,
                          /login, /codex, /xai, /grok, /clear, /new, /mcp
    components/
      header.tsx, event-log.tsx, chat-input.tsx, status-bar.tsx, task-view.tsx,
      at-mention/, operator-modal.tsx, permission-modal.tsx,
      permissions-manager.tsx, plugins-manager.tsx, settings-overlay.tsx,
      agent-modal.tsx, exit-confirm.tsx, help-overlay.tsx, hook-panel.tsx,
      login-provider-picker.tsx, codex-login-modal.tsx, mcp-auth-prompt.tsx,
      onboarding-animation.tsx, in-flight-indicator.tsx, modal-stack.tsx
    hooks/
      use-gates.ts, use-keymap.ts, use-layout-geometry.ts, use-mcp-status.ts,
      use-mouse-scroll.ts, use-provider-manager.ts,
      use-scroll.ts, use-spinner.ts, use-terminal-size.ts
    stdin-filter.ts       Strips SGR mouse sequences before Ink parses input
docs/
  PRODUCT.md, ARCHITECTURE.md, IMPLEMENTATION.md, HOOKS.md, MCP.md, PLUGINS.md
```

### Auto Mode

SHIFT+TAB (wired through `use-keymap`'s `cycleMode` action to `onToggleAuto` in `src/tui/app.tsx`) enables auto mode. The permission gate reads this flag (`getAuto`/`setAuto` in `src/permission/gate.ts`) and auto-approves non-destructive consequential actions — file writes and edits — without prompting on the next tool call. Destructive actions still gate normally.

Plan approval is handled separately by `use-gates` (`pendingPlan`), independent of auto mode.

### Interrupt and Queue Steering

`ChatInputProps` carries `isProcessing?: boolean` and `onInterrupt?: (message: string) => void`. When `isProcessing` is true:

- **Enter** calls `onInterrupt`. `App.handleInterrupt` calls `requestStop()` synchronously — which calls `sendAbortRef.current.abort()` — before `resolveAtMentions` yields, ensuring the abort signal reaches the in-flight HTTP request before any async work begins.
- **Alt+Enter** calls `onSubmit` immediately, pushing the message onto `pendingQueueRef` for drain at the next `connector.reply`.

Token event batching in `use-stream.ts`: `TOKEN_EVENTS` (`inference.text.delta`, `inference.thinking.delta`, `inference.tool_call.delta`) set `pendingRenderRef.current = true`; a 33ms `setInterval` converts pending flags into `setTick` calls. All other events call `setTick` directly.

### @file Mention Resolution

`@<path>` tokens in chat input are resolved to file contents before delivery to the agent. `resolveAtMentions` (in `app.tsx`) scans the submitted text for `@<path>` patterns, resolves each against the workspace (blocking absolute paths, `..` escapes, and sensitive files), and inlines file contents as fenced code blocks or directory summaries. Unresolvable paths pass through as a short inline warning so the agent knows the mention could not be expanded. Limits: 5 mentions per message, 200 kB per file, 400 kB total.

## Configuration

### Settings Files (`src/config/settings.ts`)

Provider and model configuration lives in JSON settings files. The global file holds provider definitions and API keys; the per-repo file selects among them and must not contain credentials.

- Global: `~/.intercode/settings.json`

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

  Optional `maxConcurrentSubAgents` (integer ≥ 0, default **10**) caps how many `task`-tool sub-agent loops may run at once; **0** disables sub-agents entirely. Change it in **Settings → Sub-agents** or in this file. Applies only when `sessionMode` is **orchestrator**.

  Optional `sessionMode`: **`single`** (one primary agent, no `task` / `search_agents` on the wire) or **`orchestrator`** (default once chosen — delegates via `task` and advertises agent profiles). When unset on first TUI launch, Intercode prompts once and persists the choice to this file. Per-repo override: `.intercode/settings.json` `{ "sessionMode": "single" | "orchestrator" }` (Settings → Session).

- Per-repo: `.intercode/settings.json` — **selection only**, e.g. `{ "provider": "firepass", "model": "fp-small" }`. Any other key (notably `apiKey` or `baseURL`) is rejected by the loader, and the file is gitignored. It is also on the secret-guard denylist, as is the global file, so the agent cannot read its own credentials.

  `baseURL` is editable provider metadata, but it still belongs in the global provider definition rather than the per-repo selection file. `apiKey` is secret and must never be projected into TUI display-only provider lists.

### Resolution Precedence

`loadConfig` resolves the active provider down to `{ apiKey, baseURL, model, providerName }` (the same struct the runtime consumes). Per field, highest wins:

- providerName: `--provider` > local file > `defaultProvider` > sole provider
- model: `--model` > local file > provider `defaultModel` > first model
- baseURL / apiKey: the selected provider only

Credentials and provider definitions come exclusively from the settings files. Environment variables (including `OPENAI_COMPATIBLE_*`) have no influence on provider resolution, and `.env` files are not loaded.

OpenAI-compatible `baseURL` values are normalized during provider resolution. A plain base URL such as `https://provider.example.com/v1` is preserved, a trailing slash is removed, and a pasted full chat-completions endpoint such as `https://provider.example.com/v1/chat/completions` is reduced to `https://provider.example.com/v1` before the runtime appends `/chat/completions`. Invalid non-URL values fail with an explicit baseURL error.

`--config <path>` replaces the global settings file as the provider source (useful for CI to inject a provider per run). The per-repo `.intercode/settings.json` selection still applies on top of a `--config` source (definitions come from `--config`, selection from the local file; CLI `--provider`/`--model` override both). A provider must be defined in one of these settings files; there is no environment-variable fallback.

### Profiles (`src/config/profiles.ts`)

Profiles supply per-project or named-profile overrides for `model`, `maxTurns`, and `systemPromptExtensions` (the only allowed keys; any other key is rejected on load).

- Project profile: `.intercode/profile.json` in the repo root — committed, credential-free.
- Named profiles: `~/.intercode/profiles/<name>.json` — user-level overrides, inherited via the `profile` key or the `--profile` flag.

```json
{
  "profile": "work",
  "model": "claude-opus-4-8",
  "maxTurns": 50,
  "systemPromptExtensions": ["no-destructive-migrations"]
}
```

`resolveProfile` merges a named profile with the project profile, with **project profile field values overriding the named profile's**. The resolved `model` / `maxTurns` feed into provider resolution and the director; `systemPromptExtensions` are appended to the system prompt. Workflow profile metadata is deprecated because workflows are started only by explicit slash commands. CLI flags (`--model`, `--profile`) still win over profile values during config resolution.

### Provider Configuration

Providers and credentials are read exclusively from settings files: the global `~/.intercode/settings.json` (definitions + credentials) and the per-repo `.intercode/settings.json` (selection only). There are no `OPENAI_COMPATIBLE_*` environment-variable overrides, and `index.ts` does not load `.env` files — a deliberately stale or exported key can no longer shadow the configured provider.

### CLI Verbs and Flags

| Verb / Flag | Default | Description |
|---|---|---|
| `run` (optional) | — | Run a task (default verb) |
| `resume` | — | Resume the last run in the working directory |
| `--cwd <dir>` | `process.cwd()` | Working directory |
| `--config <path>` | `~/.intercode/settings.json` | Settings file to use |
| `--provider <name>` | from settings | Select a configured provider |
| `--model <id>` | provider default | Select a model for the active provider |

| `--force` | false | Override an existing run state |
| `--dangerously-skip-permissions` | false | Auto-allow anything not denied by the authorization layer |
| `--no-workflow` | false | Deprecated no-op; workflows are manual slash commands only |
| `--help` | — | Show help |

Positional arguments are joined into the optional initial task delivered when the TUI mounts. With no positional task, the operator starts from an empty prompt.

### Agent Source

`createAgent` is configured with a single OpenAI-compatible source built from the resolved config, `defaults.maxTokens = 16384`, and a git-backed `contextDir` at `.agent-state/context`.

## Protocols and Formats

### Inference

- OpenAI-compatible chat completions, streamed via `@intx/inference`
- JSON-schema tool definitions for director-layer tools (`ask_operator`, `present`, `submit_output`, `advance_workflow`) and agent tools (`manage_tasks`, `tool_search`, `use_skill`, `search_agents`, …)

### State Persistence

- `.agent-state/run.json` — `RunState`
- `.agent-state/context/` — git-backed conversation context (`@intx/storage-isogit`)
- Atomic JSON writes with schema validation on load

`createOptimizedContextStore` (`src/session/optimized-context-store.ts`) wraps the
Interchange git store to keep per-checkpoint cost independent of session length.
The append-only snapshots (`turns.jsonl`, `prompt.jsonl`) are written as rolling
segments (`turns-0001.jsonl`, ...) that seal at 256KB, so `git add` re-hashes only
the small active segment instead of the whole growing file. Segment zero keeps the
original filename, so a legacy monolithic `turns.jsonl` reads back as its own first
segment. `load` and `readAt` concatenate every segment in order; a torn final line
in the active segment (from a crash mid-write) is dropped on resume. Only tool-output
blobs new since the last commit are staged, and stale segments deleted by a
history rewrite (compaction) are removed from the tree on the next commit. The
per-commit git tree still grows one entry per spilled tool-output blob across the
session; that tree re-write is inherent to git and left as residual cost.

### Crash Logging

`index.ts` installs `uncaughtException` and `unhandledRejection` handlers (and catches a rejected `main`). Each writes a best-effort crash report to `~/.intercode/projects/<project-slug>/errors/<timestamp>.txt`, where the slug is the cwd with non-alphanumeric runs collapsed to `-`. The file records the failure kind, an ISO timestamp, the cwd, and the stack. The logger swallows its own errors so it can never mask the original crash, then exits non-zero after printing a one-line message to stderr.

### Event Stream

`agent.stream()` emits `ReactorEmittedEvent` objects, including:
- `inference.tool_call.start` / `inference.tool_call.end` — tool call lifecycle
- `tool.start` / `tool.done` — tool execution (with `isError`)
- `inference.usage` — token usage (faremeter)
- `connector.reply` — model reply content
- `inference.error` / `reactor.error` — parse/inference and fatal errors
- `reactor.done` — loop completion

Mid-run queue steering is entirely in `app.tsx`: `queuedCount` tracks `pendingQueueRef` depth; the input chrome shows `N queued · Enter steer · Alt+Enter queue` while processing.

### Lifecycle Hooks

- Discovered from `.intercode/hooks` (local) and `~/.intercode/hooks` (global)
- Types: `typescript` (imported by file URL) and `shell` (executed)
- `postTurn(TurnContext)` fired per turn; `postRun(RunSummary)` fired once at completion
- See `docs/HOOKS.md`

### Pricing

- Pricing fetched from models.dev, cached, refreshed on a background interval
- `faremeter` converts `inference.usage` counts into a formatted `$X.XXXX` cost
- The same models.dev payload also yields per-model context windows (`limit.context`), captured into the pricing cache (`contextWindows`) and loaded into `src/provider/context-window.ts`. `compactionThresholdFor(model)` returns ~60% of that window (falling back to per-family heuristics, then 128k) to size proactive compaction. Unknown/family-only models still get a sane default.

### Plugin system

See `docs/PLUGINS.md` for the full design. Summary:

- Every installable plugin exports a `manifest` (`{ id, name, kind, description?, credentials? }`) with `kind` one of `web | command | tool`. A workflow is just a slash command, so there is no separate workflow/agent kind.
- Plugins are auto-discovered from `plugins/`, `<cwd>/.intercode/plugins/`, and `~/.intercode/plugins/`, plus any explicit file/dir paths in `settings.pluginPaths`. The `/plugins` UI's "add by path" action (`a`) loads a plugin from anywhere on disk, validates its manifest, and persists the path. Discovery resolves relative imports to absolute first (`loadPluginEntry`).
- **Explicit enable:** nothing is wired in until `settings.plugins[id].enabled` is true. `web` → `resolveWebProviderFromPlugins` picks the active backend (`settings.web` id override, else the single enabled web plugin); web is plugin-only, so when none resolves (or a plugin fails to start) `web_search`/`web_fetch` are left unregistered rather than falling back to a built-in fetcher; `command` → `registerCommandPlugins` registers slash commands (live on enable); `tool` → `resolveToolPlugins` instantiates `createToolPlugin(credentials)` and appends the tools to the posix toolset assembled in `src/tui/runner.tsx` (via `tools.ts` helpers).
- **Tool consent:** a `tool` plugin runs in-process, so it is wired in only when enabled AND `consented`. The `/plugins` UI prompts a one-time y/n consent recorded in `settings.plugins[id].consented`.
- Configure via `/plugins`, which writes `settings.plugins` (enabled / consented / credentials), `settings.web`, and `settings.pluginPaths` to the global settings file. Credentials live in the global file because it carries secrets — the project-local settings file rejects credential keys. When a web plugin is active its tool calls render under its brand (e.g. "Exa Search"). Example: `{ "web": "exa", "plugins": { "exa": { "enabled": true, "credentials": { "apiKey": "..." } } } }`.

## Build and Validation

```bash
bun run build      # bun build ./src/index.ts --outdir ./dist --target bun
bun run typecheck  # tsc --noEmit
bun test ./src ./tests
```

Run all three before declaring work complete.

## Testing

- **Unit tests** are co-located with source as `*.test.ts` (e.g. `config.test.ts`, `director.test.ts`, `prompts.test.ts`, `renderer.test.ts`, `permission/permission.test.ts`, each `plugins/*.test.ts`, and TUI tests under `tui/`).
- **`tests/unit/`** holds shared unit helpers and focused packages (e.g. TUI geometry tests).
- **`tests/fixtures/`** holds fixture repos and comparison assets (e.g. `demo-comparison/`).
- **`tests/integration/`** holds the reactor permission / multi-turn harness (CL-3322). **`tests/e2e/`** (fixture-repo runs) is still planned. Until e2e exists, broader harness coverage also lives in co-located `*.test.ts` files and `tests/unit/`.
- **TUI tests** use `ink-testing-library` with mock `EventEmitter`s to simulate real-time event streams; they verify stream-hook accumulation, event-log formatting/filtering, keyboard handling, and cost formatting.

## Deployment

- Single bundled entry: `./dist/index.js`
- CLI name: `intercode`
- Self-contained: runtime dependencies are workspace-linked or bundled; no container or orchestration required
