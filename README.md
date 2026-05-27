# interchange-code

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
      director: createCodingDirector(policy),
    })
  → agent.send(task)
  → for await (event of agent.stream()) { handle }
  → agent.close()
```

The custom director adds stall detection on top of the reactor:
- **Idle cycles:** Conversational turns without tool calls are counted and corrected.
- **Read budgets:** Re-reading files and excessive searches are blocked.
- **Plan adherence:** The first turn must submit a structured plan; deviations are flagged.
- **Missing submit:** The director enforces `submitOutput` as the only terminal action.

## Development

```bash
bun install
bun run typecheck
bun run build
bun test
```

## Agent Workspace

This repository includes a shared agent workspace under `.agents/`, `.claude/`, and `.codex/` so Codex, Claude, and other agent tools share the same instructions, skills, and specialist profiles.

- `AGENTS.md` — shared startup instructions and project context
- `CLAUDE.md` — Claude-specific workspace notes
- `.agents/skills/` — shared skills (`style`, `philosophy`, `dispatch`, `interview`, `scribe`, `brand-identity`, `design-lab`)
- `.agents/agents/` — shared agent profiles (`karen`, `greybeard`, `critique`, `intern`, `neckbeard`, etc.)
