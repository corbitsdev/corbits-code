---
name: implement
description: Disciplined per-commit workflow with Greybeard review, build gates, and Critique loops
---

# Implement

A disciplined implementation workflow that produces reviewed, verified commits. Load this skill when you want each commit to go through architectural review, build verification, and code critique before it lands.

## Prerequisites

Before using this workflow, load the `style` and `philosophy` skills. Follow their conventions throughout.

## Linear claim (when applicable)

When the work is tied to a Linear issue ID, claim it **before** greybeard / explore / build thrash: set state to "In Progress" with `mcp__linear__save_issue`. This is a hard first step. Parallel lanes each claim their own issue ID — never claim a sibling lane's ID. If Linear MCP is unavailable or the update fails, report that the issue status could not be updated; do not pretend it was claimed.

## When to Use

This is a standalone skill, loaded on request. Use it when you want a single agent to work through a series of commits with review discipline.

The caller defines what work to do and where the commit boundaries are. This skill defines _how_ each commit gets produced.

## Tracking Progress

Track progress with `manage_tasks`. One item per commit-sized unit.

### Initial Planning

Before starting implementation, create a `manage_tasks` item for each commit-sized unit of work from the caller's instructions:

- **subject**: Clear imperative description of the unit of work
- **description**: Enough context that you could pick it up cold
- **activeForm**: Present continuous form for the spinner (e.g., "Refactoring HTTP client retry logic")

### During the Per-Commit Workflow

When you begin a unit of work, mark its `manage_tasks` item in progress. As you move through the workflow steps, update the task's `activeForm` to reflect which step you're in:

- **Step 1**: "Reviewing approach with Greybeard: {subject}"
- **Step 2**: "Implementing: {subject}"
- **Step 3**: "Running build gate: {subject}"
- **Step 4**: "Committing: {subject}"
- **Step 5**: "Running critic loop: {subject}"

When the commit lands and Critique is clean, mark the task `completed`.

### Discovered Work

If new work surfaces during implementation (Greybeard suggests a preparatory refactor, Critique reveals a missing edge case that warrants its own commit), append a `manage_tasks` item and work it through the full per-commit workflow.

## Workflow Per Commit

For each logical unit of work that results in a commit, follow these steps in order. Do not skip steps.

### Step 1: Greybeard Review

Mark the task `in_progress` and set `activeForm` to "Reviewing approach with Greybeard: {subject}".

Before writing any code, describe your implementation approach to Greybeard and ask for feedback.

**What to send Greybeard:**

- What you're about to change and why
- Which files you expect to touch
- Any design decisions or trade-offs you're considering
- Anything you're uncertain about

**How to handle feedback:**

- If Greybeard identifies problems with your approach, adjust before proceeding
- If Greybeard suggests a fundamentally different approach, consider it seriously
- You don't need to agree with every suggestion, but you need a reason to disagree
- Once you're aligned on approach, move to Step 2

Use `task(agent="greybeard")` for this step.

### Step 2: Implement and Test

Update `activeForm` to "Implementing: {subject}".

The order of operations depends on whether you're fixing a bug or building a feature. In both cases, follow the repository's existing test conventions — look at how existing tests are structured, where they live, what framework they use, and match that style. If the repository has no existing tests, ask the caller what test framework and conventions to use before proceeding.

**For bug fixes (test-first):**

1. Write a test that reproduces the bug.
2. Run the test and verify it **fails**. If it doesn't fail, you don't understand the bug well enough to fix it. Go back and refine the test until it demonstrates the broken behavior.
3. Implement the fix, following the approach reviewed in Step 1.
4. Run the test again and verify it **passes**. If it doesn't pass, your fix is incomplete.

**For new features:**

1. Implement the feature, following the approach reviewed in Step 1.
2. Write a test that exercises the new functionality and asserts on the expected behavior. The test should verify that the code works as designed and implemented, not just that it doesn't crash.
3. Run the test and verify it **passes**.

Keep the test focused on the behavior introduced by this commit. Don't test unrelated functionality. The test is part of the deliverable, not an afterthought.

Keep the scope tight to what was discussed. If you discover additional work is needed, finish the current commit's scope first and note the additional work for a future commit.

### Step 3: Build Gate

Update `activeForm` to "Running build gate: {subject}".

