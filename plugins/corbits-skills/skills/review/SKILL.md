---
name: review
description: Review a branch, PR, or path. Determines base and scope, judges only the branch diff, and reports findings with evidence. Does not implement fixes.
argument-hint: "[paths | PR | diff | hygiene | architecture]"
---

# Review

How to review a branch, pull request, or path. Findings only — do not implement fixes.

Load this skill when performing a code review or pull request review. Hygiene-only asks still follow this skill (nits with receipts). Architecture-only asks still follow this skill (structure and boundaries with evidence).

## Base branch

Determine the base before reviewing. Use these methods in order:

### 1. Associated PR/MR

```bash
gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null
glab mr view --output json 2>/dev/null | jq -r '.target_branch'
```

### 2. Upstream tracking

```bash
git config --get branch.<branch-name>.merge
```

### 3. Merge-base with default branches

```bash
for base in main master develop; do
  if git rev-parse --verify "origin/$base" >/dev/null 2>&1; then
    echo "$base: $(git merge-base "origin/$base" HEAD)"
  fi
done
```

If none of these is clear, `ask_operator` which branch to use as the base. Do not guess `main`. A wrong base includes out-of-scope changes or misses in-scope ones.

## Scope

Only commits on the branch under review are in scope. Use the three-dot diff:

```bash
git log --oneline <base>..HEAD
git diff <base>...HEAD
git diff <base>...HEAD -- <file>
```

## Pre-existing code

A bug, convention violation, or inconsistent name that existed before the branch is out of scope — including a refactor that keeps a pre-existing type, variable, or pattern.

Evaluate only what the branch introduced.

## Convention compliance

New logic, patterns, and naming must follow the project's conventions. Pre-existing code that appears in the diff because of a refactor is exempt.

For TypeScript, load the `typescript` skill.

## Delegating file review

When delegating a file review, pass `git diff <base>...HEAD -- <file>`, not the full file. A reviewer who sees the whole file cannot tell branch changes from pre-existing code.

If a full file is required for context, name the line ranges the branch modified and that only those ranges are in scope.

## Test coverage

Do not request tests for behavior a well-maintained library already provides. Ask for coverage on:

- Business logic and domain-specific validation
- Integration points
- Error paths and edge cases
- Custom algorithms and transformations

## Signal over noise

Help the author. Do not burden them.

- Do not flag hypotheticals the code does not need to handle now
- Do flag architectural choices that constrain future work, even if they work today
- Do not leave style nits that do not affect correctness, readability, or maintainability (hygiene-only reviews are the exception)
- Do not say "this could be cleaner" without a concrete reason it matters

If it should be fixed, say so. If it is not worth fixing, do not bring it up.

## Comment tone

Write as to a colleague:

- Questions or proposals, not commands — "Could we extract this?" not "Extract this."
- Explain why, not only what
- Describe the consequence, not "wrong" / "broken" / "bad"
- Small fix → suggest the one-liner
- Do not soften feedback until the author cannot tell whether something must change

## Describe the branch as it stands

Describe the current diff against the base, not the journey that produced it. Re-derive from `git diff <base>...HEAD`. Do not trust an existing PR description.

Bad: "I refactored the retry logic to use exponential backoff."
Good: "The HTTP client retries transient failures with exponential backoff."

Past-tense journey framing rots as the branch iterates. Present tense of what the code now does stays true.

## Cite the check

Every affirmative claim ("tests pass", "messages are clean", "no regressions") needs a concrete check: a command whose output was read, a file/line range examined for a named pattern. "It looked fine" is not a check.

When a check cannot be cited: run it, strike the claim, or narrow to what was actually examined.

- "Tests pass." → "`bun run test` exited 0," or strike.
- "No race conditions." → "read `lock.go:42-68`; no acquire-while-holding cycles in those lines. Did not analyze `pool.go`."

## Reviewer-of-record checks

The agent whose verdict ships must run these in-session and read the raw output. Do not delegate them.

- `git diff <base>...HEAD --stat` — scan for unexpected `Bin` markers and files outside stated scope
- `git log --oneline <base>..HEAD` — commits must match the issue/ask scope
- The subject and body audits under Commit-message style

File-by-file behavioral review may be delegated. The checks above may not.

## Commit-message coherence

For every commit: read the message, read `git show <sha>`, confirm they match. Flag undescribed material changes, unmentioned behavior, or drive-by formatting in an unrelated commit.

The message is a summary, not a line-by-line narration. Surprise vs the diff is the bar.

## Commit-message style

Canonical rules live in the `style` skill. Audit independently of coherence.

Subjects (`git log <base>..HEAD --format='%s'`):

- No `word:`, `[tag]`, or `(scope)` prefixes (`feat:`, ticket IDs, `WIP:`)
- No filenames or paths
- No trailing punctuation
- No vague subjects ("Update code", "Fix bug", "Address review")
- Length: `git log <base>..HEAD --format='%s' | awk 'length > 72'` — empty is clean

Bodies (`git log <base>..HEAD --format='%b'`):

- No tracker IDs or PR/session references
- No "previous commit" / "next commit" series talk
- Length: `git log <base>..HEAD --format='%b' | awk 'length > 72'` — empty is clean

Affirmative claims about these audits must cite the command. See Cite the check.

## Checklist

Items marked _(reviewer-of-record)_ stay with the agent whose verdict ships.

1. Determine the base branch
2. `git log --oneline <base>..HEAD` _(reviewer-of-record)_
3. `git diff <base>...HEAD --stat` _(reviewer-of-record)_
4. Review each changed file, only lines the branch modified
5. Per commit: message matches diff; subject/body pass the style audit _(reviewer-of-record)_
6. New code follows project conventions
7. Summarize findings with `path:line`; cite the check behind any affirmative claim
8. If the review targets an open GitHub PR and the operator asked to post, post it (see below)

## Post on GitHub

Post only when the operator asked to leave a review on an open PR (or `pull-request-review` / a PR URL made that the job). A local read with no PR is done in chat.

Use a real review, as the operator's `gh` identity — never a vendor bot:

```bash
gh pr review <number-or-url> --approve|--comment|--request-changes --body "$(cat <<'EOF'
<body>
EOF
)"
```

Body shape:

```markdown
## Review · <Approve | Comment | Request changes>

<one present-tense line on what the branch does>

### Findings

- `path/to/file.ts:12` — <problem and why it matters>
```

Hard bans: throat-clearing, AI filler, journey narration, emoji, restating the diff with no finding, "LGTM" alone.

Every finding has `path:line` and a concrete failure mode. If it is not worth the author's time, drop it.

After posting, paste the review URL. `--request-changes` means the PR is not merge-ready.

## After the report

Synthesize Summary / Findings / Blockers / Paths. Do not land fixes. If the operator then wants repairs, that is a later `/implement` — not this skill.
