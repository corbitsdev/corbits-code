# Agent Instructions — Corbits Code

**Corbits Code** is a single-process coding agent CLI built on the Interchange runtime. For how the system is built, read `/docs` — do not re-derive it from source.

## Before You Start

Confirm working-tree status (`git status`) and run `git log --oneline -5`. When the task touches the agent loop, directors, tools, or prompts, read the relevant doc in `/docs` before writing code.

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

## Director extract review bar

A new or changed `@corbits/code-agent-*` workspace package (`agents/<id>/`) must
survive review against three hard failures, regardless of how the app consumes it:

1. **No dead re-exports.** `agents/<id>/src/index.ts` may only re-export names
   that have a production importer. Do not add a barrel or test-only consumer to
   launder a dead name past the dead-export guard. The app's single closed fan-in
   is `DIRECTOR_REGISTRY` (`src/agent/directors/registry.ts`); there is no second
   fleet barrel, and an extract branch has no other in-repo consumer to justify a
   name.
2. **No "what this file is" narration.** Do not paste file-summary or
   ticket-restating JSDoc into the package. Comment _why_, never _what_
   (Conventions above); a module that restates its own exports in prose is noise,
   not documentation.
3. **No whole-surface allowlisting without naming the API.** Every export left on
   `scripts/dead-export-allowlist.txt` (the `agents/<id>/src/index.ts` six-name
   surface) must say which names are the public API and why. A blanket entry that
   lists the whole surface without per-name reasons fails review; remove each
   entry with the export it covers as the closed fan-in (`DIRECTOR_REGISTRY`)
   consumes it.

An extract lands only when the names it keeps are real public API backed by a
production importer, the code reads why-not-what, and the allowlist entry names
the API surface. Failing any of these means reworking the extract, not a new
barrel or an allowlist band-aid.

## Tests

- Add or update tests with every behavior change.
- Bug fixes start with a failing test that reproduces the bug. Do not start by patching.
- Co-located `src/**/*.test.ts` for module logic · `testkit/` shared test helpers (repo root, shared by unit and e2e) · `fixtures/` fixture repos · `e2e/` scenario runs over the production agent loop (fixture-repo seeding, scripted inference via `@intx/inference-testing`, `runUntilDone`/`runUntilSuspended`/`sendOperatorTurn` drivers — see `e2e/harness.ts`; the session plumbing lives in `e2e/integration-harness.ts`).
- Unit vs e2e split: keep parser tables, race/atomicity tests, and small pure-function contracts co-located unit tests; put multi-step agent-loop orchestration (permission flows, compaction end-to-end, subagent lanes, credential recovery) in `e2e/` where a scripted model reply replaces pages of per-file fakes. Do not pin constants or `record.decisions` diagnostics — assert the behavior the contract exposes.
- e2e v1 non-goals: TUI overlay/PTY driving, race tests, parser tables, crash-atomicity, and any second agent-loop stack — the integration harness already is one.
- A test must not depend on another file having run, or on the default file order. It must pass under `bun test ./src ./e2e ./evals ./scripts --randomize`. If a test mutates module-level state or calls `mock.module`, it must restore that state itself (`afterEach`/`afterAll`), not rely on the process happening to reset it. When capturing a module's real exports to restore later, shallow-copy them (`{ ...moduleNamespace }`) at capture time, whether the namespace came from `await import(path)` or a static `import * as ns from "path"` — Bun mutates the live namespace object in place when the module is mocked, so holding a bare reference to it (either form) silently turns into the mocked exports.
- Never call `mock.module` directly. Bun runs every test file in one process, so a `mock.module` call without its own teardown stays installed for the rest of the run and silently replaces the real module for other files — producing failures in files the change never touched, with no obvious link to the cause and no signal from `tsc` or a per-file run (CL-6967). Use `withMockedModule`/`withMockedModuleDuring` from `testkit/mock-module.ts`, which capture the real module and register their own restore. The oxlint plugin (`corbits/no-bare-mock-module` in `.oxlintrc.json` / `scripts/oxlint-plugin-corbits.js`) rejects bare `mock.module` calls in `*.test.ts` files.
- A test earns its place only if a real behavior change can fail it. Document copy, brand colors, marketing assets, and splash text are not behavior: assertions that pin an asset's literal wording, an exact palette hex/ANSI value, or rendered copy fail on copy/design edits and catch no regressions — assert the contract instead (parsing, formatting, ranges, aliases, invariants). Tests are code too: pinning a source file's own text is the same trap. This bar is a review and authorship rule, not a linter shape match.

