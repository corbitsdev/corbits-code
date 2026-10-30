---
name: review
description: Review a branch or pull request diff and report findings.
argument-hint: "[branch | PR number | PR URL]"
---

# Review

Classify the target, resolve the base, dispatch only the lenses it warrants, verify, and report. Findings only: do not implement fixes.

Requires a git repo. Run `git rev-parse --show-toplevel`; if it fails, stop and tell the operator to `git init` first.

## 1. Classify

- **Diff:** a branch, PR, or path. The common case.
- **Topic:** an architecture or approach question.
- **Interview:** only when the review object is genuinely missing. Never as ritual.

The primary dispatches with `spawn_agent`, one target per wave: `reviewer` always, `planner` when architecture, API, or approach is at stake, `designer` or `warden` only when the touched files warrant that lens (UI surface, security-sensitive code). Do not fan out a default wide fleet.

Reviewer owns the code-defect analysis and code verdict. Dispatch owns target resolution, the metadata checks below, findings dispositions, and synthesis; it does not redo the file-by-file review. Workers start blank: supply the worktree, scoped diff, intent, relevant context, `success_criteria`, `do_not` forbidding product fixes, and `report_focus` requiring concrete findings and verification evidence.

## 2. Resolve the target and base

For a PR (number, URL, or branch), review from a worktree, never the local checkout:

1. `gh pr view <ref> --json headRefName,baseRefName,number,url`. Stop and ask if it does not exist.
2. `git fetch origin <head-branch>`, then create a worktree with `use_skill("git-worktrees")`.
3. Use the PR's base as the diff base.

For a local branch, take the base from its open PR (`gh pr view --json baseRefName`), else from upstream tracking, else the merge base with `origin/<default-branch>`. If none is clear, ask; a wrong base pulls in out-of-scope changes or hides in-scope ones.

If any step fails, stop and ask instead of working around it.

## 3. Scope

Review only what `git diff <base>...HEAD` shows. Pre-existing bugs, names, and patterns in touched code are not findings. New logic, names, and patterns follow project conventions (`AGENTS.md`, and the `typescript` skill for TypeScript). Ask for tests only for your own logic, integration points, error paths, and edge cases, never for what a library already guarantees.

When delegating, give the sub-agent `git diff <base>...HEAD -- <file>`, not whole files. If it needs a full file for context, name the modified line ranges and say only those are in scope.

## 4. Reviewer-of-record checks

Dispatch runs these metadata checks itself and reads the raw output. They are not delegable; a delegate collapses `Bin 0 -> 8181 bytes` on a `.ts` file into noise. These checks complement reviewer's code verdict; they do not authorize Dispatch to take over behavioral review.

- `git diff <base>...HEAD --stat`: look for `Bin` markers on files that should be text, and files outside the stated scope.
- `git log --oneline <base>..HEAD`: commits must match the ticket's scope.
- Commit messages: each subject and body follows `CONTRIBUTING.md`, and each diff matches its message. Scan `git log <base>..HEAD --format='%s'` and `--format='%b'` (pipe through `awk 'length > 72'` for length). Flag a missing or unknown type, ticket ids, status tags, file paths in subjects, trailing punctuation, vague subjects, references to other commits or to review conversation.

Deeper work (file-by-file behavior, architecture, coherence) can go to sub-agents.

## 5. Findings

Raise what helps the author. Flag real defects and architecture that would constrain future work. Skip hypothetical problems in cases the code need not handle, stylistic nits, and vague remarks like "could be cleaner".

- Every finding has a `path:line` and a concrete failure mode. Severity is the review action, not adjectives.
- Describe the branch as it stands now, in present tense, from `git diff <base>...HEAD`, not the journey or the PR description.
- Write to a colleague: propose rather than command, say why, describe consequences instead of "wrong" or "broken", and suggest the one-liner when the fix is small.
- **Cite the check.** Every affirmative claim ("tests pass", "no regressions") names the command or file range that proved it. Otherwise run the check, strike the claim, or narrow it to what you examined ("read `lock.go:42-68`, no acquire-while-holding cycle there").

## 6. Report and post

Summarize with the findings. When the target has an open GitHub PR, post the finished review on it; a review that only lives in chat is not done. Post when the operator asked for a PR review, when `/implement`'s whole-branch gate runs on a branch with an open PR, or when a record on the PR is the purpose. Do not post a private local read. Do not implement fixes. Do not reopen the analysis while writing the body.

Wait until every pass Dispatch started has reported. Passes do not post to GitHub and do not approve, comment, or request changes.

Then post exactly one review with `gh pr review`. One verdict for the whole diff. Use one of `--approve`, `--comment`, or `--request-changes`, and swap that flag to match the verdict:

```bash
gh pr review <number-or-url> --comment --body-file <file>
```

The body is for a person first. Open with what the branch does now, in plain language. Then what goes wrong, in plain language. Do not name the passes. Do not use finder jargon (no "trust check", "lens", "nullMeansUnset", "injected parser").

Under that, each finding is one bullet an agent can act on: `path:line`, then the concrete failure mode. A clean review says "No findings." after the plain summary. No throat-clearing, praise to soften a finding, emoji, or "nit:" taste.

```markdown
<what the branch does now, in plain language>

<what goes wrong, in plain language>

- `path/to/file.ts:12` — concrete failure mode
```

The note back to the operator is that same body plus the review URL. Do not write a second, more technical summary in chat. Posting does not change Linear state. Remove the PR worktree afterward.
