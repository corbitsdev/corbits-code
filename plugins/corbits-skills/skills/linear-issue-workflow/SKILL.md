---
name: linear-issue-workflow
description: Implement a feature or fix based on a Linear issue
argument-hint: "<issue-id> [--reviewer <reviewer>]"
user-invocable: false
---

# Linear Issue Workflow

Use this skill when implementing features or fixes tracked in Linear.

## Phase 1: Fetch and claim

Fetch the Linear issue using `mcp__linear__get_issue`. The returned issue includes title, description, status, branch name, and other metadata you will need later.

**Claim immediately (hard first step):** before worktree setup, explore, plan, or any build thrash, set the issue to "In Progress" with `mcp__linear__save_issue`. Teammates must see ownership before you dig. Parallel lanes each claim their own issue ID — never claim a sibling lane's ID.

If Linear MCP is unavailable or `save_issue` fails when claiming, report that the issue status could not be updated. Do not pretend the claim succeeded.

Ask the user clarifying questions if the scope is unclear before proceeding.

## Phase 2: Set Up Worktree

Read the branch name from the `branchName` field on the issue fetched in Phase 1 (call `mcp__linear__get_issue` again if needed).

Load `use_skill("git-worktrees")` and follow the create-from-origin/<default-branch> recipe (substitute `<branch-name>`). Worktrees do not share `node_modules`.

All subsequent work — exploration, planning, implementation, and review — happens in the worktree directory.

## Phase 3: Explore and Plan

1. Use the `explore` director to understand the codebase. Brief it with the absolute path to the worktree (it must `cd` there before doing anything else), and ask it to cover:
   - Where changes need to be made
   - Existing patterns to follow
   - Related code that might be affected

2. Create an implementation plan covering:
   - Files to modify
   - New functions/types to add
   - Tests to write

3. Present the plan to the user and ask if they would like any changes before proceeding. Do not start implementation until the user approves the plan.

   If the user rejects the plan and the issue cannot be salvaged with a revised plan, tear down the worktree and branch with the Phase 7 commands rather than leaving them stranded.

4. Attach the plan as a file to the Linear issue. **Do not post the plan as a comment** — comments are for discussion, not archives, and a multi-page plan dumped inline creates noise on the issue.

   The procedure has four steps, three of which are MCP or HTTP calls. The signed upload URL from `prepare_attachment_upload` expires 60 seconds after it is returned, so steps 2 and 3 must happen in immediate succession — do not pause for unrelated work between them.

   1. Write the plan to a file under the worktree's `tmp/` (e.g., `tmp/plan-<ISSUE-ID>.md`). `tmp/` is the project's throwaway directory — do not commit the file (and if the project does not yet have `tmp/` gitignored, do not add to git). Capture its byte size with `wc -c < tmp/plan-<ISSUE-ID>.md`.

   2. Call `mcp__linear__prepare_attachment_upload` with `issue`, `filename`, `contentType: "text/markdown"`, and `size`. The response contains `uploadRequest.url`, `uploadRequest.headers`, and `assetUrl`. **Step 3 must follow within 60 seconds — the signed URL expires.**

   3. PUT the raw file bytes to `uploadRequest.url`. Pass every header from `uploadRequest.headers` verbatim — exact casing is required; modified or omitted headers return HTTP 403. One `-H` flag per entry:

   ```bash
   curl -X PUT --data-binary @tmp/plan-<ISSUE-ID>.md \
     -H "<header1-name>: <header1-value>" \
     -H "<header2-name>: <header2-value>" \
     "<uploadRequest.url>"
   ```

   Do not base64-encode the file, do not transform it. If the PUT fails with 403 because the URL expired (more than 60 seconds since step 2), **call `prepare_attachment_upload` again for a fresh URL** — retrying the dead URL will keep failing.

   4. Call `mcp__linear__create_attachment_from_upload` with `issue`, the `assetUrl` from step 2, `title: "Implementation plan"`, and `subtitle: "<ISSUE-ID>"` (so the entry stays identifiable if multiple plans accumulate across re-plans).

   Keep the local file through implementation and review — it is the working reference, colocated with the code in the worktree's `tmp/`. Phase 7's `git worktree remove` deletes it along with the rest of the worktree. The Linear attachment is the canonical copy; the local file is a working convenience for the active branch. Re-planning overwrites the local file — Linear retains prior versions as separate attachments via the `<ISSUE-ID>` subtitle.

   Exception: plans with no structure — no file-by-file breakdown, no enumerated steps, no headings, no nested lists — can be posted as a comment instead. Structural shape, not length, is the test; a single-sentence plan is fine inline, a 10-line bulleted plan is not.

## Phase 4: Implement