## Build & Validation

```bash
bun run check
```

`bun run check` is the single pre-PR gate: it runs `lint`, `typecheck`,
`check:dead-exports`, `build`, and `check:projects-dir-guard` — which runs the `test` suite under
the projects-dir sandbox guard — in that order, matching CI.

Run the full suite before declaring any task complete. Do not substitute individual targets. If a failure is pre-existing and unrelated to your change, say so explicitly.

`bun run test` runs `bun test ./src ./e2e ./evals ./scripts --randomize --seed 424242`
as a single process. CI shards the same path union via `test:paths`
(`.github/workflows/ci.yml`) for wall clock. Path-union is not the same
isolation domain: a `mock.module` leak across `./src` vs `./e2e` fails
locally in the one-process suite but not in a CI shard (CL-6967). A bare
`bun test` also scans `vendor/`, adding hundreds of unrelated results and
making pass/fail counts meaningless to compare across branches — always use
`bun run test`. `test:paths` with no path filters refuses to run for the
same reason.

## Commits, pull requests, and issue tracking

**MUST follow `CONTRIBUTING.md`.** That file is the single source of truth for
commit titles and bodies, PR titles and bodies, and Linear/GitHub linking. It
is not summarized here on purpose — a second copy of the rules is a copy that
goes stale, and the rules have changed before. Read it.

**This binds humans and agents equally. A pull request that violates
`CONTRIBUTING.md` will be declined** — not fixed in review. Check your commit
subjects against that file before you push, and rewrite them if they do not
match. Commit with the operator's local git identity.

## Pushing

**Never mutate git configuration outside the current repository**, for any reason and not even temporarily with a plan to restore it — whatever the command (`--global`, `--system`, `--edit`, `--file` pointed at a path outside the repo, reassigning or unsetting `GIT_CONFIG_GLOBAL`, or writing `~/.gitconfig` directly). That state is shared by every agent and every repo on the machine; a crash or a second agent running concurrently turns a "temporary" toggle into a lasting outage or collision. This is the same hazard class as running `git stash` (also global, also banned). Auto mode enforces this at the shell-policy layer (`git-global-config` in `src/permission/auto-shell-policy.ts`), which routes any such command to an operator ask instead of running it unattended — this instruction is the fallback for the cases the policy can't see, not the only line of defense.

If SSH push fails because the shell can't reach the ssh-agent socket, use `bin/git-push-scoped` instead of touching config:

```bash
bin/git-push-scoped origin <branch>
```

It authenticates over HTTPS via `gh`'s credential helper and rewrites the SSH remote to HTTPS, both scoped to that one `git push` invocation with `-c`. Nothing is written to any config file, so there is nothing to restore and nothing to collide over.

## Building on Interchange

Interchange is the standard library for this repo. Every `@intx/*` package this repo imports resolves to vendored source under `vendor/intx-*` at a single pinned upstream commit — the sole exception is `@intx/tools-lsp`, which remains on published npm (provenance, patch ledgers, and the re-sync procedure: `docs/VENDORING.md`). We never modify or push to the upstream interchange repository. Before writing any new infrastructure — plugins, middleware, utilities, state management, logging, authz, inference, tools — check these packages first; do not reinvent what Interchange already provides.

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
