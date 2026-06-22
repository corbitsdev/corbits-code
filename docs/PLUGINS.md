# Plugin Design System

Status: **implemented** — the unified, manifest-driven system described below is
in place. Plugins self-describe with a `manifest` (`kind: web | command | tool`),
are auto-discovered (plus explicit `pluginPaths`), are wired in only when
explicitly enabled, and are managed through the `/plugins` UI. The sections
below double as the reference for the system and the record of why it is shaped
this way. (The "Current state (the problem)" section is retained as the
historical motivation.)

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
| ToolPlugin (`@intx/tools-posix`) | `ToolPlugin` | hardcoded in `run-agent`/`tools.ts` | — | no | no |
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
The taxonomy is deliberately small — **`web | command | tool | agent`**:

```ts
export type PluginKind = "web" | "command" | "tool" | "agent";

export type PluginManifest = {
  id: string;                 // stable, unique (e.g. "exa")
  name: string;               // display ("Exa Search")
  kind: PluginKind;           // routes registration
  description?: string;
  credentials?: PluginCredentialField[]; // collected + stored per id
};
```

Why no `workflow`/`agent` kinds: **a workflow is just a slash command.** A
command can fan out to a single prompt, a series of prompts, one subagent, or a
fleet of agents — and it can be invoked by the user (slash) or chosen by the
agent. So orchestration lives behind a `command` plugin, not a separate kind.
Workflow recipe names are **not** registered as top-level `/scope` slashes; an integration plugin owns the prefix (e.g. `linear-workflows`, `kind: "workflow"` → `/linear scope`). Types live in `src/workflows/definition.ts`; definitions live beside the plugin under `plugins/<name>/src/workflows/`.
Subagents/fleets are an implementation detail of what a command does.

The kind-specific export is the implementation hook:

| kind | export | wired into | purpose |
|---|---|---|---|
| `web` | `createWebProvider(credentials)` | web_search/web_fetch backend | override the web tools (a specialized tool override) |
| `command` | `commandPlugin` | slash-command registry | slash commands, incl. workflow orchestration |
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
```

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

## Migration plan (all phases landed)

**Phase 0 — web-provider slice (done).**
Manifest type, `kind`, `settings.plugins`/`web`/`pluginPaths`, web resolution,
tool-name branding, `/plugins` UI, add-by-path. The seed the rest grew from.

**Phase 1 — command kind + enabled gating (done).**
- `command` plugins (`commandPlugin` export) register their slash commands only
  when `settings.plugins[id].enabled` is true, via `registerCommandPlugins`
  (`src/plugins/register.ts`); enabling one in `/plugins` wires it in live.
- The bundled `linear-workflows` plugin declares a manifest and is gated this way
  (it no longer auto-loads).
- Removed `settings.workflowPlugins`/`agentPlugins` and their loaders.

**Phase 2 — tool kind with consent (done).**
- `kind: "tool"` plugins export `createToolPlugin(credentials)` and contribute
  posix `ToolPlugin`s, resolved in `src/plugins/tool-plugins.ts` and wired into
  the toolset in `run-agent.ts` and `tools.ts` (appended last, so they cannot
  shadow core middleware).
- A tool plugin is wired in only when **enabled AND consented**. Enabling one in
  `/plugins` prompts a one-time y/n consent recorded in `settings.plugins[id]`.

**Phase 3 — polish (done).**
- Per-kind verify in `/plugins` (web = trial search; tool = load check).
- `plugins/example-tool` is a worked example of a `tool` plugin.

**Phase 4 — agent kind (done).**
- `agent` plugins (`agentPlugin` export) contribute `AgentProfile`s that the
  `task` tool can dispatch to, resolved in `src/plugins/agent-plugins.ts` and
  merged into the profile registry alongside local `.agents/agents/` profiles.
- An agent plugin is wired in only when `settings.plugins[id].enabled` is true
  (same gating as command plugins — no consent needed, since profiles are
  configuration data, not in-process code).
- Profile precedence: built-in defaults < plugin profiles < local
  `.agents/agents/*.json` (most specific wins on same-id conflicts).
- Per-kind verify in `/plugins` (agent = profile count check).

## Decisions (locked)

1. **Specifier arrays removed now.** `settings.workflowPlugins` and
   `settings.agentPlugins` are dropped; everything comes through discovery +
   `settings.pluginPaths`.
2. **`settings.web` stays** as the only kind-selector for now; generalize to
   `settings.active[kind]` only if another kind needs "exactly one active."
3. **Always explicit enable.** Every discovered plugin (built-in or user-added)
   starts disabled. Nothing is wired in until `settings.plugins[id].enabled` is
   true — set in `/plugins`. (Note: this changes today's behavior where repo
   command plugins like linear-workflows auto-load; they must now be enabled.)
4. **Tool plugins require explicit consent.** Enabling a `kind: "tool"` plugin
   prompts a one-time confirmation in `/plugins` before its tools are wired in
   (they run in-process — the highest-trust surface). Consent is recorded in
   `settings.plugins[id]`.

## Non-goals

- Remote/registry installation (`npm i` of plugins) — out of scope here.
- Sandboxing plugin code — plugins run in-process; that is a separate security
  workstream.
