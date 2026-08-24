# Plugin Design System

Status: **implemented** — the unified, manifest-driven system described below is
in place. Plugins self-describe with a `manifest` (`kind: web | command | tool`),
are auto-discovered (plus explicit `pluginPaths`), are wired in only when
explicitly enabled (with one exception: a repo-origin plugin whose manifest
sets `defaultEnabled: true` auto-enables when the settings key is missing),
and are managed through the `/plugins` UI. The sections
below double as the reference for the system and the record of why it is shaped
this way. (The "Current state (the problem)" section is retained as the
historical motivation.)

## Trust model (untrusted repo)

Plugin **code execution** is gated by origin. Clone-and-run of a foreign repo
must not import project-local plugins until the operator trusts that absolute
path in that working directory. Explicit path plugins are different: they are
registered in global settings (`pluginPaths`), so consent is global once granted.

| Origin          | Path                                                                                                                          | Auto-trusted?                                                     | Trust store                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | --------------------------------------------- |
| `repo`          | Product-shipped `plugins/` next to the source root, `dist/plugins`, or `dirname(execPath)/plugins` — never session cwd        | Yes                                                               | —                                             |
| `user`          | `~/.corbits/plugins/`                                                                                                         | Yes (user home)                                                   | —                                             |
| `user` (Claude) | Absolute `installPath` under `~/.claude/plugins/` from `installed_plugins.json` when `settings.discoverClaudePlugins` is true | Yes (user home; still disabled until enable; data-only load only) | —                                             |
| `project`       | `<cwd>/.corbits/plugins/`                                                                                                     | **No** — per working directory                                    | `~/.corbits/trust/<cwd-hash>.json`            |
| `path`          | `settings.pluginPaths` entries (add-by-path)                                                                                  | **No** until granted once                                         | `~/.corbits/trust/path-plugins.json` (global) |

Untrusted `project` / `path` plugins are discovered as **metadata-only**: the
loader reads `manifest.json` (or equivalent) but does **not** `import()` the
module and does **not** load markdown agents/commands. Enabling a listed
project plugin in `/plugins` records project trust for that cwd; adding a path
via the UI (or enabling a path stub) records global path trust and full-loads
the module. Path trust survives opening a different project directory; project
trust does not. The `/plugins` UI shows a **needs trust** badge when a listed
plugin is still metadata-only.

**Path trust store properties.** Three properties of
`~/.corbits/trust/path-plugins.json` are load-bearing:

- **Path-keyed, no content binding.** A grant is the lexically resolved
  absolute path, deliberately without `realpath` and without any hash of the
  plugin's contents. The grant covers the _location_, machine-wide: whatever
  code sits at that path (including after a symlink retarget or an update in
  place) runs once trusted. This matches the consent model — the user vouches
  for a directory they registered, not for a snapshot of its bytes — and keeps
  grants stable across plugin updates. Anyone who can write to a trusted path
  can execute code; register paths you control.
- **Revocable.** Press `r` on a trusted path plugin in `/plugins` to withdraw
  its grant; the plugin drops to metadata-only and is disabled. Revocation
  rewrites the store file in place — the file itself always survives.
- **Deleting the file re-seeds.** A missing (or invalid) `path-plugins.json`
  re-triggers the one-shot migration below, which re-grants every registered
  `pluginPaths` entry. Deleting the file is therefore **not** a revocation
  mechanism — use `/plugins` → `r`, or remove the entry from `pluginPaths`.

Only absolute paths are accepted: non-absolute store entries are dropped at
load and grant calls reject them, so nothing ever resolves against an
incidental working directory.

**Migration:** On first run after this split, if `path-plugins.json` does not
exist or does not parse, Corbits Code seeds global path trust from existing
`pluginPaths` entries (expanding marketplace roots to members that exist on
disk) and prints a one-line notice naming how many plugins were granted.
Registration in global settings is taken as consent — every entry that exists
on disk is granted, including hand-edited ones never confirmed through the UI;
per-cwd project trust stores are not consulted. The migration also runs (and
writes the store) in headless `corbits exec`: `pluginPaths` is user-global
input, not repo-controlled, so the fail-closed rule for repo-supplied config
does not apply to it. After the file exists, new marketplace members and
hand-edited paths stay metadata-only until granted via the UI.

Tool-plugin `consented` remains a separate gate for **in-process tool**
activation after the module is trusted and loaded.

See also `docs/MCP.md` — local MCP servers from project settings use the
per-cwd trust file (fingerprints) and fail closed when non-interactive
(`corbits exec`); the global path-plugin store described here is separate and
never gates MCP.

