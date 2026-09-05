---
name: review
description: Perform a code review or pull request review on a branch
---

# Code Review

Use this skill when performing code reviews or pull request reviews.

## Base Branch Determination

Before reviewing, you must determine the correct base branch. Use these methods
in order of reliability:

### Method 1: Check for Associated PR/MR

If the branch has an open pull request or merge request, use the PR's target:

```bash
# GitHub
gh pr view --json baseRefName --jq '.baseRefName' 2>/dev/null

# GitLab
glab mr view --output json 2>/dev/null | jq -r '.target_branch'
```

### Method 2: Check Upstream Tracking

If the branch tracks a remote branch that itself branched from somewhere:

```bash
git config --get branch.<branch-name>.merge
```

### Method 3: Find Merge Base with Default Branches

Attempt to find a common ancestor with likely default branches:

```bash
# Check if main or master exists and find merge-base
for base in main master develop; do
  if git rev-parse --verify "origin/$base" >/dev/null 2>&1; then
    merge_base=$(git merge-base "origin/$base" HEAD)
    echo "$base: $merge_base"
  fi
done
```

This helps identify which branch HEAD diverged from, but does not guarantee
the intent of the branch author.

### When Base Cannot Be Determined

If none of the above methods provide a clear answer, do not assume. Ask the user:

> I cannot determine which branch this was based off. What branch should I use
> as the base for comparison? Common options include `main`, `master`, or
> `develop`.

Proceeding with an incorrect base will cause the review to include out-of-scope
changes or miss in-scope changes.

## Scope Determination

Focus only on commits that are contained within the branch being reviewed.
Use `git diff <base-branch>...HEAD` to determine what is in scope.

```bash
# List commits on the branch
git log --oneline <base-branch>..HEAD

# Get the full diff for review
git diff <base-branch>...HEAD

# Get diff for a specific file
git diff <base-branch>...HEAD -- <file>
```

## Pre-existing Code

If a bug, convention violation, or inconsistent naming existed in code before
the branch, do not treat it as a problem in the review. This includes cases
where refactored code retains a pre-existing type name, variable name, or
pattern that does not match current conventions.

Only evaluate the changes introduced by the branch.

## Convention Compliance

All new logic, patterns, and naming introduced by the branch should follow
the project's established conventions. Pre-existing code that appears in
the diff due to refactoring is exempt from this requirement.

If reviewing TypeScript code, consider loading the `typescript-conventions`
skill for detailed guidance on type patterns, naming, and idioms.

## Delegating to Sub-agents

When delegating file review to sub-agents, provide the output of
`git diff <base-branch>...HEAD -- <file>` rather than the full file contents.

Sub-agents that receive full files cannot distinguish branch changes from
pre-existing code and will flag out-of-scope issues.

If full files must be provided for context, explicitly instruct the sub-agent
which line ranges were modified by the branch and that only those ranges are
in scope.

## Test Coverage Philosophy

Do not request additional test coverage for functionality provided by external
libraries. Focus test coverage requests on:

- Business logic and domain-specific validation
- Integration points between components
- Error handling paths and edge cases
- Custom algorithms and data transformations

Trust well-maintained libraries to do their job. If a library's behavior needs
testing, that suggests reconsidering whether to use that library.

## Signal Over Noise

A review should help the author, not burden them. Do not raise issues that are
not important to the code being reviewed. Specifically:

- Do not flag hypothetical problems in unlikely scenarios that the code does
  not need to handle today or in the near future.
- Do flag architectural choices that would limit or constrain future
  implementations, even if they work fine today.
- Do not leave minor stylistic nits that have no impact on correctness,
  readability, or maintainability.
- Do not make vague observations like "this could be cleaner" without a
  concrete reason it matters.

If something should be fixed, say so directly. If it's not worth fixing, don't
bring it up.

## Comment Tone

Review comments are posted under your name to a human author. Write them
as you would speak to a colleague:

- Frame suggestions as questions or proposals, not commands.
  "Could we extract this?" not "Extract this."
- Explain the *why* -- "so that X" or "because Y" -- not just the *what*.
- Avoid words like "wrong", "broken", "bad". Describe the consequence
  instead: "this will produce incorrect values when..." not "this is wrong."
