# Corbits Code — Implementation

CLI binary: `corbits` (`./dist/index.js`). Version lives in `package.json` only.

## Runtime

- **Bun** — runtime and bundler (`@types/bun` 1.3.9)
- **TypeScript 5.9.3** — strict mode, ES modules only
- **No classes** for application logic — functional programming throughout (the two directors subclass `DefaultDirector` from the runtime, the one deliberate exception)

## Dependencies

### Direct (production)

| Package                | Version         | Usage                                                                                            |
| ---------------------- | --------------- | ------------------------------------------------------------------------------------------------ |
| `@intx/agent`          | workspace       | `createAgent`, `fromToolRunner`, `stringTool` — agent runtime                                    |
| `@intx/inference`      | workspace       | `DefaultDirector`, inference runner, OpenAI-compatible provider, event types                     |
| `@intx/tools-posix`    | workspace       | `createPosixTools`, `ToolPlugin` middleware — sandboxed shell/file tools                         |
| `@intx/types`          | workspace       | Runtime types (`ReactorDirector`, `ReactorState`, `ToolDefinition`, `ToolCall`, `ToolResult`, …) |
| `@intx/storage-isogit` | workspace       | Git-backed context persistence                                                                   |
| `@opentui/core`        | 0.5.1           | Terminal UI renderer                                                                             |
| `@opentui/keymap`      | 0.5.1           | OpenTUI keybinding support                                                                       |
| `@opentui/solid`       | 0.5.1           | Solid bindings for OpenTUI                                                                       |
| `solid-js`             | 1.9.14          | Reactive primitives used by the OpenTUI bindings                                                 |
| `arktype`              | catalog ^2.1.29 | Runtime validation                                                                               |

Other Interchange workspace packages (`@intx/inference-discovery`, `@intx/mime`, `@intx/log`, `@intx/crypto-node`) are pulled transitively via the above.

### Dev

| Package                      | Version   | Usage                                                                    |
| ---------------------------- | --------- | ------------------------------------------------------------------------ |
| `@intx/inference-testing`    | workspace | Deterministic agent-loop test harness                                    |
| `@types/bun`                 | 1.3.9     | Bun types                                                                |
| `ws`                         | ^8.21.0   | WebSocket support                                                        |
| `typescript`                 | 5.9.3     | Type checking                                                            |
| `typescript-language-server` | ^4.3.4    | TS/JS language server for the `lsp` tool (`bin/check-env` checks for it) |

## Interchange packages

Interchange is consumed as published `@intx/*` npm packages pinned at **0.2.2**. The one exception is `@intx/inference`, which resolves (via a workspace override) to `vendor/intx-inference` — upstream 0.2.2 source plus the audited patch set recorded on CL-4352. There is no interchange working copy in this repo, and we never modify or push to the upstream interchange repository. Behavior overrides (URI normalization, LSP hints, verify locking, etc.) live under `src/plugins/` and `src/util/` in this repo.

## Developer Setup

Configure git hooks before the first commit:

```bash
git config core.hooksPath .githooks
```

Verify the environment (git hooks, bun install, @intx packages, provider settings):

```bash
./bin/check-env
```

`check-env` confirms a provider catalog exists in `~/.corbits/settings.json` (or that onboarding will create one).

## File Structure