## Goals

- One contract a plugin author learns once, regardless of what the plugin does.
- One discovery path and one place that decides how a plugin is wired in.
- One config surface (`settings.plugins`) and one UI (`/plugins`) for every
  plugin kind — enable/disable, credentials, verify, kind-specific selection.
- No silent dead paths; no "same word, two pipelines."

## Current state (the problem)

Five mechanisms, three loading models, one manifest that only governs one kind.

| Mechanism                        | Entry contract                   | Loads via                                                    | Config                              | Manifest | UI             |
| -------------------------------- | -------------------------------- | ------------------------------------------------------------ | ----------------------------------- | -------- | -------------- |
| ToolPlugin (`@intx/tools-posix`) | `ToolPlugin`                     | wired in `src/tui/runner.ts` / `tools.ts`                    | —                                   | no       | no             |
| WorkflowPlugin                   | `plugin` / default               | `settings.workflowPlugins: string[]` → `loadWorkflowPlugins` | specifier array                     | no       | no             |
| AgentPlugin                      | `plugin` / default               | `settings.agentPlugins: string[]` → `loadAgentPlugins`       | specifier array                     | no       | no             |
| CommandPlugin                    | `commandPlugin`                  | directory discovery                                          | discovery only                      | no       | no             |
| Web provider                     | `createWebProvider` + `manifest` | discovery + `pluginPaths`                                    | `settings.plugins` / `settings.web` | **yes**  | **`/plugins`** |

Concrete problems, with file references:

1. **Two unrelated loading models.** Workflow/agent load from settings
   _specifier arrays_; command/web load from _directory discovery_ (plus the new
   `pluginPaths`). Same concept, two code paths.
2. **A dead path.** `src/plugins/loader.ts` captures `workflowPlugin` from a
   discovered module, but `src/tui/runner.ts` only registers `commandPlugin`
   from discovered modules — a discovered workflow plugin is silently dropped.
3. **Manifest governs only web.** `kind: "workflow" | "command"` exist in the
   type (`src/plugins/manifest.ts`) but nothing routes by them; command plugins
   register with or without a manifest; workflow/agent ignore manifest entirely.
4. **Config / credentials / verify / UI are web-only** by accident of where the
   work began (`settings.plugins`, `settings.web`, `/plugins`).
5. **ToolPlugin — the richest extension point — is not user-installable.**

Net: what exists is a _web-provider plugin system_, not _the_ plugin system.

## Target design

### One manifest, kind-routed

Every installable plugin exports a `manifest`. `kind` decides how it is wired.
The taxonomy is deliberately small — **`web | command | workflow | tool | agent`**:

```ts
export type PluginKind = "web" | "command" | "workflow" | "tool" | "agent";

export type PluginManifest = {
  id: string; // stable, unique (e.g. "exa")
  name: string; // display ("Exa Search")
  kind: PluginKind; // routes registration
  description?: string;
  credentials?: PluginCredentialField[]; // collected + stored per id
};
```

Workflow recipe names are **not** registered as top-level `/scope` slashes; an integration plugin owns the command prefix (e.g. a `kind: "workflow"` plugin → `/mywf scope`) and contributes workflow definitions beside the plugin under `plugins/<name>/src/workflows/`. Types live in `src/workflows/definition.ts`.

`agent` plugins contribute dispatchable profiles rather than commands. A command or workflow can still fan out to one subagent or a fleet through the normal `task` surface.

The kind-specific export is the implementation hook:

| kind       | export                                      | wired into                                 | purpose                                                     |
| ---------- | ------------------------------------------- | ------------------------------------------ | ----------------------------------------------------------- |
| `web`      | `createWebProvider(credentials)`            | web_search/web_fetch backend               | override the web tools (a specialized tool override)        |
| `command`  | `commandPlugin`                             | slash-command registry                     | slash commands                                              |
| `workflow` | `workflowPlugin` + optional `commandPlugin` | workflow registry + slash-command registry | named workflow recipes behind an integration command prefix |
| `tool`     | `toolPlugin` (factory)                      | posix toolset                              | add new agent tools (highest trust)                         |
| `agent`    | `agentPlugin`                               | sub-agent profiles                         | contribute `task`-dispatchable agent profiles               |

A module with no valid manifest is ignored (not silently half-loaded).

### One discovery pipeline

