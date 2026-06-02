# Agent Instructions — interchange-code

This repository is **interchange-code**, a single-process coding agent CLI built on top of the Interchange runtime. To work here effectively you must understand how the Interchange event loop works — not just where files are.

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

## How the Interchange Loop Works

Interchange is an event-driven agent runtime. Understanding it is a prerequisite for working in this repo.

### The reactor

The reactor drives a single agent turn-by-turn. Each turn is:

1. **Inference** — the LLM produces an assistant turn (text + zero or more `tool_call` blocks).
2. **Tool dispatch** — each `tool_call` is executed concurrently; results come back as `tool.done` events.
3. **Director decision** — `CodingDirector.decide()` receives every event and returns `ReactorAction[]` that control what happens next (continue, checkpoint, reply, done).

This repeats until the director emits `capabilities.done()`.

### Key event types

| Event | When it fires |
|---|---|
| `inference.done` | LLM finished one assistant turn. Carries the full turn content. |
| `tool.done` | One tool call completed. Carries the result and the original `callId`. |

### ReactorActions

The director returns actions to shape the loop:

- `capabilities.continue()` — run another inference turn (implicit default).
- `capabilities.reply(text)` — inject a synthetic tool result into the next turn's context.
- `capabilities.checkpoint(label)` — persist a named checkpoint to `.agent-state/`.
- `capabilities.done()` — terminate the loop.

### The two mandatory tools

Every agent session has two special tools that exist only at the director layer:

- **`submit_plan`** — must be called on turn 1 for multi-step tasks. The director stores the plan and enforces adherence. Skipping it on long tasks triggers a warning.
- **`submit_output`** — the only signal that terminates the loop cleanly. Conversational text without `submit_output` does not end the session; the director will keep running inference turns until it stalls or `submit_output` is called.

### Stall detection

`CodingDirector` aborts automatically on:

- **3 consecutive idle turns** — turns where the LLM produced no `tool_call` blocks. Terminates with `"Agent stalled: no tool calls for 3 turns."`

State is persisted atomically to `.agent-state/run.json` after every event so the run can be resumed with `interchange-code resume`.

## Project Layout

```
src/
  index.ts        CLI entry point — arg parsing, env loading, routes to runAgent or runTUI
  run-agent.ts    Headless agent runner — creates director, wires tools, streams events
  director.ts     CodingDirector — extends DefaultDirector with plan/stall enforcement
  prompts.ts      System prompt builders — tool-call discipline, submit rules, budget rules
  state.ts        Atomic JSON save/load for run state and director state
  critic.ts       Post-submit critique loop — reviews output before final acceptance
  config.ts       Config loading from CLI args + env
  tui/            Ink-based TUI (Phase 5)
  plugins/        Tool middleware — path-escape, authz, verify
```

Key Interchange packages (all workspace-local under `interchange/packages/`):

| Package | Role |
|---|---|
| `@intx/agent` | `agent.stream()` — drives the reactor loop, emits typed events |
| `@intx/inference` | `DefaultDirector`, SSE runner, OpenAI-compatible provider client |
| `@intx/tools-posix` | `createPosixTools` — sandboxed shell/file tools |
| `@intx/types` | Shared runtime types (`ReactorDirector`, `ReactorAction`, `ToolDefinition`, etc.) |
| `@intx/storage-isogit` | Git-backed state storage for resume |

## Reference Material

- `PLAN.md` — full architecture, design decisions, and phase breakdown. Read before any architectural work.
- `interchange/` — the Interchange runtime source. Read package source when the types or behaviour are ambiguous.
- `tests/` — `unit/` for isolated logic, `integration/` for agent-loop harness tests, `e2e/` for end-to-end fixture repos.

## Workspace Layout

- `.agents/` — shared agent assets and skills that apply across runtimes.
- `.codex/` — Codex-specific workspace assets.
- `.claude/` — Claude-specific workspace assets.

Prefer `.agents/` for guidance that applies to more than one runtime.

## Shared Skills

Core shared skills live in `.agents/skills/`:

- `style` — coding, Git, validation, and documentation conventions. Always load first.
- `philosophy` — engineering principles and decision rules. Always load alongside `style`.
- `dispatch` — coordinates parallel agent work. Load when planning multi-file or multi-phase tasks.
- `interview` — gathers requirements for ambiguous or complex work. Load when the task is underspecified.
- `scribe` — maintains product, architecture, and implementation docs. Load when updating `PLAN.md` or adding design docs.
- `brand-identity` — applies the Corbits brand system to artifacts. Load when generating user-facing output or demos.
- `design-lab` — explores UI directions and implementation plans. Load when working on the TUI.

## Shared Agent Profiles

For this project, the most relevant profiles from `.agents/agents/` are:

- `karen` — coordinates planning, dispatch, and escalation. Default orchestrator for complex work.
- `greybeard` — reviews product, architecture, and implementation plans. Load before major architectural decisions.
- `critique` — reviews code quality and tests assumptions without fixing them. Use before declaring work complete.
- `intern` — runs clear mechanical tasks and reports results. Use for refactors, moves, or repetitive edits.
- `neckbeard` — provides intentionally pedantic read-only reviews. Use when you want edge-case scrutiny.
- `bruckheimer` — turns early product visions into buildable briefs. Use when the user describes a feature in prose.
- `draper` — reviews artifacts against the Corbits brand system. Use for demos and user-facing output.
- `emil` — reviews UI and design engineering quality. Use for TUI work.
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

Always run the full validation suite before declaring any task complete:

```bash
bun run typecheck
bun run build
bun test
```

If any step fails, report the failure and do not declare completion. Do not work around a failing build by running individual targets.

## Setup

New contributors must configure git hooks before their first commit:

```bash
git config core.hooksPath .githooks
```

To verify your environment is correctly configured:

```bash
./bin/check-env
```

## Commits

- Commit changes as you go, using the commit guidance from the `style` skill.
- Separate refactoring from feature additions (distinct commits).
- Do not amend published commits. Create a new commit for fixes.
- After committing, remind the user to push to remote.

## Bug Reporting

When the user reports a bug, do not start by trying to fix it. Start by writing a test that reproduces the bug. Then fix the bug and prove it with a passing test.