- If the fix is small, suggest it concretely. A one-liner suggestion is
  more helpful than a paragraph explaining what to change.
- Do not soften feedback to the point of obscuring it. The author should
  understand whether something needs to change or is merely a thought.

## Describe the Branch As It Stands

Review comments and PR descriptions must describe the branch's *current* diff against the base, not the journey that produced it. The merged result is what ships; intermediate states, earlier review rounds, and pre-iteration code are not part of the artifact.

Re-derive the description from `git diff <base>...HEAD` every time. Do not trust the existing PR description — it may have been written before the branch was iterated on, and reviewers reading it now should see what is true now.

Bad: "I refactored the retry logic to use exponential backoff and removed the old fixed-delay path."
Good: "The HTTP client retries transient failures with exponential backoff."

Bad (review comment): "This used to call `foo()` but now calls `bar()` — did you mean to..."
Good (review comment): "`bar()` is being called here without checking its return value."

Past-tense framing rots: as the branch evolves through review, descriptions of "what was changed" stop matching the diff. Present-tense framing of "what the code now does" stays correct as long as the diff is correct.

## Cite the Check

A review report may include affirmative verification claims — "tests pass," "messages are clean," "no regressions," "convention compliance verified." When a review says something is *verified*, the reader takes that as a checked fact. If the check was never run, the report is dishonest. The dishonesty does not surface until a human reviewer finds the issue the agent claimed did not exist.

**For every affirmative claim in your review, you must be able to cite the specific check that proved it.** A check is a concrete artifact: a command whose output you read, a tool invocation whose results you inspected, a file/line range you examined for a specific pattern. "I considered it" and "it looked fine to me" are not checks.

When you cannot cite a check, do one of:

1. **Run the check** and cite it.
2. **Strike the claim** from the report.
3. **Narrow the claim to what you actually examined.** "Did not observe race conditions in `lock.go:42-68`" is honest; "no race conditions in the new locking code" is not.

Some properties — subtle concurrency bugs, performance pathologies, security gaps — cannot be fully verified by a single check. Honest narrowing is better than a dishonest absolute: say what you looked at and what you looked for, and do not claim absence beyond that boundary.

**Bad → Good:**

- "All commit messages are clean." → cite the specific audit command (see *Commit-Message Style Audit*), or strike.
- "Tests pass." → "`npm test` exited 0," or strike.
- "Convention compliance verified." → "diffed naming and error-handling shape in the new handlers against `src/api/user.ts` and `src/api/billing.ts`; same `Result<T, E>` return pattern, same `assert`-style guards," or strike.
- "No race conditions." → "read `lock.go:42-68`, traced lock acquisition order; no acquire-while-holding cycles in those lines. Did not analyze interactions with `pool.go` or callers outside the diff."

## Reviewer-of-Record Checks

"Cite the Check" requires that affirmative claims have backing. This rule narrows it: for the checks below, the backing must be the reviewer-of-record's own eyes on raw output. The reviewer-of-record is the agent whose verdict ships — when a workflow delegates the deeper read to a subagent, the orchestrator remains the reviewer-of-record and these checks stay with them.

Their value is in catching unknown-unknowns. A delegate asked for "a punch list of findings" returns things that fit the punch-list shape; `Bin 0 -> 8181 bytes` on a `.ts` file does not look like a finding, it looks like stat noise, and gets collapsed away. Only direct inspection preserves the signal.

**Reviewer-of-record must run, in-session, and read the raw output:**

- `git diff <base>...HEAD --stat` — scan for `Bin` markers on any file you did not expect to be binary (source code, markdown, config) and for files outside the branch's stated scope.
- `git log --oneline <base>..HEAD` — confirm the commits on the branch match the issue's scope; unexpected or off-topic commits are stop conditions.
- The subject and body audits enumerated under *Commit-Message Style Audit*. That section is the canonical command catalog and pattern list; this section's contribution is the delegation rule — those audits are reviewer-of-record, not subagent work.

Delegating the deeper read (file-by-file behavioral review, architectural analysis, commit-message coherence) to a subagent is fine and often valuable for context isolation. Delegating the checks above is not — their value is the raw output landing in front of the reviewer-of-record's eyes.