```
bin/
  check-env               Environment check (git hooks, bun, @intx packages, provider settings)
.githooks/
  pre-commit              Runs typecheck + build before every commit
src/
  index.ts                CLI entry: verbs, dispatch, help
  agent/
    director.ts           ChatDirector; director-layer tool defs
    prompts.ts            System prompt builders; buildChatRole → Skywalker
    tools.ts              Agent tool registration helpers
    agent-search.ts       search_agents tool + profile lexical index
    default-agents.ts     Built-in profiles = directorProfiles() spawn catalog
    directors/            Closed director fleet packages + registry
      types.ts            DirectorId, DirectorPackage, TaskIntent, ModelRole
      registry.ts         DIRECTOR_REGISTRY, resolveDirector, packageToProfile
      tool-sets.ts        Shared allowlists (READ/IMPLEMENT/DOCS/REVIEW/…)
      <id>/package.ts     Per-director prompt, envelope, spawn, report
    renderer.ts           Event-stream renderer (stderr + live cost; used by tests/utilities)
  session/
    index.ts              Session lifecycle
    state.ts              RunState JSON save/load
    compactor.ts          Context compactor
    summarizer.ts         Model-backed structured compaction summary (+ deterministic fallback)
    run-sink.ts           Run-level event sink
    stream-consumer.ts    Async stream consumer with error handling
    hooks.ts              Lifecycle hooks: discovery, turn collector, run summary
  subagent/
    index.ts              Sub-agent spawn + SubAgentDirector
    task-tool.ts          task() — fused spawn+wait; resolveDirector first
    session-store.ts      Retained child session transcripts for observe UI
    identity-context.ts   ALS: worker description + cwd for gate attribution
  config/
    index.ts              Config resolution (settings files + flags)
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
    secret-guard-plugin.ts     Hard-deny path-keyed secret files
    authz-plugin.ts            Catastrophic command blocking (thin wrapper)
    permission-plugin.ts       Tiered operator approval
  shell/
    run-shell-authz.ts         Shared run_shell deny policy (authz + permission)
    verify-plugin.ts           Write/edit verification (per-path lock)
    file-mutation-lock.ts      Serialize mutations per file for verify
    lsp-hint-plugin.ts         TS/JS LSP setup hint on unavailable server
  tui/
    runner.ts             Chat-mode agent setup; mounts the OpenTUI host
    onboarding.ts         First-run welcome gate, then provider setup
    pick-session.ts       Resume picker (via runListModal)
    turns-to-blocks.ts    Stored turns → typed content blocks (resume hydration)
    tool-formatter.ts     Human-readable tool args/results
    markdown-parser.ts    Markdown rendering
    theme.ts              Colors
    commands/
      registry.ts         Extensible slash-command registry
      built-in.ts         /help, /model, /settings, /permissions, /plugins,
                          /clear, /new, /mcp (connect providers from /model),
                          /yolo
  tui/
    shell.ts              Transcript, header, status line, prompt, overlays
    product-host.ts        Creates the CliRenderer, wires the event bridge
    runner-host.ts          Runner-facing mount: catalogs, chrome, quit key
    list-modal.ts           Shared list-picker overlay (runListModal)
    command-surfaces.ts     Slash-command surface routing (openCommandSurface)
    command-catalog.ts, model-catalog.ts, chrome-state.ts,
    provider-setup.ts       Onboarding provider setup flow
docs/
  PRODUCT.md, ARCHITECTURE.md, IMPLEMENTATION.md, TUI.md, HOOKS.md, MCP.md,
  PLUGINS.md, TELEMETRY.md, PERFTRACE.md
```

### Closed director fleet

Sixteen packages under `src/agent/directors/<id>/` register in `DIRECTOR_REGISTRY` (`registry.ts`). Wire path:

1. `spawn_agent(agent=…)` / `task(agent=…)` / `task(intent=…)` → `resolveDirector` in `task-tool.ts` before tools and system prompt are built. Bare `task` (neither field) and `intent=general` fail closed.
2. `packageToProfile` maps envelope (`tools.allow`/`deny`) to `AgentProfile.capabilities` and `spawn.maySpawn` → `orchestrator`. System prompts are prefixed with a stable identity block (`formatDirectorSystemPrompt`: agent id, model role, optional skills).
3. Nested spawn: packages with `spawn.allowlist` forward that list into nested `task` (`spawnAllowlist` on nestedDispatch). Off-list `agent` is refused. `task(agent=skywalker)` is refused (primary is not a spawned worker). Primary omits the list so plugin profiles stay reachable.
4. `directorProfiles()` is the spawn catalog (`default-agents.ts`) — closed set minus skywalker. Plugin and local `.agents/agents/` profiles still load, but closed `DIRECTOR_IDS` cannot be overridden or aliased.
5. Primary chat role is Skywalker: `buildChatRole()` → `createSkywalkerSystemPrompt()`. Product mutation tools (`write_file` / `edit_file` / `delete_file`) live in CORE (and `SKYWALKER_TOOLS`) so they are advertised on the primary without a `tool_search` round-trip. DIY tiny/bounded edits on the parent; spawn builder/docs directors for substantial work — a prompt judgment call, not a toolset strip. `PRIMARY_DENIED_PRODUCT_TOOLS` is gone. Shell file-writes stay denied; MCP tools are not re-filtered by a product-write deny list. There is no static per-profile write-path lock (CL-6952).

   **Codex tool proxies.** When the active provider is Codex (`isCodexProviderName`), `createAgentToolset` and `runSubAgent` mount `apply_patch`, `shell`, and `update_plan` stringTools from `createCodexToolProxies`, all forwarding through the same posix `ToolRunner` seam (`runTool`) so permission plugins still apply. `apply_patch` parses the Codex envelope and forwards each op (`write_file` / `delete_file` / `read_file`). `shell` — the native Codex name is `shell`, not `exec_command`, per the pinned base-instructions text quoted in `codex-responses-adapter.ts`'s bridge message — normalizes Codex's `command` (string or `["bash","-lc",script]`-style argv array), `workdir`, and `timeout_ms` onto `run_shell`'s `{command, cwd?, timeout?}` and is gated by `allowShellFromCapabilities` (mirrors `allowDeleteFromCapabilities` against `run_shell`). `update_plan` maps Codex's `plan: [{step, status}]` onto `manage_tasks(action: "create")`; `pending`/`in_progress`/`completed` map to `todo`/`doing`/`done` — `manage_tasks`'s `cancelled` status has no Codex equivalent and is never produced by this proxy. Primary strips `apply_patch` after mount (Corbits DIY stays on `write_file` / `edit_file` / `delete_file`); `shell` and `update_plan` stay on primary (same classification as `run_shell` / `manage_tasks`). Build and docs leaf allowlists (`BUILD_TOOLS` / `DOCS_TOOLS`) include `apply_patch` so Codex workers keep the proxy after the capability filter. `CORE_TOOL_NAMES` does not list it.