Run `make` (or the project's equivalent full pipeline: format, lint, build, test).

- If the build passes, move to Step 4
- If the build fails due to your changes, fix the failures and re-run until it passes
- If the build fails due to pre-existing issues unrelated to your changes, report the failure to the caller and let them decide how to proceed
- Do not move forward with a broken build
- Do not substitute partial builds (e.g., running only the compiler) for the full pipeline

### Step 4: Commit

Update `activeForm` to "Committing: {subject}".

Create the commit. Follow the commit message conventions from the `style` skill. Include the test in the same commit as the implementation — they are one logical unit of work.

### Step 5: Critic loop

Update `activeForm` to "Running critic loop: {subject}".

Ask critic to review the committed change.

**How to run:**

1. Spawn `task(agent="critic")` and ask it to review the output of `git show HEAD`. Include the intent from Step 1 (what the change is meant to accomplish and the approach agreed with Greybeard) so Critique can evaluate whether the implementation matches the plan, not just surface-level quality. Tell critic to limit its findings to the scope of the current commit -- pre-existing issues in touched files are out of scope.
2. Read its findings
3. For each issue marked VERIFIED or HIGH confidence: fix it
4. Re-run the build gate (Step 3) to verify fixes
5. Land the fixes on the right commit. If the target is HEAD, `git commit --amend`. Otherwise use `git rebase -i` with `edit` on the target commit:

   ```
   git rebase -i <base-branch>
   # In the editor, change "pick <sha> ..." to "edit <sha> ..."
   # ... make the fix at the stop ...
   git add <files>
   git commit --amend --no-edit
   git rebase --continue
   ```

   If the situation calls for more elaborate history surgery, search your available skills for one whose description covers git rebase or branch-history cleanup, and load it. Re-run the build gate after the rebase completes.

6. Ask critic to review `git show HEAD` again. Re-include the original intent from Step 1 and tell it what you fixed since the last pass so it can focus on verifying the fixes and checking for new issues rather than re-reviewing the entire change from scratch.
7. Repeat until Critique comes back clean or all remaining findings are acknowledged and intentional

**When to stop looping:**

- critic reports no issues
- Remaining findings are judgment calls you've consciously decided against, not oversights
- The build passes after the last round of fixes

### Step 6: Next

Mark the current `manage_tasks` item done. Move to the next unit of work and return to Step 1.

## Guidelines

**Claim Linear work first when applicable.** When tied to a Linear issue: claim "In Progress" with `mcp__linear__save_issue` before the spawn loop. Parallel lanes claim their own IDs. If Linear MCP is unavailable, report that the issue status could not be updated.

**Close the loop.** Ship → verify → fix → re-verify.

**Do not invent a worker-count or fan-out ceiling.**

**Don't shortcut the loop.** The value is in the discipline. Skipping Greybeard "because this change is simple" or skipping Critique "because the build passes" defeats the purpose.

**Keep commits focused, but do not drop findings.** When critic surfaces something outside the current commit's scope, every finding must be assigned one of four dispositions: (a) fix in the current commit, (b) commit it separately on this branch, (c) file a new issue with concrete acceptance criteria, or (d) accept it as-is. "Out of scope" is not a disposition. "Note it for later" is not a disposition unless you also say which of (a)–(d) "later" means.

**Disposition (d) always requires operator approval** — neither you nor greybeard can drop a finding on your own. For (c), the issue must be filed in this session, with its ID or URL in the status update; a promise to file it later is dropping the work. Consult the operator before choosing (c) or (d).

**Build must pass before every commit, amend, and rebase stop.** Never commit code that doesn't compile or pass tests. Fix build failures first, then commit, amend, or continue the rebase.

**Greybeard is for approach, critic is for execution.** Greybeard reviews your plan before you write code. critic reviews your code after you write it. Don't conflate the two.

## When Shipping a PR

This skill produces commits. When the work is tracked in Linear and ends in a pull request, hand off to `linear-issue-workflow` for Phase 6–7. Non-negotiable bar (also encoded in `review` and `pull-request-review`):

1. **Post a real GitHub PR review** with `gh pr review` after the PR exists — not a one-line self-review issue comment.
2. **Multi-persona when used:** if critic / greybeard / OSS-quality lenses ran with substance, each posts its own labeled review. Primary owns approve/request-changes; secondary lenses comment only.
3. **No AI slop in review bodies:** lens · verdict, one present-tense line on what the branch does, `path:line` findings. No filler, journey narration, or "LGTM" alone.
4. **Linear checkboxes and Done are post-merge + green CI only.** Flip boxes only when `main` actually has the outcome. Never partial-Done on open PR.
