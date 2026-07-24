# Plugin Design System

Status: **implemented** — the unified, manifest-driven system described below is
in place. Plugins self-describe with a `manifest` (`kind: web | command | tool`),
are auto-discovered (plus explicit `pluginPaths`), are wired in only when
explicitly enabled, and are managed through the `/plugins` UI. The sections
below double as the reference for the system and the record of why it is shaped
this way. (The "Current state (the problem)" section is retained as the
historical motivation.)

## Trust model (untrusted repo)

Plugin **code execution** is gated by origin. Clone-and-run of a foreign repo
must not import project-local plugins or path plugins until the operator trusts
that absolute path.

| Origin | Path | Auto-trusted? |
|---|---|---|
| `repo` | Product-shipped `plugins/` next to the Intercode binary | Yes |
| `user` | `~/.intercode/plugins/` | Yes (user home) |
| `user` (Claude) | Absolute `installPath` under `~/.claude/plugins/` from `installed_plugins.json` when `settings.discoverClaudePlugins` is true | Yes (user home; still disabled until enable; data-only load only) |
| `project` | `<cwd>/.intercode/plugins/` | **No** — path-bound trust |
| `path` | `settings.pluginPaths` entries | **No** — path-bound trust |


Untrusted `project` / `path` plugins are discovered as **metadata-only**: the
loader reads `manifest.json` (or equivalent) but does **not** `import()` the
module and does **not** load markdown agents/commands. Enabling a listed
project plugin in `/plugins`, or adding a path via the UI, records trust in
`<cwd>/.intercode/trust.json` (gitignored) and full-loads the module.

Tool-plugin `consented` remains a separate gate for **in-process tool**
activation after the module is trusted and loaded.

See also `docs/MCP.md` — local MCP servers from `.intercode/settings.json` use
the same trust file (fingerprints) and fail closed when headless.

## Goals

- One contract a plugin author learns once, regardless of what the plugin does.
- One discovery path and one place that decides how a plugin is wired in.
- One config surface (`settings.plugins`) and one UI (`/plugins`) for every
  plugin kind — enable/disable, credentials, verify, kind-specific selection.
- No silent dead paths; no "same word, two pipelines."

## Current state (the problem)

Five mechanisms, three loading models, one manifest that only governs one kind.

| Mechanism | Entry contract | Loads via | Config | Manifest | UI |
|---|---|---|---|---|---|
| ToolPlugin (`@intx/tools-posix`) | `ToolPlugin` | wired in `src/tui/runner.tsx` / `tools.ts` | — | no | no |
| WorkflowPlugin | `plugin` / default | `settings.workflowPlugins: string[]` → `loadWorkflowPlugins` | specifier array | no | no |
| AgentPlugin | `plugin` / default | `settings.agentPlugins: string[]` → `loadAgentPlugins` | specifier array | no | no |
| CommandPlugin | `commandPlugin` | directory discovery | discovery only | no | no |
| Web provider | `createWebProvider` + `manifest` | discovery + `pluginPaths` | `settings.plugins` / `settings.web` | **yes** | **`/plugins`** |

Concrete problems, with file references:

1. **Two unrelated loading models.** Workflow/agent load from settings
   *specifier arrays*; command/web load from *directory discovery* (plus the new
   `pluginPaths`). Same concept, two code paths.
2. **A dead path.** `src/plugins/loader.ts` captures `workflowPlugin` from a
   discovered module, but `src/tui/runner.tsx` only registers `commandPlugin`
   from discovered modules — a discovered workflow plugin is silently dropped.
3. **Manifest governs only web.** `kind: "workflow" | "command"` exist in the
   type (`src/plugins/manifest.ts`) but nothing routes by them; command plugins
   register with or without a manifest; workflow/agent ignore manifest entirely.
4. **Config / credentials / verify / UI are web-only** by accident of where the
   work began (`settings.plugins`, `settings.web`, `/plugins`).
5. **ToolPlugin — the richest extension point — is not user-installable.**

Net: what exists is a *web-provider plugin system*, not *the* plugin system.

## Target design

### One manifest, kind-routed

Every installable plugin exports a `manifest`. `kind` decides how it is wired.
The taxonomy is deliberately small — **`web | command | workflow | tool | agent`**:

```ts
export type PluginKind = "web" | "command" | "workflow" | "tool" | "agent";

export type PluginManifest = {
  id: string;                 // stable, unique (e.g. "exa")
  name: string;               // display ("Exa Search")
  kind: PluginKind;           // routes registration
  description?: string;
  credentials?: PluginCredentialField[]; // collected + stored per id
};
```

Workflow recipe names are **not** registered as top-level `/scope` slashes; an integration plugin owns the command prefix (e.g. a `kind: "workflow"` plugin → `/mywf scope`) and contributes workflow definitions beside the plugin under `plugins/<name>/src/workflows/`. Types live in `src/workflows/definition.ts`.

`agent` plugins contribute dispatchable profiles rather than commands. A command or workflow can still fan out to one subagent or a fleet through the normal `task` surface.

The kind-specific export is the implementation hook:

