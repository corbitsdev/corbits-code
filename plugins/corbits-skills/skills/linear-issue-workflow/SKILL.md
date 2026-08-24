---
name: linear-issue-workflow
user-invocable: false
description: Skywalker recipe — use_skill("linear-issue-workflow"). Fetch a Linear issue via MCP, then DIY tiny/bounded edits or spawn build for substantial landings.
argument-hint: "<issue-id> [--reviewer <reviewer>]"
---

# Linear Issue Workflow

You are Skywalker. Load with `use_skill("linear-issue-workflow")`. Host is Corbits Code.

**Classify first:**

- **DIY** — tiny / single-file / one-route / clear bounded product edits → `write_file` / `edit_file` / `delete_file` on this session. Still fetch the issue and keep Linear status/checkboxes honest. Skip the worktree + `/implement` spawn loop unless the operator wants an isolated branch.
- **Spawn build** — substantial / multi-file / parallel / specialist landings → Linear MCP on the primary, worktree via intern, then the `/implement` spawn loop (greybeard → build → intern/tester → critique).

If Linear MCP (`mcp__linear__*`) is missing, stop and tell the operator. Do not invent Claude-only tools.

**Fleet:** This recipe is mostly sequential — prefer `task()` for one blocking spawn at a time. Use `spawn_agent` + `wait_agents` only when independent lanes truly run together. No worker-count or fan-out ceiling. Close the verify → fix → re-verify loop, then report Blockers or `ask_operator` — do not invent hard round ceilings. Track progress with `manage_tasks`.

## Phase 1: Fetch the issue

Fetch with `mcp__linear__get_issue`. The returned issue includes title, description, status, branch name, and other metadata.

If the scope is unclear, `ask_operator` before proceeding. Do not guess.

After fetch: if the ask is DIY-tiny, do the edit, update Linear as needed, and stop. Otherwise continue.

## Phase 2: Worktree — intern (substantial)

Read `branchName` from the issue (call `mcp__linear__get_issue` again if needed).

Spawn `task(agent="intern")` with this sequenced `run_shell` list copied into the brief. Intern executes; Skywalker does not run the git.

```bash
git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'
git fetch origin
git worktree add ../worktree/<branch-name> -b <branch-name> origin/<default-branch>
```

Always base new branches on `origin/<default-branch>` (whatever the repository uses). After creating the worktree, intern `cd`s into it and installs local dependencies from developer documentation. Worktrees do not share `node_modules`.

If intern fails, stop and `ask_operator`. If the operator rejects the issue before implementation, intern tears down the worktree (Phase 7 commands) rather than leaving it stranded.

## Phase 3: Plan, attach, mark In Progress

1. Spawn `task(agent="explore")` if the codebase map is not already known. Brief it with the absolute worktree path (it must work there) and the issue: where changes go, existing patterns, related code.
2. Follow the `/implement` loop's greybeard step for the approach. Present the plan to the operator and `ask_operator` whether to proceed. Do not start implementation until approved.
3. If the operator rejects the plan and the issue cannot be salvaged, intern tears down the worktree (Phase 7) rather than leaving it stranded.
4. Attach the plan to the Linear issue. **Do not post the plan as a comment** — comments are for discussion, not archives.

   Spawn `task(agent="build")` with a mechanical brief to write the approved plan to the worktree's `tmp/plan-<ISSUE-ID>.md` (do not commit it). Intern captures byte size with `wc -c`. Primary then:

   1. `mcp__linear__prepare_attachment_upload` with `issue`, `filename`, `contentType: "text/markdown"`, and `size`. Response contains `uploadRequest.url`, `uploadRequest.headers`, and `assetUrl`. The signed URL expires in 60 seconds.
   2. Intern PUTs the raw file bytes to `uploadRequest.url` via `run_shell`, every header from `uploadRequest.headers` verbatim (exact casing). Do not base64-encode. If PUT returns 403 because the URL expired, prepare a fresh URL and retry once.
   3. `mcp__linear__create_attachment_from_upload` with `issue`, the `assetUrl`, `title: "Implementation plan"`, and `subtitle: "<ISSUE-ID>"`.

   Exception: plans with no structure — no file-by-file breakdown, no enumerated steps, no headings, no nested lists — can be a comment via `mcp__linear__save_comment` instead. Structural shape, not length, is the test.

5. Mark the issue "In Progress" with `mcp__linear__save_issue`.

## Phase 4: Implement — spawn loop (substantial)

When this loop is running, do not DIY the unit — spawn build. For each commit-sized unit, run `/implement`:

1. `task(agent="greybeard")` on the approach before any code is written.
2. `task(agent="build")` with a typed brief (`intent`, `success_criteria`, `do_not`, `report_focus`) and the absolute worktree path. Bug fixes start from a failing test. Features ship tests with the change.
3. `task(agent="intern")` or `task(agent="tester")` for the project build/test gate.
4. `task(agent="critique")` on the diff. Blocking findings → re-dispatch build with those findings in `success_criteria` / `do_not`, then re-run the gate and critique. Close the loop; if still blocked, report Blockers — do not loop forever.