6. There is no static write-path declaration on packages or profiles (CL-6952 removed it — no shipped director ever set one). Instead, `task-tool.ts` tracks each running dispatch by cwd; a new dispatch that lands on the same cwd as a still-running lane records a `concurrent-lane-overlap` entry in `intervention-log.ts` (class `conflict`). This is advisory only — it never blocks the spawn, since cwd overlap does not prove the two lanes touch the same files.
7. Spawn effort: pin > package `modelRole` default (`defaultEffortForDirector`; intern=low; plan/review/orchestrator=high; implement/explore/docs/test=medium) > orchestrator/worker binary > parent inheritance. Optional skills are listed in the identity header for awareness; workers do not mount `use_skill` (guidance is baked into package system prompts). Primary mounts `use_skill` for its own skill list.

Intent defaults: `intent=implement` → director `builder`; `explore` → `explorer`; `plan` → `counsel`; `review` → `critic`; general → error. Spawn: skywalker full fleet; greybeard intern/explorer/critic only; all other directors no `task`. Live `<env>` injects cwd, platform, arch, runtime, date, and git status on every chat and worker prompt.

### Auto Mode

Auto mode defaults **on** (`config.auto = true` from `loadConfig`; pass `--no-auto` to start off, or `--auto` to force on). It is toggled only via those CLI flags — there is currently no in-session key bound to it. The permission gate reads the flag (`getAuto`/`setAuto` in `src/permission/gate.ts`) on the next tool call. `--dangerously-skip-permissions` still forces this process. `/yolo [on|off|toggle]` (bare `/yolo` also toggles) persists as the user-global default and wires `getSkipPermissions`/`setSkipPermissions` so the gate and pre-gate sandboxes honor the change on the next tool call without rebuilding plugins. `/yolo` writes the same `config.globalSettingsPath` target as the other `/settings`-style toggles, including a `--config` override. Secret-guard and authz still apply. `loadConfig` tracks `skipPermissionsFromSettings` (true only when the effective value came from persisted settings, not the CLI flag) so `runTUI` can show a startup notice and `exec` can print an equivalent stderr warning for the otherwise-silent persisted default.

When auto is on, the gate auto-allows workspace file tools in `AUTO_ALLOWED_TOOLS` and any `run_shell` that does not match the auto-shell policy. The policy (`autoShellRuleForCall` / `AUTO_SHELL_RULES` in `src/permission/auto-shell-policy.ts`) peels wrappers via `expandShellSubjects` (`bash`/`sh`/`zsh -c`, `xargs`, transparent prefixes), then applies:

| Effect   | Categories                                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **deny** | Shell file mutation (redirects, `tee`, in-place stream editors, interpreter `-c`/`-e`/heredoc)                                                                                                                              |
| **ask**  | Dependency installs / remote runners, recursive `rm`, force or uncontained git worktree add/remove/prune, sensitive-path references, paths outside the workspace (including through a symlink), opaque unparseable wrappers |

Unmatched shell auto-allows, including contained non-force `git worktree add`/`remove`/`prune` and read-only `list`. Writes under the session state root (`~/.corbits/projects/<project-key>/…`, and legacy in-repo `.agent-state` during dual-read), mutating MCP, and unknown built-ins still prompt. Authorization hard-denies (catastrophic commands, open-ended shell search) remain independent of auto mode.

### Reasoning Effort

**Shift+Tab** in the TUI cycles reasoning effort for the live model (`cycleReasoningEffort` in `src/provider/reasoning-effort.ts`); the runner rebuilds inference sources and the prompt-border `profile · model · effort` label so the next turn picks it up. Plain Tab still toggles focus.

### Interrupt and Queue Steering

`ChatInputProps` carries `isProcessing?: boolean` and `onInterrupt?: (message: string) => void`. When `isProcessing` is true, drain timing is **parent-idle** vs **session-idle**:

- **Enter** soft-steers while the parent is busy — enqueues kind `"steer"` and delivers at the next **parent** `tool.boundary` (the parent tool finishing, not a child). Does not interrupt. **Parent-idle** is when the primary Skywalker turn is not inside an in-flight parent tool; a long parent `run_shell` or awaiting `task()` is parent-busy and holds steers.
- **Alt+Enter** queues a follow-up (kind `"queue"`) delivered only on **session-idle** — parent-idle **and** no live fleet lanes (`run` goes idle). Session-idle Alt+Enter is a no-op. **Ctrl+C** stops the run.

