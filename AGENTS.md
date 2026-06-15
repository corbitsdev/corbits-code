# Agent Instructions — Intercode

**Intercode** is a single-process coding agent CLI built on the Interchange runtime. This file is your operating manual: how to work here and what bar to hold. For how the system itself is built, read `/docs` — do not re-derive it from source.

## Before You Start

1. Load the `style` and `philosophy` skills.
2. Read this file.
3. When the task touches the agent loop, directors, tools, or prompts, read the relevant doc in `/docs` first (see Reference).
4. Confirm the working-tree status before editing.

## Conventions

- **Runtime:** Bun + TypeScript, ES modules only. No CommonJS.
- **Paradigm:** Functional. No classes, no OOP.
- **Types:** Full type safety. Avoid `any`; prefer `unknown`. Validate all external input (config, tool args, file contents, env) at the boundary with arktype (`type({...})`) — do not hand-roll `typeof` guards for structured data.
- **Files:** Small functions, small files, clear names. Acronyms keep their case (`URL`, `JSON`, `API`).
- **Comments:** Code is self-documenting. Comment *why*, never *what*. If a comment describes what the code does, fix the names instead.
- **No emojis** in code or docs.

## Scope Discipline

Touch only code directly related to the task. No drive-by renames, reformatting, import reordering, or "while I'm here" refactors in files you pass through — they pollute diffs and risk breakage. Raise unrelated fixes as separate work.

When refactoring replaces an old path, **delete the old one**. No back-compat shims, re-exports, or `_unused` renames for callers you own. If everyone who calls it is internal and updated, the old path should not survive.

## Tests

- Add or update tests with every behavior change.
- Fixing a bug starts with a failing test that reproduces it — then the fix, proven by that test passing. Do not start by patching.
- `tests/unit/` isolated logic · `tests/integration/` agent-loop harness · `tests/e2e/` fixture repos.

## Build & Validation

Run the full suite before declaring any task complete:

```bash
bun run typecheck
bun run build
bun test
```

If any step fails, report it and do not declare completion. Do not work around a failing build by running individual targets and treating their success as equivalent. If a failure is pre-existing and unrelated to your change, say so explicitly.

## Commits

- Commit as you go, following the `style` skill's message format (plain-English summary, no `feat:`/`fix:` prefixes, no filename in the summary).
- Separate refactors from feature additions into distinct commits.
- Do not amend published commits — create a new commit for fixes.
- After committing, remind the user to push.
- Commit with the user's local git identity. Do not override the author.

## Setup

New contributors configure git hooks before their first commit, then verify the environment:

```bash
git config core.hooksPath .githooks
./bin/check-env
```

## Reference (`/docs`)

The source is the truth; these docs guide you to it.

- `docs/ARCHITECTURE.md` — the reactor loop, events and `ReactorAction`s, directors, the mandatory `submit_plan`/`submit_output` tools, the workflow engine (`src/workflows/`), stall detection, the plugin chain, and the permission system. **Read this before working on the loop, directors, tools, or workflows.**
- `docs/IMPLEMENTATION.md` — runtime, dependencies, config and profile resolution, settings precedence, CLI flags (incl. `--no-workflow`), state persistence, the eval harness.
- `docs/PRODUCT.md` — what we're building and why.
- `docs/HOOKS.md` — lifecycle hooks.
- `PLAN.md` — phase breakdown and demo strategy.

## Interchange as Standard Library

Interchange is the standard library for this repo. Before writing any new infrastructure — plugins, middleware, utilities, state management, logging, authz, inference, tools — check the interchange submodule packages for an existing implementation.

**Do not reimplement what interchange already provides. Lean on it.**

Canonical packages and what each covers:

- `@intx/authz` — grant-based policy engine (allow/ask/deny)
- `@intx/inference` — reactor loop, `createAuthzExtension` (beforeTool hook), `DefaultDirector`
- `@intx/agent` — agent lifecycle, send queue, stream
- `@intx/tools-posix` — shell, file read/write/edit, grep, search
- `@intx/storage-isogit` — git-backed state persistence
- `@intx/log` — structured logging via LogTape
- `@intx/types` — all shared runtime types

If you find yourself writing something that sounds like one of these, stop and check the package first.

## Workspace Layout

- `.agents/` — shared agent assets and skills (prefer this for cross-runtime guidance).
- `.intercode/` — Intercode's own workspace state: settings, profiles, memory, hooks, and permissions.

Do not duplicate shared content between these folders.