Carry out the plan from Phase 3 in the worktree using whichever implementation approach fits the work and your role.

Break the work into commit-sized units. Each commit should represent one logical change that can be reviewed and understood independently.

### Keep the issue checkboxes current

If the issue description contains a task list (`- [ ]` items), tick the boxes as you complete each one. The checkboxes are the issue's at-a-glance progress signal — leaving them stale makes the issue lie about what's done.

Update the description with `mcp__linear__save_issue`, passing the full description with the relevant `- [ ]` flipped to `- [x]`. Do not rewrite or reorganize the surrounding text — only flip the box. Update as each item finishes, not in a single batch at the end; partial progress is what the checkboxes exist to show.

If the issue description has no task list, skip this step — do not invent one.

## Phase 5: Self-Review

Once implementation is complete, run a **whole-branch code review** before pushing. The review covers the entire diff from the base branch to HEAD — not just the most recent commit — so any finding anywhere in the branch's history is in scope.

### Reviewer-of-Record Checks (in-session)

The reviewer-of-record is the agent whose verdict ships — in this workflow, you, the orchestrator. Before delegating any part of the review, run the audits whose value depends on the reviewer-of-record's own eyes on raw output. The canonical command list and patterns live in `review`'s _Reviewer-of-Record Checks_ and _Commit-Message Style Audit_ sections; load `review` and follow them in this session.

Read the raw output. Stop conditions — fix before continuing:

- Any violation surfaced by the commit-message audits. The canonical pattern lists (prefixes, vague subjects, body issues, length limits) live in `style` and `review`'s _Commit-Message Style Audit_; this section does not maintain a copy.
- `Bin` marker on any file you did not expect to be binary (source code, markdown, config).
- Files in the diff outside the issue's scope.

After fixing a stop condition, re-run the in-session checks. Repeat until the output is clean. Do not dispatch the critic until then.

### Critic review (deeper read)

Dispatch the `critic` director for the file-by-file behavioral read, architectural review, and commit-message coherence check. Running these in a fleet agent keeps the deeper output out of the main context and gives independent eyes on patterns.

Brief the critic with:

- The absolute path to the worktree (it must `cd` there before doing anything else).
- The base branch to diff against (the remote default branch resolved in Phase 2, e.g. `origin/main`), so `review` does not dead-end on its "ask the user" path. Make explicit that the review must cover the full `base..HEAD` range, every commit on the branch.
- An instruction to load the `review` skill and follow its checklist against the current branch, _except_ the items marked _(reviewer-of-record)_ — the orchestrator has already run those.
- The Linear issue ID and a one-line summary of the change's _intent_ — what the change is for. "This branch refactors retry logic to use exponential backoff" is fine; "this branch should not introduce blocking calls in the sendPack path" pre-frames findings and is forbidden.
- A request for findings with `file:line` references — not PR-comment prose.
- An instruction that the critic's final message must list every finding verbatim, with no summarization or omission. This prevents collapse during transmission; it does _not_ prevent the more fundamental loss of signals that do not fit a finding shape at all (binary markers, surprising stat counts). Those belong to the reviewer-of-record checks above.

Do **not** include author-supplied "blocking criteria" or "things to look for" in the brief. The skill itself is the criteria; supplementing it narrows the critic's lens to what you already suspect might be wrong, suppressing unknown-unknowns. The intent summary above is bounded for the same reason — keep it to _what the change is for_, never _what the reviewer should find_.

### Fix every finding

Treat the returned findings as a worklist and **fix every one**. The `review` skill's "Signal Over Noise" guidance has already filtered out pedantic taste-only nitpicks upstream — anything that survived to the final findings is something the reviewer judged worth the author's time. "Nit," "minor," "stylistic," and "suggestion" describe the reviewer's confidence about severity; they are not dispositions and do not authorize skipping. The only path to leaving a finding unfixed is a Greybeard waiver (see below).

- Fix issues in additional commits, or via `git rebase -i` with `edit` on the target commit when a fix belongs on an earlier commit (mark the target `edit`, make the fix at the stop, `git commit --amend --no-edit`, `git rebase --continue`).
- After fixing, re-run the reviewer-of-record checks in-session, then re-dispatch the critic against the full branch as it now stands. Every re-review is a fresh, self-contained read of `base..HEAD` exactly as it is — no scoping to the delta from a prior pass, no carryover ledger of earlier findings. The new findings replace the previous set; the previous are gone.
- Repeat fix-and-review until the review returns clean.
- Cap at three re-reviews. The cap counts critic dispatches; in-session check failures the orchestrator fixes between dispatches do not consume a slot. If findings remain after the third, stop and surface the situation to the user directly. Do not soften it: tell the user plainly that the branch has been through three review-and-fix passes and the reviewer is still finding issues, list each outstanding finding with its `file:line`, and state explicitly that the branch is **not ready to push**. Do not proceed to Phase 6, do not propose a waiver, and do not offer to "just push anyway" — wait for the user to decide whether to keep iterating, rescope the issue, or abandon the branch.

