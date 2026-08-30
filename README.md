# Corbits Code

Corbits Code is a local agentic software factory: a single-process coding agent
CLI that runs multi-agent fleets to implement, verify, and land software — with
progress and cost always visible. Point it at Anthropic, OpenAI, Google, a local
Ollama, or any OpenAI-compatible endpoint. Your machine, your keys, your code.

The product is the **harness** — the loop that dispatches work, watches it,
decides what happens next, and reports to the operator. Agent personas and
skills are content that run inside it.

## Quickstart

### Homebrew (macOS / Linux)

```sh
brew install corbitsdev/tap/corbits-code
```

Upgrade later with `brew update && brew upgrade corbits-code`. The CLI binary is
`corbits`.

### From source

[Bun](https://bun.sh) v1.2+ is required.

```sh
git clone https://github.com/corbitsdev/corbits-code.git
cd corbits-code
bun install
bun run start
```

`bun run start` builds and launches Corbits Code in your terminal.

Optionally, compile a standalone binary and put it on your PATH:

```sh
bun run build:bin   # produces dist/corbits
ln -s "$PWD/dist/corbits" ~/.local/bin/corbits
```

After pulling new changes, re-run `bun run build:bin` to refresh the binary.

## Usage

### TUI (default)

```sh
corbits "Add JWT auth to the API"
```

Full-screen terminal UI (OpenTUI): event log, permission and operator prompts,
diff and cost visibility, and a chat input for follow-ups. Press **Shift+Tab**
to cycle reasoning effort for the current model; **Tab** toggles focus between
the prompt and the transcript. See `docs/TUI.md`.

### Exec (non-TUI)

```sh
corbits exec "Add JWT auth to the API"
# alias:
corbits run "Add JWT auth to the API"
```

Same directors, tools, permissions, MCP, plugins, and hooks as the TUI — without
the OpenTUI shell. Streams assistant text to stdout for scripts and CI.

### Resume

```sh
corbits resume
# or:
corbits resume <session-id>
```

Plain `corbits` always starts a fresh conversation. `corbits resume` opens a
picker of saved sessions for the working directory.

### Mid-run steering

While a run is in progress:

- **Enter** — soft-steer while the parent is busy (in-flight tool / `wait_agents`); starts a new primary turn when the parent is idle with a fleet still running
- **Alt+Enter** — queue a follow-up delivered when the whole session is idle
- **Ctrl+C** — interrupt the run

Shortcuts are listed in `/help`. Details live in `docs/PRODUCT.md`.

## Permissions and auto mode

Corbits Code defaults to **auto mode** (`auto = true`). Workspace file
writes/edits/deletes and unconstrained shell commands run without per-action
prompts. Pass `--no-auto` to start in ask-on-every-consequential-action mode
(there is currently no in-session key to toggle auto).

### What auto allows

- File tools inside the workspace: `write_file`, `edit_file`, `delete_file` (and
  other non-shell built-ins such as `manage_tasks`, `task`, …)
- Unconstrained shell (builds, tests, git, one-off commands that match no
  deny/ask rule)
- Read-only tools (`read_file`, `grep`, `search_files`, `list_dir`, `lsp`, …)
  always allow regardless of mode

### What still asks (even in auto)

- Dependency installs and remote runners (`npm install` / `i` / `ci` / `add`,
  `pip install`, `cargo add`, `brew install`, `npx` / `bunx`, …)
- Recursive `rm` (`-r` / `-R` / `--recursive`)
- Force or uncontained git worktree add/remove/prune (contained non-force
  add/remove/prune and read-only `git worktree list` auto-allow)
- Shell that references sensitive paths (`.env`, private keys, certs, credential
  files, …)
- Opaque shell wrappers the policy cannot statically inspect (variable expansion
  or command substitution in a wrapper payload)
- Paths outside the workspace, writes under the session state root, mutating MCP
  tools, and unknown built-ins

### What auto hard-denies (use the file tools instead)

- File creation or edits via shell: redirects (`>` / `>>`), `tee`, `sed -i` /
  `perl -i` / similar, interpreter inline programs or heredocs (`python -c`,
  `node -e`, …)

Wrappers such as `bash -c '…'`, `sh`/`zsh -c`, `xargs`, and transparent prefixes
(`env`, `nice`, `timeout`) are peeled so the same rules apply to the inner
command. Unparseable wrappers fall through to ask rather than auto-allow.

Catastrophic patterns (`rm -rf /`, `sudo`, `curl | bash`, force-push, open-ended
`find`/`rg`/`grep -r`, …) are always denied by authorization, independent of
auto mode. `--dangerously-skip-permissions` still forces this process; `/yolo`
persists as the user-global default. Both bypass the permission gate (not
secret-guard path denies or authz hard blocks).

Details live in `docs/PRODUCT.md` (safety model) and `docs/ARCHITECTURE.md`
(permission gate and auto-shell policy).

## Stack

- **Runtime:** Bun + TypeScript
- **Agent loop:** `@intx/agent` with an event-driven reactor
- **Inference:** `@intx/inference` (vendored) with OpenAI-compatible adapters
- **Tools:** `@intx/tools-posix` and `@intx/tools-lsp`
- **Authz:** `@intx/authz` for grant matching; Corbits owns the gate, store, and TUI ask
- **Persistence:** `@intx/storage-isogit` for git-backed resume
- **MCP:** Model Context Protocol SDK for external tool servers
- **TUI:** OpenTUI (`@opentui/core`, `@opentui/solid`)

## Architecture

Corbits Code is a single-process CLI built on Interchange primitives. The primary
session is always the **orchestrator** (Skywalker): it can act directly and
delegates substantial work through a closed director fleet via `spawn_agent` /
`wait_agents` / `search_agents` (`task` remains a fused spawn-plus-wait
wrapper).

```
CLI (src/index.ts)
  → load config / settings
  → runTUI (default) or runExec (corbits exec | run)
  → create agent with ChatDirector, posix tools, permission gate
  → mount plugins, MCP, hooks, skills
  → primary orchestrator turn
       ↳ spawn_agent / wait_agents → closed directors (builder, explorer, …)
  → event stream → OpenTUI host (TUI) or stdout (exec)
```

The chat director adds context management on top of the reactor:

- **Threshold compaction:** As the context window fills, the conversation is
  compacted at the next safe point.
- **Idle compaction:** A pending compaction also runs when a turn ends without
  more work, so a text-only conversation still compacts.
- **Overflow recovery:** A context-overflow error triggers a bounded
  compact-and-retry instead of failing the turn.
- **Workflow nudges:** When a workflow is active, the director keeps the run on
  the current step and surfaces a visible message if it stalls.

Deep design: `docs/ARCHITECTURE.md`, `docs/IMPLEMENTATION.md`, `docs/PRODUCT.md`.

## Extensibility

- **Plugins** — discovery and manifests: `docs/PLUGINS.md`
- **MCP** — connect external tool servers: `docs/MCP.md`
- **Hooks** — lifecycle hooks: `docs/HOOKS.md`
- **Skills / slash commands** — first-party actions such as `/implement`,
  `/plan`, `/review`, `/create-issue` ship with the `corbits-skills` plugin (on
  by default; toggle in `/plugins`)

## Agent workspace

Corbits Code keeps repository guidance and the closed director fleet separate:

- `AGENTS.md` — shared startup instructions and project context
- `src/agent/directors/` — closed spawn catalog (`directorProfiles()`). Skywalker
  is the primary orchestrator; spawnable directors include builder, explorer,
  counsel, intern, critic, greybeard, neckbeard, bruckheimer, gaasbot, draper,
  emil, rand, shakespeare, testsmith, and tester. Closed ids cannot be
  overridden by plugins or local files.
- `.agents/agents/` — optional local profile additions; this directory is not
  required and may be absent

Named workers resolve through `spawn_agent` / `task` (`resolveDirector`): closed
directors first, then enabled agent plugins, then local
`.agents/agents/*.json|*.yaml` profiles. Use `search_agents` to discover ids
before dispatching.

## Contributing

Before your first commit: `git config core.hooksPath .githooks` and
`./bin/check-env`.

Every change must pass `bun run check` (lint, typecheck, build, and test).
Behavior changes come with tests. Coding conventions live in `AGENTS.md`
(functional TypeScript, no classes, arktype at boundaries); commit, PR, and
Linear/GitHub linking rules live in `CONTRIBUTING.md`.

```bash
bun install
bun run check
```

## Docs

| Doc                      | Covers                                  |
| ------------------------ | --------------------------------------- |
| `docs/PRODUCT.md`        | What we are building and why            |
| `docs/ARCHITECTURE.md`   | Reactor, directors, permissions, exec   |
| `docs/IMPLEMENTATION.md` | Runtime, config, CLI flags, persistence |
| `docs/TUI.md`            | Terminal UI behavior                    |
| `docs/PLUGINS.md`        | Plugin manifests and discovery          |
| `docs/MCP.md`            | MCP servers                             |
| `docs/HOOKS.md`          | Lifecycle hooks                         |
| `docs/TELEMETRY.md`      | Usage telemetry                         |
| `docs/PERFTRACE.md`      | Local PerfTrace / OTEL export           |
| `docs/VENDORING.md`      | Vendored Interchange packages           |

## License

Copyright (C) 2026 ABK Labs, Inc.

Licensed under the GNU General Public License Version 2 with the
supplemental terms in `GPLv2-AI-Exception.md`; see `LICENSE.md`.
Contributions are accepted under the terms of `CLA.md`.

The `@intx/*` packages installed from npm and the vendored copy of the
inference package under `vendor/` are third-party code licensed under
LGPL-2.1-only and keep their own license; see the `LICENSE` file in
each package.