```
discoverPlugins(cwd) =
    repo plugins/         (built-in: source root / dist/plugins / dirname(execPath)/plugins — never session cwd)
  + <cwd>/.corbits/plugins/
  + ~/.corbits/plugins/
  + settings.pluginPaths  (explicit file/dir paths, added via /plugins)
  + [opt-in] ~/.claude/plugins/installed_plugins.json
      when settings.discoverClaudePlugins is true
```

Claude Code marketplace installs are **opt-in**. When `discoverClaudePlugins` is
true, Corbits Code reads the Claude install registry (not a full cache walk) and
loads each **absolute** `installPath` that resolves under `~/.claude/plugins/`
as **data-only** (markdown agents/commands — no JS `import()` at discovery).
Relative install paths and paths outside that root are ignored so a poisoned
registry cannot load project trees as origin `user`. Profile `source: "claude"`.
Discovered modules still require `settings.plugins[id].enabled` before agents or
tools wire into the session. `search_agents` labels those profiles with
`[source: claude]` and injects each profile's full loaded system prompt / body so
the parent never needs `read_file` on `~/.claude/plugins/...` (path-escape still
blocks those roots for path tools; writes/deletes outside cwd stay denied). JS
Claude plugins (if any) stay on explicit `pluginPaths`.

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
    "my-workflow": { "enabled": false },
  },
  "pluginPaths": ["/abs/path/to/plugin"],
  "web": "exa", // kind-selector: which web plugin is active
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
  when the plugin is enabled, via `registerCommandPlugins`
  (`src/plugins/register.ts`); enabling one in `/plugins` wires it in live.
  Enablement is `settings.plugins[id].enabled === true`, except the Decision 3
  repo-origin `defaultEnabled` case below (the first-party `corbits-skills`
  catalog auto-enables when the settings key is missing).
- Commands may also be authored as data-only markdown (see below).
- Legacy `settings.workflowPlugins` / `agentPlugins` specifier arrays and their
  loaders are removed; everything flows through discovery + `pluginPaths`.

### Tool plugins with consent