### Waivers

The only path to leaving a finding unfixed is a Greybeard waiver. If you believe a finding should not be fixed — because the "fix" would be pure churn (taste-only rewording, unrelated refactor, change the project has explicitly chosen not to make) or because you actively disagree with the reviewer — dispatch the `greybeard` director with the finding, your proposed disposition, and the relevant diff. **A Greybeard "waive" ruling is the waiver** — record it in the disposition note and move on; no further user sign-off is needed. Accept Greybeard's call by default. Escalate to the user only if (a) you actively disagree with Greybeard's ruling, or (b) the Greybeard director is unreachable or returns an unusable response. In either case, present both positions (or the failure mode) and let the user decide. Do not route routine waiver requests through the user, and never waive a finding on your own authority.

By the time the gate closes, every finding is fixed or Greybeard-waived; the findings themselves are iteration history and are not preserved as a Phase 6 artifact. Hold onto each Greybeard ruling — Phase 6 names the waivers as present-state exceptions on the branch and cites the ruling that authorized each one. Do not keep the fix SHAs, the fixed findings, or the per-iteration log; none of those describe the branch as it stands.

## Phase 6: Push and PR

Once the Phase 5 gate has cleared (the review returned clean, or every remaining finding has a Greybeard waiver), work through the steps below in order. Drafting precedes confirmation so the user authorizes specific artifacts — the title, body, and PR-review body — rather than a promise about what they will say.

### Rebase against the remote default branch

```bash
git fetch origin
git rebase origin/<default-branch>
```

Verify the build still passes after rebasing.

### Re-derive the PR artifacts from the current diff

The PR title, body, and GitHub PR-review body are PR-shaped artifacts and are bound by `review`'s _Describe the Branch As It Stands_ rule: present-tense statements of what the code _does_, never past-tense narration of how it got there.

Draft from the diff, not from memory. The implementation history is the single largest source of journey framing; memory of the work reliably reproduces it. Read the output of both:

```bash
git diff origin/<default-branch>...HEAD
git log origin/<default-branch>..HEAD --format='%s'
```

The full diff matters, not just `--stat`. `--stat` shows filenames and line counts; a present-tense description of behaviour has to come from the diff itself.

After drafting each artifact, scan it for past-tense verbs (`was`, `were`, `had`, `added`, `fixed`, `refactored`, `introduced`, `removed`, `updated`, `changed`) and rewrite each into present-tense. If the rewrite forces dropping a sentence because it has no current-state content, that sentence was journey narrative and should not have been in the artifact.

### PR title shape

A single present-tense statement of what the code does. `style`'s commit-subject rules apply: start with a verb, no leading prefix (no `feat:`, no `[scope]`, no ticket ID), no trailing punctuation, no abbreviations.

### PR body shape

```markdown
## Summary

<1-3 bullets describing what the code does, present tense>

## Verification

<facts that hold for the current branch — e.g. the build passes
(`npm test` exits 0); the `<flow>` works end-to-end against `<env>`.
State what is true now, not what was done.>

Closes <ISSUE-ID>
```

`## Summary` and `## Verification` are the only sections in the body. Do not add `## Changes`, `## Context`, `## Notes`, or other sections — the diff is right there, and additional prose either restates the diff (past-tense) or re-narrates the journey (also past-tense).

### PR review on GitHub (not a self-review issue comment)

After the PR exists, **post a real GitHub PR review** via `gh pr review`. Follow **Post the Review on GitHub** in the `review` skill.

Do **not** leave a one-line self-review issue comment (`gh pr comment` with "Self-review returned clean"). That is noise. The review body is the record.

**Clean review (common case).** Primary post:

```bash
gh pr review <number> --approve --body "$(cat <<'EOF'
## Review · Approve

<one present-tense line: what the branch does>

No findings.
EOF
)"
```

If repo policy forbids self-approve, use `--comment` with the same body shape — still a full review body, not a one-liner.

**Findings remain (should be rare after Phase 5).** Use `--request-changes` when anything blocks merge; use `--comment` for non-blocking residual notes. Body shape:

```markdown
## Review · Request changes

<one present-tense line: what the branch does>

### Findings

- `path/to/file.ts:12` — <concrete failure mode>
```

**Waivers exist.** Primary post still carries the verdict. Name each waived finding as a present-state exception; cite Greybeard as authorization. Greybeard (if it ran) posts a **separate** labeled `--comment` review that owns the waiver list — do not collapse both into one mushy paragraph.

