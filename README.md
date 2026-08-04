# Corbits Code

Corbits Code is a local-first coding agent. It lives in your terminal and works with whatever model you point it at — Anthropic, OpenAI, Google, a local Ollama, or any OpenAI-compatible endpoint. Your machine, your keys, your code.

## Quickstart

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

## Contributing

Before your first commit: `git config core.hooksPath .githooks` and `./bin/check-env`.

Every change must pass `bun run typecheck`, `bun run build`, and `bun test`, and behavior changes come with tests. Conventions live in `AGENTS.md` (functional TypeScript, no classes, arktype at boundaries, plain-English commit messages); the system design is documented in `docs/ARCHITECTURE.md` and `docs/IMPLEMENTATION.md`.

## Stack

- **Runtime:** Bun + TypeScript
- **Agent loop:** `@intx/agent` with event-driven reactor
- **Inference:** `@intx/inference` with OpenAI-compatible SSE adapter
- **Tools:** `@intx/tools-posix` with path-escape, authz, and verify plugins
- **Persistence:** `@intx/storage-isogit` for git-backed resume
- **Testing:** `@intx/inference-testing` for deterministic agent loop tests
- **TUI:** Ink + React

## Architecture

Corbits Code is a single-process CLI built on Interchange primitives. The goal is raw feature implementation throughput that outperforms other coding agents through deterministic event-loop discipline, better prompts, and a custom reactor director.

```
CLI (src/index.ts)
  → load config, load skills
  → createPosixTools({ cwd, plugins: [pathEscapePlugin, authzPlugin, verifyPlugin] })
  → createAgent(agentDef, {
      sources,        // built per active provider: Anthropic, OpenAI, Google, Ollama, or an OpenAI-compatible endpoint
      defaultSource,
      tools: posixTools,
      director: createChatDirector(systemPrompt, tools),
    })
  → agent.send(task)
  → for await (event of agent.stream()) { handle }
  → agent.close()
```

The chat director adds context management on top of the reactor:
- **Threshold compaction:** As the context window fills, the conversation is compacted at the next safe point.
- **Idle compaction:** A pending compaction also runs when a turn ends without more work, so a text-only conversation still compacts.
- **Overflow recovery:** A context-overflow error triggers a bounded compact-and-retry instead of failing the turn.
- **Workflow nudges:** When a workflow is active, the director keeps the run on the current step and surfaces a visible message if it stalls.

## Permissions and auto mode

Corbits Code defaults to **auto mode** (`auto = true`). Workspace file writes/edits/deletes and unconstrained shell commands run without per-action prompts. Pass `--no-auto` to start in ask-on-every-consequential-action mode, or press **SHIFT+TAB** in the TUI to toggle at any time. Enabling auto prints a one-line reminder of the envelope below.

### What auto allows

- File tools inside the workspace: `write_file`, `edit_file`, `delete_file` (and other non-shell built-ins such as `manage_tasks`, `task`, …)
- Unconstrained shell (builds, tests, git, one-off commands that match no deny/ask rule)
- Read-only tools (`read_file`, `grep`, `search_files`, `list_dir`, `lsp`, …) always allow regardless of mode

### What still asks (even in auto)

- Dependency installs and remote runners (`npm install` / `i` / `ci` / `add`, `pip install`, `cargo add`, `brew install`, `npx` / `bunx`, …)
- Recursive `rm` (`-r` / `-R` / `--recursive`)
- Git worktree boundary changes (`add` / `remove` / `prune`; read-only `git worktree list` is fine)
- Shell that references sensitive paths (`.env`, private keys, certs, credential files, …)
- Opaque shell wrappers the policy cannot statically inspect (variable expansion or command substitution in a wrapper payload)
- Paths outside the workspace, writes under the session state root, mutating MCP tools, and unknown built-ins


### What auto hard-denies (use the file tools instead)

- File creation or edits via shell: redirects (`>` / `>>`), `tee`, `sed -i` / `perl -i` / similar, interpreter inline programs or heredocs (`python -c`, `node -e`, …)

Wrappers such as `bash -c '…'`, `sh`/`zsh -c`, `xargs`, and transparent prefixes (`env`, `nice`, `timeout`) are peeled so the same rules apply to the inner command. Unparseable wrappers fall through to ask rather than auto-allow.

Catastrophic patterns (`rm -rf /`, `sudo`, `curl | bash`, force-push, open-ended `find`/`rg`/`grep -r`, …) are always denied by authorization, independent of auto mode. `--dangerously-skip-permissions` is a separate escape hatch that bypasses the permission gate (not secret-guard path denies or authz hard blocks).

Details live in `docs/PRODUCT.md` (safety model) and `docs/ARCHITECTURE.md` (permission gate and auto-shell policy).

## Development

```bash
bun install
bun run typecheck
bun run build
bun test
```

## Agent Workspace

Corbits Code keeps repository guidance and sub-agent profiles separate:

- `AGENTS.md` — shared startup instructions and project context
- `CLAUDE.md` — Claude-specific workspace notes
- `src/agent/default-agents.ts` — built-in sub-agent profiles shipped with Corbits Code (`greybeard`, `critique`)
- `.agents/agents/` — optional local profile overrides or additions; this directory is not required and may be absent

Named `task` sub-agents resolve from built-ins first, then enabled agent plugins, then local `.agents/agents/*.json|*.yaml` profiles. Add a local profile under `.agents/agents/` or use an installed profile id such as `greybeard`.

## License

Copyright (C) 2026 ABK Labs, Inc.

Licensed under the GNU General Public License Version 2 with the
supplemental terms in `GPLv2-AI-Exception.md`; see `LICENSE.md`.
Contributions are accepted under the terms of `CLA.md`.

The `@intx/*` packages installed from npm and the vendored copy of the
inference package under `vendor/` are third-party code licensed under
LGPL-2.1-only and keep their own license; see the `LICENSE` file in
each package.
