# Corbits Code

Corbits Code is a local agentic software factory: a single-process coding agent
CLI that runs multi-agent fleets to implement, verify, and land software — with
progress and cost always visible. Point it at Anthropic, OpenAI, Google, a local
Ollama, or any OpenAI-compatible endpoint. Your machine, your keys, your code.

The product is the **harness** — the loop that dispatches work, watches it,
decides what happens next, and reports to the operator. Agent personas and
skills are content that run inside it.

## Install

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

## First run

```sh
corbits "Add JWT auth to the API"
```

That opens the full-screen terminal UI: event log, permission and operator
prompts, diff and cost visibility, and a chat input for follow-ups. **Tab**
toggles focus between the prompt and the transcript, **Shift+Tab** cycles
reasoning effort, **Ctrl+C** interrupts a run, and `/help` lists the rest.

For scripts and CI, `corbits exec` runs the same directors, tools, permissions,
MCP, plugins, and hooks without the terminal UI, streaming assistant text to
stdout:

```sh
corbits exec "Add JWT auth to the API"
```

`corbits resume` reopens one of the 10 most recent sessions for this checkout;
plain `corbits` always starts fresh.

Behavior, keybindings, and steering in depth: `docs/TUI.md` and
`docs/PRODUCT.md`.

## Permissions

Corbits Code defaults to **auto mode**, where workspace file edits and ordinary
shell commands run without a prompt so a long task is not interrupted every few
seconds. It still stops and asks before anything consequential — dependency
installs, recursive deletes, touching paths outside the workspace or anything
that looks like a credential — and it refuses outright to edit files through
shell redirects or `sed -i` when the file tools exist for that. Catastrophic
patterns are denied by authorization regardless of mode.

Start with `--no-auto` to be asked before every consequential action.

The full policy — every rule, what is peeled from wrappers, and how the gate
composes with authorization — is in `docs/ARCHITECTURE.md`, with the safety
model behind it in `docs/PRODUCT.md`.

## Where to go next

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

`AGENTS.md` carries the repository's own instructions to agents working in it —
conventions, scope discipline, and how to validate a change.

## Contributing

Before your first commit: `git config core.hooksPath .githooks` and
`./bin/check-env`.

Every change must pass `bun run check` (lint, typecheck, build, and test).
Behavior changes come with tests. Coding conventions live in `AGENTS.md`;
commit, pull request, and Linear/GitHub linking rules live in
`CONTRIBUTING.md`, and a pull request that does not follow them will be
declined.

```bash
bun install
bun run check
```

## License

Copyright (C) 2026 ABK Labs, Inc.

Licensed under the GNU General Public License Version 2 with the
supplemental terms in `GPLv2-AI-Exception.md`; see `LICENSE.md`.
Contributions are accepted under the terms of `CLA.md`.

The `@intx/*` packages installed from npm and the vendored copy of the
inference package under `vendor/` are third-party code licensed under
LGPL-2.1-only and keep their own license; see the `LICENSE` file in
each package.
