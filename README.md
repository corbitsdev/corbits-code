# Intercode

A single-process coding agent CLI using the LLM (OpenAI-compatible) built on Interchange primitives. The goal is raw feature implementation throughput that outperforms other coding agents through deterministic event-loop discipline, better prompts, and a custom reactor director.

## Stack

- **Runtime:** Bun + TypeScript
- **Agent loop:** `@intx/agent` with event-driven reactor
- **Inference:** `@intx/inference` with OpenAI-compatible SSE adapter
- **Tools:** `@intx/tools-posix` with path-escape, authz, and verify plugins
- **Persistence:** `@intx/storage-isogit` for git-backed resume
- **Testing:** `@intx/inference-testing` for deterministic agent loop tests
- **TUI (Phase 5):** Ink + React

## Architecture

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
- `packages/agents/` — built-in sub-agent profiles shipped with Intercode (`greybeard`, `critique`)
- `.agents/agents/` — optional local profile overrides or additions; this directory is not required and may be absent

Named `task` sub-agents resolve from built-ins first, then enabled agent plugins, then local `.agents/agents/*.json|*.yaml` profiles. Add a local profile under `.agents/agents/` or use an installed profile id such as `greybeard`.
