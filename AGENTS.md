# Agent Instructions — Corbits Code

**Corbits Code** is a single-process coding agent CLI built on the Interchange runtime. For how the system is built, read `/docs` — do not re-derive it from source.

## Before You Start

Load the `style`, `philosophy`, and `native-integration` skills. Confirm working-tree status (`git status`) and run `git log --oneline -5`. When the task touches the agent loop, directors, tools, or prompts, read the relevant doc in `/docs` before writing code.

New contributors: configure git hooks and verify the environment before the first commit.

```bash
git config core.hooksPath .githooks
./bin/check-env
```

## Conventions

- **Runtime:** Bun + TypeScript, ES modules only. No CommonJS.
- **Paradigm:** Functional. No classes, no OOP.
- **Types:** Full type safety. Avoid `any`; prefer `unknown`. Validate all external input at the boundary with arktype — do not hand-roll `typeof` guards for structured data.
- **Files:** Small functions, small files, clear names. Acronyms keep their case (`URL`, `JSON`, `API`).
- **Comments:** Comment _why_, never _what_. If a comment describes what the code does, fix the names instead.
- **No emojis** in code or docs.

## Scope Discipline

Touch only code directly related to the task. No drive-by renames, reformatting, import reordering, or "while I'm here" refactors — they pollute diffs and risk breakage. Raise unrelated fixes as separate work.

When refactoring replaces an old path, delete the old one. No back-compat shims, re-exports, or `_unused` renames for callers you own.

## Tests

- Add or update tests with every behavior change.
- Bug fixes start with a failing test that reproduces the bug. Do not start by patching.
- `tests/unit/` shared unit tests and helpers · co-located `src/**/*.test.ts` for module logic · `tests/fixtures/` fixture repos · `tests/integration/` reactor/permission harness. Planned: `tests/e2e/` (fixture-repo runs).
- A test must not depend on another file having run, or on the default file order. It must pass under `bun test ./src ./tests ./evals --randomize`. If a test mutates module-level state or calls `mock.module`, it must restore that state itself (`afterEach`/`afterAll`), not rely on the process happening to reset it. When capturing a module's real exports to restore later, shallow-copy them (`{ ...moduleNamespace }`) at capture time, whether the namespace came from `await import(path)` or a static `import * as ns from "path"` — Bun mutates the live namespace object in place when the module is mocked, so holding a bare reference to it (either form) silently turns into the mocked exports.
- Never call `mock.module` directly. Bun runs every test file in one process, so a `mock.module` call without its own teardown stays installed for the rest of the run and silently replaces the real module for other files — producing failures in files the change never touched, with no obvious link to the cause and no signal from `tsc` or a per-file run (CL-6967). Use `withMockedModule`/`withMockedModuleDuring` from `tests/helpers/mock-module.ts`, which capture the real module and register their own restore. An eslint rule (`no-restricted-syntax` in `eslint.config.js`) rejects bare `mock.module` calls in `*.test.ts` files.

## Build & Validation

```bash
bun run check
```

`bun run check` is the single pre-PR gate: it runs `lint`, `typecheck`,
`build`, and `check:projects-dir-guard` — which runs the `test` suite under
the projects-dir sandbox guard — in that order, matching CI.

Run the full suite before declaring any task complete. Do not substitute individual targets. If a failure is pre-existing and unrelated to your change, say so explicitly.

`bun run test` runs `bun test ./src ./tests ./evals --randomize --seed 424242` —
the same suite CI runs. A bare `bun test` also
scans `vendor/`, adding hundreds of unrelated results and making pass/fail
counts meaningless to compare across branches — always use `bun run test`.

## Commits, pull requests, and issue tracking

**MUST follow `CONTRIBUTING.md`.** That file is the source of truth for commit
titles and bodies, PR titles and bodies, and Linear/GitHub linking. Do not use
Conventional Commits prefixes (`feat:`, `fix:`, `docs:`, `ci:`, …), ticket IDs
in commit subjects, or free-form PR body sections. Rewrite before push if a
message violates those rules. Commit with the operator's local git identity.

## Pushing

**Never mutate git configuration outside the current repository**, for any reason and not even temporarily with a plan to restore it — whatever the command (`--global`, `--system`, `--edit`, `--file` pointed at a path outside the repo, reassigning or unsetting `GIT_CONFIG_GLOBAL`, or writing `~/.gitconfig` directly). That state is shared by every agent and every repo on the machine; a crash or a second agent running concurrently turns a "temporary" toggle into a lasting outage or collision. This is the same hazard class as running `git stash` (also global, also banned). Auto mode enforces this at the shell-policy layer (`git-global-config` in `src/permission/auto-shell-policy.ts`), which routes any such command to an operator ask instead of running it unattended — this instruction is the fallback for the cases the policy can't see, not the only line of defense.

If SSH push fails because the shell can't reach the ssh-agent socket, use `bin/git-push-scoped` instead of touching config:

```bash
bin/git-push-scoped origin <branch>
```

It authenticates over HTTPS via `gh`'s credential helper and rewrites the SSH remote to HTTPS, both scoped to that one `git push` invocation with `-c`. Nothing is written to any config file, so there is nothing to restore and nothing to collide over.

## Building on Interchange

Interchange is the standard library for this repo, consumed as published `@intx/*` npm packages pinned at 0.2.2, except `@intx/inference`, `@intx/types`, and `@intx/storage-isogit`, which resolve to vendored source under `vendor/intx-*` at upstream head (coupled by the reactor's approval-suspend primitive; `@intx/inference` also carries a local patch set). See `docs/VENDORING.md` for what's vendored, from which upstream commit, and the re-sync procedure. We never modify or push to the upstream interchange repository. Before writing any new infrastructure — plugins, middleware, utilities, state management, logging, authz, inference, tools — check these packages.

| Package                | Covers                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `@intx/authz`          | Grant matching (`matchPattern`, `evaluateGrants`) for permission approvals; Corbits owns the gate, store, and TUI ask |
| `@intx/inference`      | Reactor loop, `createAuthzExtension`, `DefaultDirector`                                                               |
| `@intx/agent`          | Agent lifecycle, send queue, stream                                                                                   |
| `@intx/tools-posix`    | Shell, file read/write/edit, grep, search                                                                             |
| `@intx/storage-isogit` | Git-backed state persistence                                                                                          |
| `@intx/log`            | Structured logging via LogTape                                                                                        |
| `@intx/types`          | All shared runtime types                                                                                              |

## Reference

- `docs/ARCHITECTURE.md` — reactor loop, events, directors, workflows, plugin chain, permission system
- `docs/TUI.md` — terminal UI behavior spec: layout, overlays, selectors, palette, prompt box, scrolling
- `docs/IMPLEMENTATION.md` — runtime, dependencies, config resolution, settings precedence, CLI flags, state persistence, eval harness
- `docs/PRODUCT.md` — what we're building and why
- `docs/HOOKS.md` — lifecycle hooks
- `docs/MCP.md` — connecting MCP servers
- `docs/PLUGINS.md` — plugin manifest system and discovery
- `docs/TELEMETRY.md` — what usage telemetry is collected and why
- `docs/PERFTRACE.md` — local PerfTrace and opt-in OTEL export settings
- `docs/plans/` — gitignored working notes and design spikes (local only); durable conclusions belong in the docs above or Linear — never left as a plan file, which is a stale doc waiting to happen