- `kind: "tool"` plugins export `createToolPlugin(credentials)` and contribute
  posix `ToolPlugin`s, resolved in `src/plugins/tool-plugins.ts` and wired into
  the toolset in `src/tui/runner.ts` and `tools.ts` (appended last, so they cannot
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
- **Skill refs on agent frontmatter / body.** A skill name is either:
  - **Bare** — `style`, `philosophy`, or a namespaced `plugin:style`. Resolved by
    searching the plugin's `skills/` dir first, then project-local fallbacks
    (`.agents/skills`, `.claude/skills`, `.codex/skills`). Prefer bare names for
    co-located skills; they are the portable, discoverable form.
  - **Path-like** — `./skills/style`, `skills/style`, `../sibling-skill`, or any
    ref containing `/` (including a trailing `SKILL.md`). Resolved only under the
    plugin root (`pluginRoot`), with lexical containment plus a realpath check so
    a symlink under the root cannot escape. Absolute paths, bare `.` / `..`, and
    escapes outside the root are rejected (skill miss, not a crash).
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
- **Skill-commands.** Skills in an enabled plugin are also surfaced as a
  `/<skill-name> [args]` slash command that sends the skill body (plus args) to
  the agent, unless frontmatter sets `user-invocable: false`. `loadSkillCommands`
  (`src/plugins/skill-commands.ts`) synthesizes them and skips that tag; they
  merge into the same `commandPlugin` as `commands/*.md`. Untagged skills still
  become slashes (marketplace backward compatibility). Frontmatter
  `argument-hint` is preserved so the TUI can show greyed arg guidance (e.g.
  `/create-issue` → `[description] [--from-doc]`). This is an additional
  surface: `discoverSkills` skips skills with `disable-model-invocation: true`
  from the lazy listing (those stay loadable via explicit `use_skill` /
  `resolveSkillBody`), so the model does not auto-suggest background libraries.
  First-party recipes that are not operator slashes remain listed for
  `use_skill` when they only set `user-invocable: false` (`dispatch`,
  `git-rebase`, `linear-issue-workflow`, `style`, `philosophy`, `typescript`,
  `opsh`). Background libs such as `git-worktrees` set both flags. The slash
  command is a direct user entry
  point on top.
- **First-party catalog.** `plugins/corbits-skills/` (id `corbits-skills`,
  kind `command`, `defaultEnabled: true`) is the bundled skill catalog. Origin
  `repo` is auto-trusted. Auto-enable applies only when `origin === "repo"` AND
  `manifest.defaultEnabled` AND the settings key is missing; an explicit
  `enabled: false` still disables. Marketplace `defaultEnabled` is ignored.
  The id is not `gaas`, so a later marketplace plugin named gaas cannot replace
  the module. Slash-command registration is first-wins (built-ins, then plugins
  in discovery order: repo before user/project/path), so `/implement` stays
  first-party when both the catalog and a marketplace plugin are enabled.
  `discoverSkills` is already first-wins (plugin dirs before project).
- **Mixed plugins wire both sides.** A plugin contributing agents AND commands
  (the common marketplace shape) infers `kind: "agent"` so profiles wire, and
  `isEnabledCommandPlugin` (`src/plugins/register.ts`) also wires commands for
  `kind: "agent"` — commands are a low-trust, additive surface. `web`/`tool`
  kinds still do not auto-wire commands.

### Claude marketplaces

- A plugin path may point at a Claude Code marketplace: a directory with
  `.claude-plugin/marketplace.json` declaring `plugins: [{ name, source }]`.
  `expandPluginPath` (`src/plugins/loader.ts`) resolves each `source` relative
  to the marketplace root and loads it as its own plugin — one id, one enable
  toggle per member. A path with no marketplace.json but a `plugins/` subtree
  (and no single-plugin markers at its root) expands the same way, so a plain
  checkout works too. Point `/plugins` add-by-path at the marketplace root and
  every member appears; enable the ones you want.

#### Supported marketplace `source` forms

| Form                                                             | Allowed?                               | Notes                                                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `./plugins/<name>`                                               | Yes                                    | Under the marketplace root                                                                                                                                                                                                                                                                                                      |
| `../agents/<name>` (and deeper relatives under the contain root) | Yes, when still under the contain root | **Claude installs:** contain root is `~/.claude/plugins` (so `../agents/x` from a marketplace under that tree is allowed). **Path / `pluginPaths` marketplaces:** contain root is the **parent** of the marketplace directory — any relative that resolves under that parent tree is allowed (multi-level, not one-level-only). |
| Absolute path (`/…`, `C:\…`)                                     | No                                     | Rejected; reported as skip reason `absolute`                                                                                                                                                                                                                                                                                    |
| Relative escape outside the contain root                         | No                                     | Rejected; reported as skip reason `outside-contain-root`                                                                                                                                                                                                                                                                        |
| Symlink under the contain root that realpaths outside it         | No                                     | Existing candidates and the contain root are `realpath`'d before the final contain check (same idea as `list_dir`); lexical-only paths that do not exist yet keep the lexical check                                                                                                                                             |
| Missing on-disk path                                             | No                                     | Reported as skip reason `missing`; other members still load                                                                                                                                                                                                                                                                     |

Skipped sources are never silent: `expandPluginPath` reports every skip (default:
stderr; Claude discovery also accepts `onExpandSkip` for tests/callers; path /
`pluginPaths` expansion uses the same default). Partial failure does not block
other members. When a `marketplace.json` catalog is present and every member is
skipped (or none survive on disk), expansion returns an empty list — it does not
fall through to the layout heuristic or treat the marketplace root as a single
plugin. Each resolved member path is still subject to path-plugin trust when
loaded via `pluginPaths`.

## Decisions (locked)

1. **Specifier arrays removed now.** `settings.workflowPlugins` and
   `settings.agentPlugins` are dropped; everything comes through discovery +
   `settings.pluginPaths`.
2. **`settings.web` stays** as the only kind-selector for now; generalize to
   `settings.active[kind]` only if another kind needs "exactly one active."
3. **Explicit enable, with one repo-origin exception.** Every discovered plugin
   starts disabled unless all of the following hold: `origin === "repo"`,
   `manifest.defaultEnabled` is true, and `settings.plugins[id]` is missing.
   Then it auto-enables. An explicit `enabled: false` still disables. Marketplace
   (user / project / path / claude) `defaultEnabled` is ignored — those plugins
   stay opt-in via `/plugins`. The first-party catalog `plugins/corbits-skills/`
   (id `corbits-skills`) is the plugin this exception exists for.
4. **Tool plugins require explicit consent.** Enabling a `kind: "tool"` plugin
   prompts a one-time confirmation in `/plugins` before its tools are wired in
   (they run in-process — the highest-trust surface). Consent is recorded in
   `settings.plugins[id]`.

## Non-goals

- Remote/registry installation (`npm i` of plugins) — out of scope here.
- Sandboxing plugin code — plugins run in-process; that is a separate security
  workstream.
