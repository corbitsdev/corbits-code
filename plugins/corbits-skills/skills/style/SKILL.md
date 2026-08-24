---
name: style
user-invocable: false
description: Coding conventions for clean, maintainable output. Load when writing or reviewing code in any language.
---

# Style

Guidance for code and commit quality. These are conventions that improve what you ship — not a checklist ceremony, and not a substitute for project rules already in the repo.

Load alongside `philosophy` when architectural judgment is in play. Language-specific patterns live in skills like `typescript`.

## Git repository

Prefer a git repository so changes can be tracked, reviewed, and reverted.

Edits, tests, and reports are allowed in a folder that is not a git repository. Do not refuse the task. Do not `git init` unless the operator asked you to create a repository.

Commits, amends, rebases, and isolated worktree work need an existing repository. If the operator asked to commit and there is none, say so and stop — do not invent one.

## Comments

Code should be self-documenting. Do not narrate what the code already says. Decorative dividers and section banners are noise.

Comments earn their keep when they explain:

- Non-obvious algorithms
- Workarounds and edge cases
- Business rules a reader would not infer from the code
- Genuine blockers (see TODO markers below)

```
// Bad — restates the next line
// Base configuration type for all backends
BaseConfigArgs = { level: LogLevel }

// Good — silence when the name is enough
BaseConfigArgs = { level: LogLevel }

// Good — names a real blocker
// XXX — temporary until upstream releases the fix for <issue>
result = await legacyMethod()
```

**TODO / FIXME / XXX are not deferral.** Reserve them for work blocked outside your control (upstream bug, unreleased API, missing access, another team's queue). Name the blocker so a reader knows what would unblock it.

Do not park work you could do now, ran out of patience for, hope someone else will finish, or have not decided yet. If you can do it now, do it now.

**Comments describe the current code.** Do not refer to other commits — neither what an earlier one changed nor what a planned follow-up will do. A planned commit does not exist until it lands. If something is intentionally a stub, say why it is a stub _now_.

## Commits

Commits should read like a story of why the tree changed.

**Organization**

- One logical unit per commit
- Separate refactors from feature work; separate formatting from logic
- Amend HEAD to refine the most recent commit (missed files, wording, critique fixes)
- Fix an earlier unpushed commit with edit-in-place via the `git-rebase` skill — do not inline rebase recipes here

**Subject**

- Max 72 characters, non-empty, no trailing punctuation, no abbreviations
- Plain English starting with a verb — no Conventional Commits tags, no scope/component prefixes, no ticket IDs, no severity markers (`feat:`, `INTR-79:`, `[WIP]`, …)
- Sample recent subjects first (`git log origin/main --format='%s' | head -20`) and match the project's voice. A predominant local prefix convention may override the no-prefix rule; mixed signals fall through to no prefix

```
Add retry logic for failed network requests
Fix race condition in transaction verification

feat: add retry logic                  (banned prefix)
INTR-79: add retry logic               (banned ticket prefix)
Fix bug in server.ts                   (filename in subject)
```

**Self-contained.** The message must stand alone for a stranger with only the repo years from now. Do not cite file paths (the diff lists them), trackers, PR discussion, or the commit's place in a series ("next commit wires this up").

**Body.** Most commits need none. Add a short body only when the diff alone cannot answer _why_ this change, why now, or why not the obvious alternative. Cut: restating the diff, recapping the work session, pointing at the PR, or explaining general system behavior (that belongs in code comments or docs).

```
Switch retries to exponential backoff with full jitter.

Fixed-interval retries synchronized thundering herds against the
upstream rate limiter during partial outages. Full jitter
decorrelates clients without losing the backoff guarantee.
```

## Naming

Preserve acronym capitalization — acronyms are not words:

```
JSONSchema, HTTPClient, parseJSON, requestURL
JsonSchema, HttpClient, parseJson, requestUrl   // bad
```

## Documentation maintenance

When code changes, update the docs that would otherwise lie — READMEs, API docs, comments that describe old behavior, config examples — in the same commit as the code.

## Scope

Touch only what the task requires. Drive-bys (reformat, rename, comment tweaks, "while I'm here" refactors) pollute diffs and risk breakage.

Scope is not the narrowest possible reading of the ask. In scope: what was requested, what correctness/safety requires, and necessary follow-through (callers, tests, docs that now lie). Out of scope: tangential improvements noticed in passing.

When something is in scope but inconvenient, do it now in a properly scoped commit. Not a TODO. Not "later." If it truly cannot land here: a separate commit on this branch, a follow-up PR opened in this session, or a tracked issue with acceptance criteria and an owner. Anything else is dropping the work.

## Reuse and dead code

Search before reimplementing. Prefer extending or promoting an existing helper over a parallel copy. When a choice between refactor, promote, or new implementation is material, ask the operator — do not invent a private duplicate.

When a refactor replaces an old path and all callers are updated, delete the old path. No compatibility shims, `_unused` renames, or `// removed` tombstones for internal code. See `philosophy` for why.

## External code

Code from outside the organization needs license-compatible attribution in its own unmodified commit (source, author/copyright, license, date retrieved). Modifications land in a separate follow-up commit that explains what changed and why.

## Validation and defaults

Never trust external input. Validate at the boundary where data enters (handlers, CLI parsers, config loaders, consumers). Once past the boundary, internal code trusts it. If invalid data travels through multiple layers before failing, the boundary is in the wrong place.

Defaults live at that same edge. Resolve omissions into concrete values once, then hand fully-populated arguments inward. Do not scatter read-site fallbacks (`dict.get(k, default)`, `value ?? fallback`, and kin) through business logic — they hide missing values as if the caller supplied them. Signature defaults are fine when the function itself is a boundary.

## Build verification

Run the project's full verify path before declaring done. Partial package builds are not a substitute. Report failures; if a failure is pre-existing and unrelated, say so and let the operator decide. Never silently skip a failing step.

## Configuration

Do not modify lint/format/tsconfig (and similar) unless explicitly asked. Changing conventions is an explicit decision, not a side effect of other work.

## Personality

No emojis in code or documentation. Stay professional.