| kind | export | wired into | purpose |
|---|---|---|---|
| `web` | `createWebProvider(credentials)` | web_search/web_fetch backend | override the web tools (a specialized tool override) |
| `command` | `commandPlugin` | slash-command registry | slash commands |
| `workflow` | `workflowPlugin` + optional `commandPlugin` | workflow registry + slash-command registry | named workflow recipes behind an integration command prefix |
| `tool` | `toolPlugin` (factory) | posix toolset | add new agent tools (highest trust) |
| `agent` | `agentPlugin` | sub-agent profiles | contribute `task`-dispatchable agent profiles |

A module with no valid manifest is ignored (not silently half-loaded).

### One discovery pipeline

```
discoverPlugins(cwd) =
    repo plugins/         (built-in)
  + <cwd>/.intercode/plugins/
  + ~/.intercode/plugins/
  + settings.pluginPaths  (explicit file/dir paths, added via /plugins)
  + [opt-in] ~/.claude/plugins/installed_plugins.json
      when settings.discoverClaudePlugins is true
```

Claude Code marketplace installs are **opt-in**. When `discoverClaudePlugins` is
true, Intercode reads the Claude install registry (not a full cache walk) and
loads each **absolute** `installPath` that resolves under `~/.claude/plugins/`
as **data-only** (markdown agents/commands — no JS `import()` at discovery).
Relative install paths and paths outside that root are ignored so a poisoned
registry cannot load project trees as origin `user`. Profile `source: "claude"`.
Discovered modules still require `settings.plugins[id].enabled` before agents or
tools wire into the session. `search_agents` labels those profiles with
`[source: claude]`. JS Claude plugins (if any) stay on explicit `pluginPaths`.

`settings.workflowPlugins` / `settings.agentPlugins` (specifier arrays) become
thin aliases: at load they are appended to `pluginPaths` and flow through the
same pipeline. They are kept for back-compat for one release, then removed.

### One registration switch

A single function consumes the discovered `PluginModule[]` and routes by
`manifest.kind` to the right registry — replacing the scattered
`registerCommandPlugin` loop, `loadWorkflowPlugins`, `loadAgentPlugins`, and the
web `collectWebPlugins` call. One place to read, one place to extend.

### One config shape

```jsonc
{
  "plugins": {
    "exa": { "enabled": true, "credentials": { "apiKey": "..." } },
    "my-workflow": { "enabled": false }
  },
  "pluginPaths": ["/abs/path/to/plugin"],
  "web": "exa"          // kind-selector: which web plugin is active
}
```

- `settings.plugins[id]` (enabled + credentials) applies to **all** kinds.
- Credentials live in the **global** settings file (it carries secrets); the
  project-local settings file rejects credential keys by design.
- `settings.web` is the first kind-selector. If other kinds later need
  "exactly one active" semantics, generalize to `settings.active[kind] = id`.

### One UI

`/plugins` lists **every** discovered plugin grouped by kind, and for each:
enable/disable, edit declared credentials (masked), verify (kind-specific:
web = trial search; others = load/contract check), and the kind-selector toggle
where relevant (web override). Add-by-path (`a`) already exists. Everything
persists to global settings immediately.

## Implemented capabilities

### Web providers

Manifest type, `kind`, `settings.plugins` / `web` / `pluginPaths`, web
resolution, tool-name branding, `/plugins` UI, and add-by-path. Web is the
first kind-selector surface; other kinds share the same discovery and settings
shape.

### Command plugins and enable gating

- `command` plugins (`commandPlugin` export) register their slash commands only
  when `settings.plugins[id].enabled` is true, via `registerCommandPlugins`
  (`src/plugins/register.ts`); enabling one in `/plugins` wires it in live.
- Commands may also be authored as data-only markdown (see below).
- Legacy `settings.workflowPlugins` / `agentPlugins` specifier arrays and their
  loaders are removed; everything flows through discovery + `pluginPaths`.

### Tool plugins with consent

- `kind: "tool"` plugins export `createToolPlugin(credentials)` and contribute
  posix `ToolPlugin`s, resolved in `src/plugins/tool-plugins.ts` and wired into
  the toolset in `src/tui/runner.tsx` and `tools.ts` (appended last, so they cannot
  shadow core middleware).
- A tool plugin is wired in only when **enabled AND consented**. Enabling one in
  `/plugins` prompts a one-time y/n consent recorded in `settings.plugins[id]`.
- Per-kind verify in `/plugins` covers web (trial search) and tool (load check).
- `plugins/example-tool` is a worked example of a `tool` plugin.

### Agent plugins

- `agent` plugins (`agentPlugin` export) contribute `AgentProfile`s that the
  `task` tool can dispatch to, resolved in `src/plugins/agent-plugins.ts` and
  merged into the profile registry alongside local `.agents/agents/` profiles.
- **Data-only agent plugins** — a directory with `agents/*.md` (or flat `*.md`)
  and optional `skills/<name>/SKILL.md` needs no `index.ts`; `loadDataOnlyAgentPlugin`
  synthesizes the same `agentPlugin` shape after frontmatter validation.
- An agent plugin is wired in only when `settings.plugins[id].enabled` is true
  (same gating as command plugins — no consent needed, since profiles are
  configuration data, not in-process code).