Idle-with-fleet is shipped: after a non-blocking `spawn_agent` dispatch the parent turn can settle while workers keep running. The runner emits a `fleet` event carrying the live-lane count; the bridge holds the run busy on that count, so mid-hold Enter upgrades to a new primary turn (sent immediately) instead of queueing a steer, follow-ups keep waiting for true session-idle, and any steer left pending at the hold's engagement delivers immediately — the parent it was steering has already stopped.

`src/tui/stream-event-map.ts` maps reactor events onto the bridge's inbound events, and `src/tui/turn-state.ts` tracks the turn's status. `src/tui/turns-to-blocks.ts` hydrates a resumed session's stored turns into the same content blocks.

### @file Mention Resolution

`@-mention` resolution and image paste are not wired on the OpenTUI send path.

## Configuration

### Settings Files (`src/config/settings.ts`)

Provider and model configuration lives in JSON settings files. The global file holds provider definitions and API keys; the per-repo file selects among them and must not contain credentials.

- Global: `~/.corbits/settings.json`

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

  Optional `tools` block to arm the outer per-tool wall-clock budget (unset leaves the watchdog unarmed):

  ```json
  "tools": {
    "timeoutMs": 660000,
    "maxTimeoutMs": 1800000,
    "waitForApproval": true
  }
  ```

  - `timeoutMs` / `maxTimeoutMs` — outer execution watchdog around each tool `run()`. Unset leaves the watchdog unarmed; set these to arm it. `maxTimeoutMs` clamps non-shell tools when set and does not cap a longer requested `run_shell`. The `task` tool is always exempt: a dispatched sub-agent is bounded by stall, opt-in `deadlineMs`, and operator cancel, not the generic per-tool budget.
  - `waitForApproval` (default **true** when unset) — freeze that budget while a permission prompt is open so a late approve still runs the tool. **Settings → Tools** toggles this live for the next tool call and persists it here. When **false**, the budget keeps ticking during the prompt; on expiry the tool is skipped and the modal is auto-dismissed. The freeze is bounded: after **30 minutes** with the prompt still unanswered the budget resumes ticking on its own, so a prompt that never becomes visible (overlay open, UI gone) cannot hang a tool run indefinitely.

  Optional `mcp` block bounds MCP tool calls (`mcp__*` names) specifically — unlike `tools.*`, this arms **unconditionally** even with no settings at all, defaulting to **5 minutes**, since a wedged MCP server otherwise hangs a call forever with nothing to bound it (CL-6895):

  ```json
  "mcp": {
    "timeoutMs": 300000
  }
  ```

  On expiry the call returns a normal tool-error result ("MCP tool `<name>` timed out after `<n>`s — the server may be wedged; retry or continue without it") that the model can react to; the turn itself is never aborted. `tools.maxTimeoutMs`, if set, still caps `mcp.timeoutMs`.

  Optional `sessionMode` is **deprecated**. Legacy values (`single` | `orchestrator`) may still appear on disk and load without error; resolve always returns **orchestrator**. There is no first-run mode picker and no Settings row. Both the interactive TUI (`runTUI`) and the non-TUI product path (`runExec` / `corbits exec`) are orchestrator-only. Exec bootstrap is otherwise a forked copy of the TUI path (shared stack, intentional deltas documented under Architecture → Exec Runner).

