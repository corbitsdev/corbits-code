# Contributing to Corbits Code

Thanks for contributing. This document is the **source of truth** for commits,
pull requests, and issue tracking. Coding conventions live in `AGENTS.md` —
read that before writing code. Agents **must** follow the rules below; do not
substitute a personal or skill-only convention when this file conflicts.

## Prerequisites

- [Bun](https://bun.sh) v1.2 or newer (`package.json` engines)

```bash
git clone https://github.com/corbitsdev/corbits-code.git
cd corbits-code
bun install
```

Before your first commit, point Git at the project hooks and verify the environment:

```bash
git config core.hooksPath .githooks
./bin/check-env
```

## Development loop

```bash
bun run typecheck
bun run build
bun run test
```

These match the CI workflow in `.github/workflows/ci.yml`. Run `bun run check`
(lint, typecheck, build, and the guarded test suite) before opening a PR —
`bun run test` alone skips the projects-dir sandbox guard, which only runs
under `bun run check` and CI. Do
not substitute a bare `bun test` (it also scans
`vendor/` and pollutes pass/fail counts).

## Commits

### Title (MUST)

- Imperative, present tense, max **72** characters
- Starts with a verb: `Add`, `Fix`, `Remove`, `Harden`, `Document`, …
- No trailing punctuation, no abbreviations for their own sake
- No filenames or paths in the subject — the diff already lists them
- Match the voice of recent history:

```bash
git log origin/main --format='%s' | head -20
```

**Banned subject prefixes** (all of them, including habits from other projects):

- Conventional Commits: `feat:`, `fix:`, `chore:`, `docs:`, `refactor:`, `test:`, `ci:`, `perf:`, `style:`, `build:`
- Scoped forms: `docs(changelog):`, `net:`, `frontend:`
- Ticket IDs: `CL-1234:`, `INTR-79:`, `#456:`
- Status tags: `WIP:`, `[urgent]`, `(security):`

**Good:**

```text
Add retry logic for failed network requests
Fix race condition in transaction verification
Document the permission queue behavior
```

**Bad:**

```text
feat: add retry logic
fix(auth): race in server.ts
CL-5494: flatten model picker
Update code
```

### Why not `feat:` / `fix:` / `docs:` / `ci:`?

Conventional Commits are useful when tools **generate** changelogs, SemVer bumps,
or release notes from commit types. This project does not:

- Release notes are hand-written in `CHANGELOG.md` and deliberately strip ticket
  and PR IDs from public notes.
- Reviewers and `git log` readers need a sentence that stands alone years later,
  not a taxonomy debate (`chore` vs `refactor` vs `fix`).
- An imperative subject already encodes the action: `Fix race in the approval
queue` is clearer than `fix: race in the approval queue`.
- Prefixes train agents and humans to smuggle scope, ticket IDs, and file names
  into the subject — noise we already reject elsewhere.

The Git and Go projects use the same plain-English model. Familiarity with
Angular-style prefixes is not a reason to adopt them here.

### Body (usually omit)

Most commits need **no** body. A clear subject plus a coherent diff is enough.

Add a body only when a future reader of `git log` could not answer _why this
change_ from the subject and the diff alone. When present:

- Blank line between subject and body
- Wrap body lines at 72 characters
- Motivation only: why this change, why now, why not the obvious alternative
- Do **not** walk the diff file-by-file
- Do **not** reference PR review threads, chat, or "the next commit"
- Do **not** put Linear or GitHub issue IDs in the subject or body — linking is
  a pull-request concern (see [Issue tracking](#issue-tracking-linear-and-github))

Write for a stranger reading `git log` years from now with only the repo in
hand, not for the person reviewing this PR today.

### Organization (MUST)

- One logical unit of work per commit
- Separate refactors from feature additions
- Separate formatting/whitespace from behavioral changes
- Commit with the operator's local git identity (never invent author metadata)

## Pull requests

### Scope (MUST)

1. One concern per PR. See scope discipline in `AGENTS.md`.
2. Include or update tests for behavior changes. Bug fixes start with a failing
   test that reproduces the bug — do not start by patching.
3. Do not commit secrets, credentials, or generated noise.
4. Draft title and body from the current diff, not from memory of the work:

```bash
git diff origin/main...HEAD
git log origin/main..HEAD --format='%s'
```

### Title (MUST)

Same rules as [commit titles](#title-must): imperative present-tense sentence,
no prefixes, no ticket IDs, no trailing punctuation. The title describes the
**whole branch**, not a single commit.

### Body (MUST)

Only these sections. Present tense — what the branch **does**, not the journey
of writing it.

```markdown
## Summary

- <what the code does now>
- <optional second or third bullet>

## Verification

- `bun run typecheck`, `bun run build`, and `bun run test` pass
- <any manual or product check that is true on this branch>

Fixes CL-1234
```

Rules:

- `## Summary` and `## Verification` are required. Do not add `## Changes`,
  `## Context`, `## Notes`, or review-fleet diaries — the diff is the change
  list; review discussion belongs on the PR review, not in the description.
- Optional short **Why** paragraph is allowed only when Summary would look
  arbitrary without motivation. Keep it to a few sentences, present tense,
  under the Summary section (not a separate heading).
- Scan for past-tense journey verbs (`was`, `added`, `fixed`, `refactored`,
  `I changed`) and rewrite to present-tense product statements.
- When the work tracks an issue, end the body with a magic-word link (see
  below). When it does not, omit the link line entirely — do not invent IDs.

GitHub auto-fills this shape from `.github/PULL_REQUEST_TEMPLATE.md`.

## Issue tracking (Linear and GitHub)

Link trackers at the **PR boundary**, not inside every commit.

### When work tracks a Linear issue (MUST)

1. **Branch name** — use the issue's Linear `gitBranchName` (Copy git branch
   name / `Cmd/Ctrl+Shift+.`). Branch names that include the issue ID are
   Linear's preferred auto-link path.
2. **PR body** — include a **closing** magic word and the issue ID so merge
   automation can complete the issue:

   ```text
   Fixes CL-1234
   ```

   Full Linear URLs also work. Prefer the body over stuffing the ID into the
   PR title so the title stays a plain-English sentence.

3. Do **not** put `CL-…` in commit subjects or bodies.

**Closing magic words** (issue moves to Done on merge when automation is
configured): `close`, `closes`, `fix`, `fixes`, `resolve`, `resolves`,
`complete`, `completes`, `implement`, `implements` (and tense variants).

**Non-closing** (link only; do not auto-complete): `ref`, `refs`, `related to`,
`relates to`, `part of`, `contributes to`, `toward`, `towards`.

Use non-closing words for partial work or multi-issue branches. Only issues
this PR fully completes get a closing word.

To deliberately **not** link an issue whose ID appears in the branch name:

```text
skip CL-1234
```

(or `ignore CL-1234`).

### When work tracks a GitHub issue only (MUST)

Same pattern in the PR body:

```text
Fixes #123
```

### When there is no tracker

Omit magic words. Do not invent issue IDs.

### At PR-open (SHOULD)

When the PR is ready for review (not a draft or WIP), move the linked Linear
issue to In Review. Never mark Done on PR-open. Done is after merge, when every
outcome is complete.

### After merge (SHOULD for agents running the full workflow)

1. Confirm the PR is merged and CI is green on the merge commit.
2. Comment the PR URL and merge SHA on the Linear issue.
3. Tick only description checkboxes that `main` actually completed.
4. Mark the Linear issue Done only when every outcome is truly done — never on
   "PR opened" alone.
5. If leftover work remains, set the issue to In Progress. Do not leave it In
   Review after merge.

## Contributor License Agreement

All contributions require acceptance of the Contributor License Agreement in
`CLA.md`. The CLA grants ABK Labs, Inc. rights needed to distribute
contributions under the project license and alternative terms.

CLA Assistant enforces this on pull requests (see `.github/workflows/cla.yml`).
Sign once by posting a PR comment with exactly:

```text
I have read the CLA Document and I hereby sign the CLA
```

Signatures are stored on the `cla-signatures` branch and do not touch `main`.

## Architecture docs

- `docs/ARCHITECTURE.md` — reactor loop, events, directors, permissions
- `docs/IMPLEMENTATION.md` — runtime, config, CLI, state
- `docs/PRODUCT.md` — product goals
- `docs/TUI.md` — terminal UI behavior
- `AGENTS.md` — coding conventions agents and contributors share

## Questions

Open a GitHub issue for design discussion or bugs that are not
security-sensitive. For security reports, see `SECURITY.md`.