## Commit-Message Coherence

Each commit's message is a claim about what the commit contains. Verify that
claim. For every commit on the branch, read the message, read the diff
(`git show <sha>`), and confirm that the two match.

If a commit contains material changes that are unrelated to its message —
files touched that have nothing to do with the stated purpose, unmentioned
behavioral changes, or new functionality that the message does not describe —
flag it. Undescribed changes hiding inside a commit undermine the reviewability
and auditability of the history.

This includes whitespace or formatting changes to code that is not otherwise
being modified. Drive-by cleanup belongs in its own commit — its presence in
an unrelated commit is itself a problem.

Do not require that every modified line be individually narrated in the message.
The message is a summary. But if someone reading only the message would be
surprised by what the diff actually contains, that is a problem worth raising.

## Commit-Message Style Audit

Coherence (above) checks that each message accurately describes its diff. Style audit checks that each message conforms to the project's commit-message rules (see the `style` skill, which is the canonical source for the prefix-family list and other rules). The two are independent; both have to be run.

Each check below is reviewer-of-record territory (see *Reviewer-of-Record Checks*) — run them in-session and read the raw output yourself. Do not delegate them; a subagent asked to "verify style compliance" will return a generic "looks fine" read with no audit trail.

**Subject-line audits.** Most checks scan the output of:

```bash
git log <base>..HEAD --format='%s'
```

Scan for:

- **Prefix violations.** Any subject starting with a `word:`, `[tag]`, or `(scope)` pattern. Includes Conventional Commits (`feat:`, `fix:`), component or scope prefixes (`Anthropic adapter:`, `mm:`, `[X86]`), ticket IDs (`INTR-79:`), and status tags (`WIP:`). Project convention is plain English sentences; any prefix is a violation regardless of how idiomatic it looks in other ecosystems.
- **Filename or path references.** Tokens that look like file paths or extensions (`server.ts`, `INFERENCE.md`, `src/foo/bar.py`). The diff lists what changed; subjects describe the change, not the file.
- **Trailing punctuation.** Subjects ending with `.`, `!`, or `?`.
- **Vague subjects.** "Update code," "Fix bug," "Misc changes," "Address review."

For the length limit, use a length-aware filter so the check is not eyeball-counting:

```bash
git log <base>..HEAD --format='%s' | awk 'length > 72'
```

Empty output is clean. Any line returned is an over-72-character subject violation.

**Body audits.** Most checks scan the output of:

```bash
git log <base>..HEAD --format='%b'
```

Scan for:

- **External tracker references.** Linear/Jira/GitHub IDs (`INTR-79`, `JIRA-1234`, `#456`, `Closes XXX-99`). The commit must explain itself.
- **References to other commits in the series.** "as discussed in the previous commit," "the next commit wires this up," "see also abc1234." A commit describes its own state, not the branch's trajectory.
- **References to PR review comments or session conversation.** Ephemeral context the future reader cannot access.

For body-line length, use the same length-aware filter:

```bash
git log <base>..HEAD --format='%b' | awk 'length > 72'
```

Empty output is clean. Any line returned is an over-72-character body line.

Affirmative claims about these audits must cite the specific command whose output proved them — see **Cite the Check**.

## Review Checklist

Items marked *(reviewer-of-record)* must be run by the agent whose verdict ships — see *Reviewer-of-Record Checks*. Do not delegate them to a subagent. Unmarked items are delegable.

1. Determine the base branch using the methods in "Base Branch Determination"
2. Run `git log --oneline <base>..HEAD` to understand the scope *(reviewer-of-record)*
3. Run `git diff <base>...HEAD --stat` to see which files changed *(reviewer-of-record)*
4. Review each changed file, focusing only on lines modified by the branch
5. For every commit on the branch, verify:
    - Diff matches the commit message (see "Commit-Message Coherence")
    - Subject and body pass the style audit (see "Commit-Message Style Audit") *(reviewer-of-record)*
6. Check that new code follows project conventions
7. Summarize findings with specific file:line references; cite the check behind any affirmative claim (see "Cite the Check")