- Per-repo: `.corbits/settings.json` — **selection only**, e.g. `{ "provider": "firepass", "model": "fp-small" }`. Any other key (notably `apiKey` or `baseURL`) is rejected by the loader, and the file is gitignored. It is also on the secret-guard denylist for path-keyed tools, as is the global file, so the agent cannot `read_file` its own credentials (shell references still require explicit operator approval).

  `baseURL` is editable provider metadata, but it still belongs in the global provider definition rather than the per-repo selection file. `apiKey` is secret and must never be projected into TUI display-only provider lists.

  Optional `env` (`Record<string, string>`) — per-project environment variables merged into the `run_shell` tool's spawn environment (on top of the process's own inherited environment; project values win on key collision). Validated with arktype at the settings boundary. Lets a project declare env needs (e.g. a build tool's config var) as configuration instead of a shell command that mutates the environment mid-session: `{ "env": { "FOO": "bar" } }`.

### `tools.*` Settings

All `tools.*` keys live in the global settings file only — there is no per-repo override in `.corbits/settings.json` (unlike `sessionMode`).

| Key                     | Default                                    | Effect                                                                                                                                                 |
| ----------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tools.timeoutMs`       | unset (watchdog unarmed)                   | Outer wall-clock budget per tool `run()` when set                                                                                                      |
| `tools.maxTimeoutMs`    | unset                                      | Cap on the outer budget when set; does not cap a longer requested `run_shell`                                                                          |
| `tools.waitForApproval` | `true`                                     | Freeze the budget while a permission prompt is open (freeze capped at 30 min); `false` keeps the clock ticking and auto-dismisses the prompt on expiry |
| `mcp.timeoutMs`         | **300000** (5 min) — armed even when unset | Outer wall-clock budget for `mcp__*` tool calls specifically; capped by `tools.maxTimeoutMs` when set                                                  |

The `waitForApproval` default is resolved once at the watchdog boundary (`resolveWaitForApproval`); toggling **Settings → Tools** updates the live config for the next tool call and persists the value here.

### Resolution Precedence

`loadConfig` resolves the active provider down to `{ apiKey, baseURL, model, providerName }` (the same struct the runtime consumes). Per field, highest wins:

- providerName: `--provider` > local file > `defaultProvider` > sole provider
- model: `--model` > local file > provider `defaultModel` > first model
- baseURL / apiKey: the selected provider only

Credentials and provider definitions come exclusively from the settings files. Environment variables (including `OPENAI_COMPATIBLE_*`) have no influence on provider resolution, and `.env` files are not loaded.

OpenAI-compatible `baseURL` values are normalized during provider resolution. A plain base URL such as `https://provider.example.com/v1` is preserved, a trailing slash is removed, and a pasted full chat-completions endpoint such as `https://provider.example.com/v1/chat/completions` is reduced to `https://provider.example.com/v1` before the runtime appends `/chat/completions`. Invalid non-URL values fail with an explicit baseURL error.

`--config <path>` replaces the global settings file as the provider source (useful for CI to inject a provider per run). The per-repo `.corbits/settings.json` selection still applies on top of a `--config` source (definitions come from `--config`, selection from the local file; CLI `--provider`/`--model` override both). A provider must be defined in one of these settings files; there is no environment-variable fallback.

`--config` composes with, rather than replaces, the home-level OAuth profile catalog: codex/xai credentials live in `~/.corbits/codex-auth.json` and `xai-auth.json`, entirely separate from settings.json, and are merged into the resolved provider catalog on every run regardless of `--config` (CL-6973). A `--config` file that names a `codex/*` or `xai/*` provider by ID does not by itself grant that provider's credentials — those come from the OAuth store whenever a matching profile exists there, independent of which settings file supplied the provider definitions. The only way to fully exclude the home OAuth catalog is the programmatic `globalSettingsPath` option to `loadConfig`, used by tests for full isolation; it is not exposed as a CLI flag.

### Profiles (`src/config/profiles.ts`)

Profiles supply per-project or named-profile overrides for `model` and `systemPromptExtensions` (the only allowed keys; any other key is rejected on load).

- Project profile: `.corbits/profile.json` in the repo root — committed, credential-free.
- Named profiles: `~/.corbits/profiles/<name>.json` — user-level overrides, inherited via the `profile` key or the `--profile` flag.

```json
{
  "profile": "work",
  "model": "claude-opus-4-8",
  "systemPromptExtensions": ["no-destructive-migrations"]
}
```

`resolveProfile` merges a named profile with the project profile, with **project profile field values overriding the named profile's**. The resolved `model` feeds into provider resolution and the director; `systemPromptExtensions` are appended to the system prompt. Workflow profile metadata is deprecated because workflows are started only by explicit slash commands. CLI flags (`--model`, `--profile`) still win over profile values during config resolution.

### Provider Configuration

Providers and credentials are read exclusively from settings files: the global `~/.corbits/settings.json` (definitions + credentials) and the per-repo `.corbits/settings.json` (selection only). There are no `OPENAI_COMPATIBLE_*` environment-variable overrides, and `index.ts` does not load `.env` files — a deliberately stale or exported key can no longer shadow the configured provider.

**Models-first connect.** There is no standalone `/login` command. `/model` opens on a flat **models-only** list (Recent, Favorites, then connected provider/model rows) built by `buildModelsFirstList` (`src/tui/model-picker.ts`); type-to-filter owns printable keys. Selecting a row runs `applyLiveModelSwitch` (`src/session/live-model-switch.ts`) so inference sources, permission-gate identity, grant persistence identity, and advertised tool schemas cut over together. **Alt+A** opens Connect via `addProviderSelectorChoices` (`src/tui/provider-setup.ts`), which lists every first-class kind including Custom — never bare `c` / Ctrl+A, and never in-list “connect →” rows. First-class API-key rows use a named-instance + auth-only form (instance name, key; catalog base URL is display-only); Custom keeps the full manual form. **Alt+F** toggles favorites; recent/favorite pairs live in global settings (`recentModels` / `favoriteModels`). **Alt+D** sets the default via `setDefaultModel` (global `defaultProvider` + that provider's `defaultModel`) plus `persistConnectedSelection` without switching the live session. First-class providers ship from `packages/first-class-providers` (corbits-agnostic defs) and `packages/opencode-go` (Go catalog, auth validate, multi-protocol endpoints, usage). OAuth providers open the existing browser login modal with a named account step; API-key providers share the same multi-instance naming and pre-seed models on save so selection works without restart. Both OAuth and API-key (including Custom) connects share `persistConnectedSelection` in `provider-setup-submit.ts` so project-local provider/model selection is written alongside global credentials. OpenCode Go forces `OPENCODE_GO_BASE_URL` when `opencodeGo` is set so subscription traffic is not billed as Zen PAYG.

**OpenCode Go multi-protocol.** Each Go model carries protocol metadata (`chat-completions`, `responses`, or `messages`). `buildGoSource` / `resolveGoEndpoint` pick the adapter and base URL per model (not a single provider-wide OpenAI route). When Go is the active provider, subscription usage is fetched for the status bar and omitted on auth/network failure.

### CLI Verbs and Flags

Printed by `corbits --help` / `-h` from `CLI_HELP_TEXT` in `src/config/index.ts`
(that constant is the source of truth; keep this table in sync when flags change).

| Verb / Flag                      | Default                    | Description                                                                                                                                                                                                                                                                  |
| -------------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| _(no verb)_                      | —                          | Interactive session; optional trailing task text                                                                                                                                                                                                                             |
| `exec` / `run`                   | —                          | Run a prompt (non-interactive / one-shot)                                                                                                                                                                                                                                    |
| `resume` / `continue`            | —                          | Open the session picker for this folder (project-keyed to this checkout's git toplevel)                                                                                                                                                                                      |
| `--resume`                       | —                          | Open the interactive session picker                                                                                                                                                                                                                                          |
| `resume <session-id>`            | —                          | Reopen a specific session                                                                                                                                                                                                                                                    |
| `resume --pick` / `--list`       | —                          | Interactive session picker                                                                                                                                                                                                                                                   |
| `--cwd <dir>`                    | `process.cwd()`            | Working directory                                                                                                                                                                                                                                                            |
| `--config <path>`                | `~/.corbits/settings.json` | Settings file to use for provider definitions; composes with (does not exclude) home-level codex/xai OAuth credentials                                                                                                                                                       |
| `--provider <name>`              | from settings              | Select a configured provider                                                                                                                                                                                                                                                 |
| `--model <id>`                   | provider default           | Select a model for the active provider                                                                                                                                                                                                                                       |
| `--profile <name>`               | —                          | Settings profile                                                                                                                                                                                                                                                             |
| `--force`                        | false                      | Override an existing run state                                                                                                                                                                                                                                               |
| `--dangerously-skip-permissions` | false                      | Auto-allow anything not denied by the authorization layer (gate + pre-gate workspace sandboxes; secret-guard / authz hard denies remain). This launch flag still forces this process; `/yolo [on\|off\|toggle]` persists as the user-global default via `setSkipPermissions` |
| `--auto`                         | true (default)             | Force auto mode on (workspace writes + unconstrained shell without prompts)                                                                                                                                                                                                  |
| `--no-auto`                      | false                      | Start with auto mode off (ask on every consequential action); no in-session key toggles it                                                                                                                                                                                   |
| `--help`, `-h`                   | —                          | Show help (exit 0 via `CliHelpError`)                                                                                                                                                                                                                                        |

Positional arguments after flags are joined into the optional initial task delivered when the TUI mounts. With no positional task, the operator starts from an empty prompt.

### Agent Source

`createAgent` is configured with a single OpenAI-compatible source built from the resolved config, `defaults.maxTokens = 16384`, and a git-backed `contextDir` at `~/.corbits/projects/<project-key>/<session-id>/context`.

## Protocols and Formats

### Inference

- OpenAI-compatible chat completions, streamed via `@intx/inference`
- JSON-schema tool definitions for director-layer tools (`ask_operator`, `present`, `submit_output`, `advance_workflow`) and agent tools (`manage_tasks`, `tool_search`, `use_skill`, `search_agents`, …)

### State Persistence

Session runtime state lives under the global projects tree (not in the repo):

- `~/.corbits/projects/<project-key>/<session-id>/run.json` — `RunState`
- `~/.corbits/projects/<project-key>/<session-id>/context/` — git-backed conversation context (`@intx/storage-isogit`)
- Project key: slug + short hash of this checkout's git toplevel (from `--show-toplevel`, so linked worktrees have distinct keys; workspace realpath when not a git tree)
- `latest` is a symlink in that same project sessions directory (not a session of its own). Naive globs over the directory double-count unless they skip `latest` (as `listSessions` does).

- Migration: if a session exists only under in-repo `.agent-state/<session-id>/`, it is moved into the global tree on open/list
- Atomic JSON writes with schema validation on load

`createOptimizedContextStore` (`src/session/optimized-context-store.ts`) wraps the
Interchange git store to keep per-checkpoint cost independent of session length.
Checkpoint commits go through system git and use the operator's global
`user.name` / `user.email` when both are set, so commit-author hooks see a real
identity; otherwise they fall back to Interchange's harness author
(`interchange-harness`, `harness@interchange.local`).
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

`index.ts` installs `uncaughtException` and `unhandledRejection` handlers (and catches a rejected `main`). Each calls `writeCrashReport` (`crash/report.ts`) to write a best-effort report to `~/.corbits/projects/<project-key>/errors/<timestamp>.txt`, using the same `projectKeyFor`/`projectSessionsRoot` (`session/project-key.ts`) that keys that project's session directories, so a crash report lands next to the session's `run.json` and transcript rather than under a separately computed slug. The file records the failure kind, an ISO timestamp, the cwd, and the stack. `projectSessionsRoot` shells out to git with no timeout, so the handler never calls it directly — `primeCrashReporting` resolves and caches the directory once at startup (right after config load), and `writeCrashReport` only ever reads that cached value; if priming never ran or failed, it falls back to an `unresolved` bucket rather than touching git mid-crash. `writeCrashReport` swallows its own errors and returns `null` without logging; the handler in `index.ts` is what prints the one-line failure notice to stderr when that happens, then exits non-zero.

### Event Stream

`agent.stream()` emits `ReactorEmittedEvent` objects. `docs/ARCHITECTURE.md`'s
"Reactor Events (Partial)" section names the two turn-boundary/shutdown events
the directors guard on; the full set of reactor and stream event types is
`PRODUCTION_REACTOR_TYPES` in `src/tui/stream-event-map.ts:62-78` —
treat that as canonical rather than this section or any other doc's partial
list.

Mid-run queue/steer/interrupt state is a pure state machine in `src/tui/session-queue.ts` (interaction contract §3): `enqueue` (kind `"queue"`) and `enqueueSteer` (kind `"steer"`) share one pending pool, drained steer-first, then queue, both FIFO within their class. Mid-run gestures: Enter soft-steers (drain at the next **parent** `tool.boundary` — the parent tool finishing, not a child; parent-busy holds steers), Alt+Enter queues a follow-up (drain on **session-idle**: parent-idle and no live fleet lanes), Ctrl+C stops. Idle-with-fleet is shipped: with live fleet lanes the bridge holds the run busy after the parent turn settles (`fleet` events carry the live count), mid-hold Enter upgrades to an immediate new turn, and the last lane terminalizing releases the hold and drains follow-ups.

### Lifecycle Hooks

- Discovered from `.corbits/hooks` (local) and `~/.corbits/hooks` (global)
- Types: `typescript` (imported by file URL) and `shell` (executed)
- `postTurn(TurnContext)` fired per turn; `postRun(RunSummary)` fired once at completion
- See `docs/HOOKS.md`

### Pricing

- Pricing fetched from models.dev, cached, refreshed on a background interval
- `faremeter` converts `inference.usage` counts into a formatted `$X.XXXX` cost
- The same models.dev payload also yields per-model context windows (`limit.context`), captured into the pricing cache (`contextWindows`) and loaded into `src/provider/context-window.ts`. `compactionThresholdFor(model)` returns ~60% of that window (falling back to per-family heuristics, then 128k) to size proactive compaction. Unknown/family-only models still get a sane default.

### Plugin system

See `docs/PLUGINS.md` for the full design. Summary:

- Every installable plugin exports a `manifest` (`{ id, name, kind, description?, credentials? }`) with `kind` one of `web | command | workflow | tool | agent`.
- Plugins are auto-discovered from `plugins/`, `<cwd>/.corbits/plugins/`, and `~/.corbits/plugins/`, plus any explicit file/dir paths in `settings.pluginPaths`. When `settings.discoverClaudePlugins` is true, plugins listed in `~/.claude/plugins/installed_plugins.json` are also loaded (install paths only; still require enable). The `/plugins` UI's "add by path" action (`a`) loads a plugin from anywhere on disk, validates its manifest, and persists the path. Discovery resolves relative imports to absolute first (`loadPluginEntry`). Project-local plugins require per-cwd trust (`~/.corbits/trust/<hash>.json`); path plugins use global path trust (`~/.corbits/trust/path-plugins.json`) so they keep working across project directories. Untrusted origins load metadata-only until granted.

- **Explicit enable:** nothing is wired in until `settings.plugins[id].enabled` is true, except the repo-origin `defaultEnabled` case: when `origin === "repo"` AND `manifest.defaultEnabled` is true AND `settings.plugins[id]` is missing, the plugin auto-enables (this is how first-party `corbits-skills` is on out of the gate). An explicit `enabled: false` still disables. Marketplace (user / project / path / claude) `defaultEnabled` is ignored — those plugins stay opt-in. `command` → `registerCommandPlugins` registers slash commands (live on enable); `tool` → `resolveToolPlugins` instantiates `createToolPlugin(credentials)` and appends the tools to the posix toolset assembled in `src/tui/runner.ts` (via `tools.ts` helpers). `web` → `web_search`/`web_fetch` are now always-on core built-ins (`src/tools/web-search.ts`, `src/tools/web-fetch.ts`), not plugin-backed; a discovered `kind: "web"` plugin is retained for brand-display resolution only (`resolveWebProviderFromPlugins`/`webBrand` in `src/web/plugin-provider.ts`) and no longer supplies the tool implementation.
- **Tool consent:** a `tool` plugin runs in-process, so it is wired in only when enabled AND `consented`. The `/plugins` UI prompts a one-time y/n consent recorded in `settings.plugins[id].consented`.
- Configure via `/plugins`, which writes `settings.plugins` (enabled / consented / credentials), `settings.web`, and `settings.pluginPaths` to the global settings file. Credentials live in the global file because it carries secrets — the project-local settings file rejects credential keys. When a web plugin is active its tool calls render under its brand (e.g. "Exa Search"). Example: `{ "web": "exa", "plugins": { "exa": { "enabled": true, "credentials": { "apiKey": "..." } } } }`.

## Hardening wave — deferred and upstream-owned items

Corbits Code v0.3 memory and stall hardening is implemented under `src/`, `tests/`, and `scripts/` only. The `vendor/` tree is out of scope for that wave (`scripts/verify-corbits-only-scope.sh` enforces this on landing branches). The items below were **not** closed in Corbits Code because they do not apply to the default CLI/TUI path or require upstream Interchange packages.

### Child-supervisor IPC awaiter deadlines

| Field                                           | Detail                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**                                      | Not applicable in Corbits Code; deferred to upstream Interchange                                                                                                                                                                                                                                                                                                                                                 |
| **Risk**                                        | Cross-process tool handlers can hang indefinitely when a supervisor reply is lost or stalled (mail submit, substrate write, pack transfer ack paths).                                                                                                                                                                                                                                                            |
| **Why Corbits Code-only scope cannot close it** | Corbits Code does not run the workflow-host child supervisor or pack-transport sender loops. There is no `src/` surface that registers pending IPC awaiters for `outbound.result`, `substrate.write.response`, or `repo.pack.ack`. Chat and sub-agent sessions use in-process `@intx/agent` reactors, not the child bridges under `interchange/packages/workflow-host` or `interchange/packages/pack-transport`. |
| **Upstream owner**                              | Interchange `workflow-host` (outbound mail and substrate write bridges) and `pack-transport` (pack sender). Deadline behavior should align with existing gated correlation timeouts in the supervisor stack.                                                                                                                                                                                                     |
| **Operator note**                               | Corbits Code operators are not exposed to this stall vector unless a future product mode embeds workflow-host children; track closure in Interchange, not in this repo.                                                                                                                                                                                                                                          |

### Bounded audit collector retention between checkpoints

| Field                                           | Detail                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Status**                                      | Not applicable on the default path; deferred until real audit persistence is enabled                                                                                                                                                                                                      |
| **Risk**                                        | A live audit collector that buffers full tool results in memory until `flush()` on checkpoint/shutdown can grow without bound on long, checkpoint-sparse runs.                                                                                                                            |
| **Why Corbits Code-only scope cannot close it** | Production agent setup wires `noopAuditStore()` from `@intx/agent/testing` in `src/tui/runner.ts` and `src/subagent/index.ts`. No `AuditCollector` from `@intx/inference` is instantiated, so bounding `completed` retention in `audit-collector` does not change shipped behavior today. |
| **Upstream owner**                              | `@intx/inference` audit collector (`audit-collector` module): opportunistic flush or capped result bodies while preserving metadata.                                                                                                                                                      |
| **Future Corbits Code work**                    | If settings later select a persistent audit store, add a bounded wrapper or configuration in `src/` and re-run hardening tests; until then, document the noop path only.                                                                                                                  |

Other wave items (read bounds, shell truncation, process-group kill, grep caps, plugin spawn mitigation, per-tool watchdog, inference retry UX) are implemented or partially mitigated in `src/` with co-located tests; only the two rows above remain upstream or product-gated.

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
- **`tests/fixtures/`** holds fixture repos and comparison assets (e.g. `demo-comparison/`, `multi-file-service/`).
- **`tests/integration/`** holds the reactor permission / multi-turn harness (scripted models via `@intx/inference-testing`). **`tests/e2e/`** (fixture-repo runs) is still planned. Until e2e exists, broader harness coverage also lives in co-located `*.test.ts` files and `tests/unit/`.
- **Capability evals** (`evals/capability/`) are **not** the integration harness: they drive the product path (`corbits exec` / `runExec`) with real models against fixture copies and objective `verify.sh` graders. Case format + loader tests live under `evals/capability/`; run with `bun run eval:capability` (see `evals/capability/README.md`). Use `--baseline` to detect improve/regress across models or commits.
- **TUI tests** are co-located `*.test.ts` files under `src/tui/` (e.g. `shell.test.ts`, `runner-host.test.ts`, `stream.test.ts`), run as part of `bun test` along with everything else; there is no separate `test:tui` script or test-setup preload.

## Deployment

- Single bundled entry: `./dist/index.js`
- CLI name: `corbits`
- Self-contained: runtime dependencies are workspace-linked or bundled; no container or orchestration required