- Profile precedence: built-in defaults < plugin profiles < local
  `.agents/agents/*.json` (most specific wins on same-id conflicts).
- Per-kind verify in `/plugins` (agent = profile count check).
- Add-by-path (`a`) uses the same path suggestion UX as `@` mentions
  (`listPathSuggestions`) so registering a plugin from disk can browse directories.

### Data-only command plugins

- `command` plugins may be authored as pure markdown, the same convention as
  Claude Code (`.claude/commands/`), OpenCode (`.opencode/command/`), and Codex:
  a `commands/` directory where each file is a slash command. No `index.ts`.
- `loadDataOnlyCommands` (`src/plugins/data-only-commands.ts`) reads the files and
  synthesizes a `commandPlugin`. Two layouts:
  - `commands/<name>.md` → `/<name>` (flat). The body is sent to the agent, with
    `$ARGUMENTS` replaced by the args the user typed.
  - `commands/<ns>/<sub>.md` → `/<ns> <sub>` (namespaced). The first arg selects
    the subcommand file; the remaining args interpolate into its body.
- Frontmatter is optional. `description` populates the command list / `/help`;
  `argument-hint` (Claude Code field) is copied onto the command as free-form arg
  guidance and shown greyed in the slash picker next to the name and after
  `/cmd ` until the operator types real args (never inserted on Tab).
- A directory with commands and no agents is recognized as `kind: "command"`
  (inferred when no `manifest.json` is present; an explicit `manifest.json`
  always wins). `loadDataOnlyPlugin` (`src/plugins/data-only.ts`) unifies agent
  and command data loading and routes by kind, so `loadPluginEntry` has a single
  data-only entry point.

### Claude marketplace plugins and skill-commands

- Plugins authored for the Claude Code marketplace self-describe via
  `.claude-plugin/plugin.json` (`{ name, description?, ... }`, no `id`/`kind`).
  `readClaudePluginManifest` adapts it: `name` becomes `id`+`name`, `kind` is
  inferred from contents. A native `manifest.json` is always preferred when both
  exist. So a marketplace plugin (e.g. `agents/plugins/gaas`) loads as-is via
  `/plugins` add-by-path: its `agents/*.md` wire as profiles and its
  `skills/*/SKILL.md` resolve through `use_skill` with no porting.
- **Skill-commands.** Every skill in an enabled plugin is also surfaced as a
  `/<skill-name> [args]` slash command that sends the skill body (plus args) to
  the agent. `loadSkillCommands` (`src/plugins/skill-commands.ts`) synthesizes
  them; they merge into the same `commandPlugin` as `commands/*.md`. Frontmatter
  `argument-hint` is preserved so the TUI can show greyed arg guidance (e.g.
  `/linear-create` → `[description] [--from-doc]`). This is an additional
  surface: `discoverSkills` is unchanged, so the model can still auto-invoke any
  skill via `use_skill` — the slash command is a direct user entry point on top.
  (An earlier revision gated this on the `disable-model-invocation`/
  `user-invocable` frontmatter tags; that gate was dropped so untagged skills
  like `linear-create` are reachable too.)
- **Mixed plugins wire both sides.** A plugin contributing agents AND commands
  (the common marketplace shape) infers `kind: "agent"` so profiles wire, and
  `isEnabledCommandPlugin` (`src/plugins/register.ts`) also wires commands for
  `kind: "agent"` — commands are a low-trust, additive surface. `web`/`tool`
  kinds still do not auto-wire commands.

### Claude marketplaces

- A plugin path may point at a Claude Code marketplace: a directory with
  `.claude-plugin/marketplace.json` declaring `plugins: [{ name, source }]`.
  `expandPluginPath` (`src/plugins/loader.ts`) resolves each `source` (relative
  to the marketplace root) and loads it as its own plugin — one id, one enable
  toggle per member. A path with no marketplace.json but a `plugins/` subtree
  (and no single-plugin markers at its root) expands the same way, so a plain
  checkout works too. Point `/plugins` add-by-path at the marketplace root and
  every member appears; enable the ones you want.

## Decisions (locked)

1. **Specifier arrays removed now.** `settings.workflowPlugins` and
   `settings.agentPlugins` are dropped; everything comes through discovery +
   `settings.pluginPaths`.
2. **`settings.web` stays** as the only kind-selector for now; generalize to
   `settings.active[kind]` only if another kind needs "exactly one active."
3. **Always explicit enable.** Every discovered plugin (built-in or user-added)
   starts disabled. Nothing is wired in until `settings.plugins[id].enabled` is
   true — set in `/plugins`. (Note: this changes today's behavior where repo
   command plugins auto-load; they must now be enabled.)
4. **Tool plugins require explicit consent.** Enabling a `kind: "tool"` plugin
   prompts a one-time confirmation in `/plugins` before its tools are wired in
   (they run in-process — the highest-trust surface). Consent is recorded in
   `settings.plugins[id]`.

## Non-goals

- Remote/registry installation (`npm i` of plugins) — out of scope here.
- Sandboxing plugin code — plugins run in-process; that is a separate security
  workstream.
