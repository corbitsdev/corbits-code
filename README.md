# Intercode

Intercode is a local-first coding agent. It lives in your terminal and works with whatever model you point it at — Anthropic, OpenAI, Google, a local Ollama, or any OpenAI-compatible endpoint. Your machine, your keys, your code.

## Quickstart

[Bun](https://bun.sh) v1.2+ is required.

```sh
git clone --recurse-submodules https://github.com/corbitsdev/intercode.git
cd intercode
bun install
bun run start
```

`bun run start` builds and launches Intercode in your terminal.

Optionally, add an `intercode` command to your shell by putting an alias
in your shell rc:

```sh
alias intercode="bun run /path/to/intercode/dist/index.js"
```

The alias runs the built bundle; after pulling new changes, rebuild it
with `bun run build` (or launch once with `bun run start`).

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
- **TUI (Phase 5):** Ink + React

## Architecture

Intercode is a single-process CLI built on Interchange primitives. The goal is raw feature implementation throughput that outperforms other coding agents through deterministic event-loop discipline, better prompts, and a custom reactor director.

```
CLI (src/index.ts)
  → load config, load skills
  → createPosixTools({ cwd, plugins: [pathEscapePlugin, authzPlugin, verifyPlugin] })
  → createAgent({
      contextDir,
      sources: [xaiSource],
      defaultSource: "xai",
      systemPrompt,
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

## Development

```bash
bun install
bun run typecheck
bun run build
bun test
```

## Agent Workspace

Intercode keeps repository guidance and sub-agent profiles separate:

- `AGENTS.md` — shared startup instructions and project context
- `CLAUDE.md` — Claude-specific workspace notes
- `src/agent/default-agents.ts` — built-in sub-agent profiles shipped with Intercode (`greybeard`, `critique`)
- `.agents/agents/` — optional local profile overrides or additions; this directory is not required and may be absent

Named `task` sub-agents resolve from built-ins first, then enabled agent plugins, then local `.agents/agents/*.json|*.yaml` profiles. Add a local profile under `.agents/agents/` or use an installed profile id such as `greybeard`.
