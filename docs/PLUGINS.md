# Plugin Design System

Status: **proposal** — a plan to unify the several plugin mechanisms that grew
independently into one coherent, manifest-driven system. Nothing here is built
yet beyond the web-provider slice noted under "Current state."

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

Every installable plugin exports a `manifest`. `kind` decides how it is wired:

```ts
export type PluginKind = "web" | "workflow" | "command" | "agent" | "tool";

export type PluginManifest = {
  id: string;                 // stable, unique (e.g. "exa")
  name: string;               // display ("Exa Search")
  kind: PluginKind;           // routes registration
  description?: string;
  credentials?: PluginCredentialField[]; // collected + stored per id
};
```

The kind-specific export stays as the implementation hook:

| kind | export | wired into |
|---|---|---|
| `web` | `createWebProvider(credentials)` | web_search/web_fetch backend |
| `workflow` | `workflowPlugin` | workflow registry |
| `command` | `commandPlugin` | slash-command registry |
| `agent` | `agentPlugin` | agent-profile registry |
| `tool` | `toolPlugin` (factory) | posix toolset |

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

## Migration plan (phased, each phase ships independently)

**Phase 0 — land the web-provider slice (done / in review).**
Manifest type, `kind`, `settings.plugins`/`web`/`pluginPaths`, web resolution,
tool-name branding, `/plugins` UI, add-by-path. This is the seed the rest grows
from.

**Phase 1 — unify discovery + registration.**
- Add a single `registerDiscoveredPlugins(modules)` that routes by `kind`.
- Route discovered `workflow`/`command`/`agent` plugins through it (fixes the
  dead workflow-discovery path, problem #2).
- Fold `settings.workflowPlugins`/`agentPlugins` into `pluginPaths` as aliases.
- No behavior removed; specifier arrays still work.

**Phase 2 — manifest required for installable plugins.**
- Require a `manifest` for discovered plugins; route strictly by `kind`.
- Move workflow/agent plugins to declare manifests (update bundled ones).
- `/plugins` shows workflow/agent/command kinds with enable/disable + verify.

**Phase 3 — config + lifecycle unification.**
- `settings.plugins[id].enabled` honored for all kinds (disabled = not wired).
- Per-kind verify implementations.
- Deprecate `settings.workflowPlugins`/`agentPlugins` (warn), then remove.

**Phase 4 (optional, biggest) — user-installable ToolPlugins.**
- Allow `kind: "tool"` plugins to contribute posix tools at runtime.
- Gated behind permissions/authz review since tools are the highest-trust
  surface. Probably its own design pass.

## Open questions

1. Do we keep `settings.workflowPlugins`/`agentPlugins` as permanent aliases or
   remove them after a deprecation window?
2. `settings.web` now, or jump straight to `settings.active[kind]`?
3. Should `enabled` default to true for discovered repo/built-in plugins and
   false for user-added ones, or always require explicit enable?
4. How far do we trust `kind: "tool"` plugins — same permission gate as the
   agent, or a stricter install-time consent?

## Non-goals

- Remote/registry installation (`npm i` of plugins) — out of scope here.
- Sandboxing plugin code — plugins run in-process; that is a separate security
  workstream.
