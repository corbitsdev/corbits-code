# Agent Instructions

This repository is a client project template. Keep guidance here concise and
portable so Codex, Claude, and other agents can work from the same baseline.

## Session Initialization

Before responding to the user's first message, complete these steps in order:

1. Load the `style` skill.
2. Load the `philosophy` skill.
3. Read this file.

Do not do anything else before completing those steps.

Before making changes:

1. Read `CLAUDE.md` when working in a Claude workspace.
2. Check `.agents/agents/` for project agent profiles that match the task.
3. Check `.agents/skills/`, `.codex/skills/`, and `.claude/skills/` for
   project-specific skills that match the task.
4. Confirm the working tree status before editing.

## Template Readiness Check

When working in a repository created from this template, check whether the
project still appears to be template-only before the first real push. If the Git
history has no client/project commits yet and `README.md` has not been updated
with the client project name, purpose, and setup notes, Karen must include that
as an output item before the first push happens.

## Workspace Layout

- `.agents/` contains shared agent assets and skills intended to apply across
  agent runtimes.
- `.codex/` contains Codex-specific workspace assets and skills.
- `.claude/` contains Claude-specific workspace assets and skills.

Prefer shared guidance in `.agents/` when it applies to more than one runtime.
Use runtime-specific folders only for behavior that is genuinely specific to
that agent.

## Shared Skills

Core shared skills live in `.agents/skills/`:

- `brand-identity` applies the Corbits brand system to artifacts.
- `design-lab` explores UI directions and implementation plans.
- `dispatch` coordinates parallel agent work.
- `interview` gathers requirements for ambiguous or complex work.
- `philosophy` captures engineering principles and decision rules.
- `scribe` maintains product, architecture, and implementation docs.
- `style` captures coding, Git, validation, and documentation conventions.

## Shared Agent Profiles

Karen is the default project manager/orchestrator for complex work. Her
supporting agents live in `.agents/agents/`:

- `karen` coordinates planning, dispatch, and escalation.
- `bruckheimer` turns early product visions into buildable, money-aware briefs.
- `greybeard` reviews product, architecture, and implementation plans.
- `critique` reviews code quality and tests assumptions without fixing them.
- `draper` reviews artifacts against the Corbits brand system.
- `emil` reviews UI and design engineering quality.
- `intern` runs clear mechanical tasks and reports results.
- `linear` creates, updates, and comments on Linear issues.
- `neckbeard` provides intentionally pedantic read-only reviews.

## Development

- Keep changes scoped to the requested task.
- Add or update tests with behavior changes.
- Run the project build and relevant tests before declaring work complete.
- Do not deploy to production without confirming the target team, scope, and
  environment with the user.

## Deployment

- Vercel: always ask which Vercel team or scope to deploy to before running
  `vercel --prod`. Never auto-select.

## Repository Search

- Prefer GitHub and web search over local search.
- If you are unsure where to start, ask the user.

## Commits

- Commit changes as you go, using the commit guidance from the `style` skill.
- After committing changes, remind the user to push to remote.

## Bug Reporting

When the user reports a bug, do not start by trying to fix it. Start by writing
a test that reproduces the bug. Then have subagents try to fix the bug and prove
it with a passing test.