Track units with `manage_tasks`. Copy style/philosophy into worker briefs (`use_skill` on the primary before spawning; workers do not mount `use_skill`).

### Checkboxes

If the issue description contains a task list (`- [ ]` items), tick boxes as build reports each one complete. Update with `mcp__linear__save_issue`, passing the full description with only the relevant `- [ ]` flipped to `- [x]`. Do not rewrite surrounding text. If there is no task list, skip — do not invent one.

## Phase 5: Branch review

After the last unit's critique is clean, spawn `task(agent="critique")` on the **whole** `origin/<default-branch>..HEAD` range in the worktree — not only the last commit. Brief:

- Absolute worktree path
- Base branch from Phase 2
- Linear issue ID and a one-line intent (what the change is for — never what the reviewer should find)
- Findings with `file:line` — not PR-comment prose
- Do not implement fixes

Fix-every-finding: treat surviving findings as a worklist and re-enter Phase 4 for each. If findings remain after a few whole-branch passes, `ask_operator` — do not push.

The only path to leaving a finding unfixed is a greybeard waiver: `task(agent="greybeard")` with the finding, proposed disposition, and relevant diff. Accept the ruling by default. Escalate with `ask_operator` only if you disagree or greybeard is unreachable. Never waive on Skywalker's own authority.

## Phase 6: Push and PR — intern, after confirmation

Once Phase 5 is clean (or every remaining finding is greybeard-waived):

Intern rebases via `run_shell`:

```bash
git fetch origin
git rebase origin/<default-branch>
```

Then intern re-runs the build gate. Draft PR title, body, and (if posting) review body from `git diff origin/<default-branch>...HEAD` and `git log origin/<default-branch>..HEAD --format='%s'` — present tense, no journey narration. Title: verb-first, no `feat:` prefix, no ticket ID in the subject. Body:

```markdown
## Summary

<1-3 bullets, present tense>

## Verification

<what is true now>

Closes <ISSUE-ID>
```

`ask_operator` to confirm title, body, reviewer, and whether to push. Do not push until confirmed.

Intern then:

```bash
git push -u origin <branch-name>

gh pr create \
  --title "<confirmed title>" \
  --reviewer <REVIEWER> \
  --body "$(cat <<'EOF'
<confirmed body>
EOF
)"
```

If a GitHub review must be posted, intern runs `gh pr review` as the operator's `gh` identity — never as a Claude (or other vendor) bot. Paste the PR URL and every review URL to the operator.

## Phase 7: After merge — Linear closeout and cleanup

Phase 6 ends when the PR is open. Phase 7 runs **after the PR is merged** and **CI is green**. Do not mark the Linear issue Done on open PR alone.

1. Intern confirms merge and CI via `run_shell` (`gh pr view`, `gh pr checks` / `gh run list`). If CI is red, do not tick Linear outcomes.
2. Re-read the issue with `mcp__linear__get_issue`. Flip checkboxes the merged PR actually completed on `main` via `mcp__linear__save_issue`. Never check a box on intent.
3. `mcp__linear__save_comment` with PR URL, merge SHA, and CI-green confirmation. Short. Present-tense facts.
4. If every outcome checkbox is checked, set state to `Done` with `mcp__linear__save_issue`. Otherwise leave In Progress.
5. Only then intern cleans up:

```bash
cd <path-to-main-repo>
git fetch origin
git worktree remove ../worktree/<branch-name>
git branch -d <branch-name>
```

If the worktree directory was already deleted: `git worktree prune`.

## Linear MCP tool reference

| Action                     | Tool                                                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------------------------- |
| Fetch issue                | `mcp__linear__get_issue`                                                                             |
| Get branch name            | `mcp__linear__get_issue` (`branchName`)                                                              |
| Update status / checkboxes | `mcp__linear__save_issue`                                                                            |
| Add comment                | `mcp__linear__save_comment`                                                                          |
| Attach file                | `mcp__linear__prepare_attachment_upload` → intern PUT → `mcp__linear__create_attachment_from_upload` |
| List teams                 | `mcp__linear__list_teams`                                                                            |

## Hard rules

- Tiny / single-file / one-route / clear bounded edits: DIY with write_file/edit_file/delete_file. Substantial issue landings: spawn build (this recipe's Phase 2–7).
- When the spawn loop is running, spawn with `task(agent="greybeard")`, `task(agent="build")`, `task(agent="intern")` or `task(agent="tester")`, and `task(agent="critique")`.
- Clarifying questions use `ask_operator`.
- Shell is `run_shell`, not a Bash tool.
- No false caps: do not invent worker-count, fan-out, or hard re-fix ceilings that the harness does not enforce.
