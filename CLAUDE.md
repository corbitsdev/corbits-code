# Claude Workspace — interchange-code

This repository is **interchange-code**, a single-process coding agent CLI built on Interchange primitives and backed by the LLM. The goal is raw feature implementation throughput that outperforms other coding agents through deterministic event-loop discipline.

## Startup

Before responding to the user's first message, complete these steps in order:

1. Load the `style` skill.
2. Load the `philosophy` skill.
3. Read `AGENTS.md`.
4. Check `.agents/agents/` for project agent profiles that match the task.
5. Check `.agents/skills/` and `.claude/skills/` for project-specific skills that match the task.

Do not do anything else before completing the first three startup steps.

## Project Context

- **Runtime:** Bun + TypeScript. ES modules only. Functional programming, no classes.
- **Core primitives:** `@intx/agent` (agent loop), `@intx/inference` (OpenAI-compatible director + SSE runner), `@intx/tools-posix` (sandboxed shell/file tools), `@intx/storage-isogit` (git-backed resume).
- **Entry point:** `src/index.ts` — CLI argument parsing, config loading, agent creation, event stream handling.
- **Custom director:** `src/director.ts` — extends `DefaultDirector` with stall-detection hooks (idle-cycle limits, read-without-write caps, plan-adherence checks, search budgets).
- **System prompt:** `src/prompts.ts` — designed for an event-driven loop, not a chat interface.
- **State:** `src/state.ts` — atomic JSON save/load of run state + director state for resume.
- **Plugins:** `path-escape-plugin.ts`, `authz-plugin.ts`, `verify-plugin.ts` — middleware over `createPosixTools`.
- **Critique:** `src/critic.ts` — post-submit review loop before final acceptance.

## Reference Material

- `PLAN.md` — full architecture, design decisions, phase breakdown, and demo strategy. Read this when planning or reviewing architecture.
- `src/` — all source. Keep files small and functions single-purpose.
- `tests/` — `unit/` for isolated logic, `integration/` for agent-loop harness tests, `fixtures/` for end-to-end repos.

## Build & Validation

Always run these before declaring work complete:

```bash
bun run typecheck
bun run build
bun test
```

If any step fails, report the failure and do not declare completion.

## Agent-Specific Notes

- **The reactor is not a chat loop.** Every assistant turn must produce at least one `tool_call`. Conversational text without tool calls is idle time and the director will intervene.
- **The plan is a contract.** The agent's first turn must call `submitPlan` with a structured step list. The director stores it and enforces adherence.
- **Reads are budgeted.** Re-reading a file or exceeding the search budget is blocked at the tool layer.
- **Only `submitOutput` terminates.** A conversational "done" message does not end the loop.
- **State is persisted.** `agent.stream()` events are saved atomically to `.agent-state/run.json`. Resume via the `resume` CLI verb.

## Skill Locations

- Shared skills: `.agents/skills/`
- Shared agents: `.agents/agents/`
- Claude-specific skills: `.claude/skills/`
- Claude-specific agent adapters: `.claude/agents/`

Do not duplicate shared content between folders.
