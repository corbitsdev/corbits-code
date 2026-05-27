# Agent Instructions — interchange-code

This repository is **interchange-code**, a single-process coding agent CLI built on Interchange primitives and backed by the LLM. Agents working here must understand the event-driven reactor loop and the deterministic execution contract.

## Session Initialization

Before responding to the user's first message, complete these steps in order:

1. Load the `style` skill.
2. Load the `philosophy` skill.
3. Read this file.

Do not do anything else before completing those steps.

Before making changes:

1. Read `CLAUDE.md` when working in a Claude workspace.
2. Check `.agents/agents/` for project agent profiles that match the task.
3. Check `.agents/skills/`, `.codex/skills/`, and `.claude/skills/` for project-specific skills that match the task.
4. Confirm the working tree status before editing.

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

## Workspace Layout

- `.agents/` contains shared agent assets and skills intended to apply across agent runtimes.
- `.codex/` contains Codex-specific workspace assets and skills.
- `.claude/` contains Claude-specific workspace assets and skills.

Prefer shared guidance in `.agents/` when it applies to more than one runtime. Use runtime-specific folders only for behavior that is genuinely specific to that agent.

## Shared Skills

Core shared skills live in `.agents/skills/`:

- `style` — coding, Git, validation, and documentation conventions. Always load first.
- `philosophy` — engineering principles and decision rules. Always load alongside `style`.
- `dispatch` — coordinates parallel agent work. Load when planning multi-file or multi-phase tasks.
- `interview` — gathers requirements for ambiguous or complex work. Load when the task is underspecified.
- `scribe` — maintains product, architecture, and implementation docs. Load when updating `PLAN.md` or adding design docs.
- `brand-identity` — applies the Corbits brand system to artifacts. Load when generating user-facing output or demos.
- `design-lab` — explores UI directions and implementation plans. Load when working on the TUI (Phase 5).

## Shared Agent Profiles

For this project, the most relevant profiles from `.agents/agents/` are:

- `karen` — coordinates planning, dispatch, and escalation. Default orchestrator for complex work.
- `greybeard` — reviews product, architecture, and implementation plans. Load before major architectural decisions.
- `critique` — reviews code quality and tests assumptions without fixing them. Use before declaring work complete.
- `intern` — runs clear mechanical tasks and reports results. Use for refactors, moves, or repetitive edits.
- `neckbeard` — provides intentionally pedantic read-only reviews. Use when you want edge-case scrutiny.
- `bruckheimer` — turns early product visions into buildable briefs. Use when the user describes a feature in prose.
- `draper` — reviews artifacts against the Corbits brand system. Use for demos and user-facing output.
- `emil` — reviews UI and design engineering quality. Use for TUI work (Phase 5).
- `linear` — creates, updates, and comments on Linear issues. Use only when the user references Linear.

## Development Rules

- **TypeScript:** Full type safety always. Avoid `any`. Prefer `unknown` over `any`.
- **Modules:** ES modules (import/export) only. No CommonJS.
- **Paradigm:** Functional programming. No classes, no OOP.
- **Files:** Small functions, small files, clear naming.
- **Scope:** Only touch code directly related to the task. No drive-by refactors, reformatting, or renaming in files you pass through.
- **Tests:** Add or update tests with every behavior change. Write a failing test first when fixing a bug.
- **Dead code:** Delete old implementations when refactoring. Do not leave shims, re-exports, or renamed `_unused` variables.
- **Comments:** Only when the WHY is non-obvious. Never describe WHAT the code does.
- **No emojis** in code or documentation.

## Build & Validation

Always run the full build command before declaring any task complete:

```bash
bun run typecheck
bun run build
bun test
```

If any step fails, report the failure and do not declare completion. Do not work around a failing build by running individual targets.

## Commits

- Commit changes as you go, using the commit guidance from the `style` skill.
- Separate refactoring from feature additions (distinct commits).
- Amend (`git commit --amend`) to refine the most recent commit.
- Fixup (`git commit --fixup=<sha>` + `git rebase --autosquash`) to fix an earlier unpushed commit.
- After committing changes, remind the user to push to remote.

## Bug Reporting

When the user reports a bug, do not start by trying to fix it. Start by writing a test that reproduces the bug. Then have subagents try to fix the bug and prove it with a passing test.