```markdown
## Review · Approve

<one present-tense line: what the branch does>

### Notes

- `file:line` — <what the current code does>. Greybeard-authorized: <present-tense reason>.
```

```markdown
## Greybeard · Comment

Waiver rulings for this branch:

- `file:line` — authorized on <present-tense grounds>
```

**Multi-persona rule.** If Phase 5 (or an explicit user request) ran additional lenses (`critic`, `greybeard`, OSS/quality), each lens with substance posts its own labeled review. Primary owns `--approve` / `--request-changes`. Secondary lenses use `--comment` only. Do not invent personas that did not run. Body shape and hard bans live in `review` → **Post the Review on GitHub** (no AI filler, no journey narration, no "LGTM" alone).

Do not paste Phase 5 iteration history, fix SHAs, or "for context" preambles. The merged result is what ships.

### Confirm with the user

Surface the drafted title, body, and PR-review body (per persona if multi-lens) to the user. The user confirms whether to push and post with those exact artifacts. Do not push until confirmed.

### Push and post

```bash
git push -u origin <branch-name>

gh pr create \
  --title "<confirmed title>" \
  --reviewer <REVIEWER> \
  --body "$(cat <<'EOF'
<confirmed body, as drafted above>
EOF
)"
```

Then post the PR review(s) with `gh pr review` as drafted above. Paste the PR URL **and** every review URL to the user.

### Set Linear to In Review

When the PR is open and **ready for review** (not a draft or WIP), set the issue state to "In Review" with `mcp__linear__save_issue`. Do not mark Done. Done is Phase 7 only (merge + green CI + every outcome complete).

If Linear MCP is unavailable or `save_issue` fails, report that the issue status could not be updated. Do not pretend the move succeeded. Do not mark Done as a fallback.

Draft or WIP PRs stay **In Progress** until they are ready for review. Then move to In Review.

Phase 6 ends when the PR is open and the review is posted. Ready-for-review PRs must be In Review (or the operator has been told the status update failed). Draft or WIP PRs stay In Progress.

## Phase 7: After Merge — Linear Closeout and Cleanup

Phase 7 runs **after the PR is merged** and **CI is green** on the merge (or on `main` at the merge commit). Do not mark the Linear issue Done on open PR alone. Do not tick outcome checkboxes on hope.

### 1. Confirm merge

```bash
gh pr view <number> --json state,mergedAt,mergeCommit,url
```

`state` must be `MERGED`. Record the merge commit SHA.

### 2. Confirm CI green

```bash
gh run list --commit <merge-sha> --limit 5
# or
gh pr checks <number>
```

If CI is red, fix forward or reopen — do **not** tick Linear outcomes or mark Done.

### 3. Update Linear checkboxes

Re-read the issue with `mcp__linear__get_issue`. For every checklist item the merged PR actually completed on `main`, flip `- [ ]` to `- [x]` via `mcp__linear__save_issue` (full description rewrite or patch). Leave unchecked anything not truly done. Never check a box because the PR _intended_ to cover it — only because `main` now does.

### 4. Comment merge evidence

`mcp__linear__save_comment` with PR URL, merge SHA, and CI-green confirmation. Short. Present tense facts only.

### 5. Mark Done only when complete

If **every** outcome checkbox is checked and nothing residual remains, set state to `Done` with `mcp__linear__save_issue`. If anything is still open, set the issue to In Progress (or the team's equivalent) with remaining boxes unchecked — never partial-Done theater. Do not leave it In Review after merge when work remains.

### 6. Clean up the worktree

Only after merge + green CI + Linear closeout (or an explicit user decision to abandon). The orchestrator is still `cd`'d into the worktree from Phase 2; leave it first:

```bash
cd <path-to-main-repo>           # leave the worktree
git fetch origin
git worktree remove ../worktree/<branch-name>
git branch -d <branch-name>
```

If the worktree directory was already manually deleted, prune stale worktree references:

```bash
git worktree prune
```

## Linear MCP Tool Reference

Common operations:

| Action          | Tool                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------ |
| Fetch issue     | `mcp__linear__get_issue`                                                                                           |
| Get branch name | `mcp__linear__get_issue` (read `branchName` from result)                                                           |
| Update status   | `mcp__linear__save_issue` (set the state)                                                                          |
| Add comment     | `mcp__linear__save_comment`                                                                                        |
| Attach file     | `mcp__linear__prepare_attachment_upload` → PUT → `mcp__linear__create_attachment_from_upload` (see Phase 3 step 4) |
| List teams      | `mcp__linear__list_teams`                                                                                          |
