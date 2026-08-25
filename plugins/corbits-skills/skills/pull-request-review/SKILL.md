---
name: pull-request-review
description: Review a pull request by branch name or URL. Intern checks out a worktree if needed; critic (or neckbeard) reviews. Skywalker does not implement fixes.
---

# Pull Request Review

You are Skywalker. Host is Corbits Code. This skill is a spawn recipe. Do not implement fixes as part of the review. Do not impersonate GitHub-Claude (or any other vendor) review comments.

## Input

Accepts either:

- A branch name (e.g. `feature/add-auth`)
- A pull request URL from GitHub or GitLab (e.g. `https://github.com/owner/repo/pull/123`)

## Recipe

### 1. Parse input

If given a URL, intern extracts the branch via `run_shell` (there is no Bash tool):

```bash
# GitHub
gh pr view <url-or-number> --json headRefName --jq '.headRefName'

# GitLab
glab mr view <number> --output json | jq -r '.source_branch'
```

### 2. Worktree checkout if needed

If the PR branch is not already the current checkout, spawn `task(agent="intern")` with this sequenced `run_shell` list copied into the brief. Intern executes; Skywalker does not run the git.

```bash
git rev-parse --show-toplevel
git fetch origin <branch-name>
git rev-parse --verify "origin/<branch-name>"
```

If the branch does not exist, intern reports the error. Stop. Do not proceed with worktree creation or review.

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_PATH="${REPO_ROOT}/../worktree/<branch-name>"
mkdir -p "${REPO_ROOT}/../worktree"
git worktree add "$WORKTREE_PATH" "origin/<branch-name>"
cd "$WORKTREE_PATH"
git checkout <branch-name>
git branch --show-current
```

Worktree path is `../worktree/<branch-name>` relative to the repository root.

Then intern follows documented setup in `README.md`, `CONTRIBUTING.md`, `docs/`, `DEVELOPMENT.md`, or `SETUP.md` — install deps, env, migrations, build — exactly as documented. Do not assume the setup process. If no setup docs exist, `ask_operator` before proceeding.

Base branch:

```bash
gh pr view --json baseRefName --jq '.baseRefName'
# or
glab mr view --output json | jq -r '.target_branch'
# branch-name only: origin/main or origin/master — ask rather than guessing if both exist
```

If any of these commands fail, intern stops and reports. Do not retry workarounds. `ask_operator` how to proceed.

### 3. Review

- **Default:** `task(agent="critic")` with the PR scope (branch, base, worktree path, PR URL/number).
- **Hygiene-only** (operator said nits / naming / lint / pedantry): `task(agent="neckbeard")`.

Brief the reviewer:

- Paths, PR number/URL, or branch
- Base for comparison (`git diff <base>...HEAD`); if the base is unclear, `ask_operator` rather than guessing `main`
- Only this PR's diff is in scope — pre-existing issues outside the diff are out of lane
- Do not implement fixes; findings only, with evidence (`path:line`)
- Signal over noise (neckbeard is the exception when hygiene was requested)
- Do not write GitHub review comment prose impersonating Claude or any vendor

Prefer a typed brief: `intent="review"`, `success_criteria`, `do_not`, `report_focus`.

### 4. After the report

Synthesize critic/neckbeard Summary / Findings / Blockers / Paths for the operator. Do not land fixes.

If a GitHub review must be posted, intern runs `gh pr review` as the operator's `gh` identity — never as a Claude (or other vendor) bot. Primary owns `--approve` / `--request-changes` only when the operator asked to post; secondary lenses use `--comment` only.

If the operator then wants repairs, that is a later `/implement` or `use_skill("dispatch")` — not this skill.

## Cleanup

After the review, intern may remove the worktree:

```bash
git worktree remove "$WORKTREE_PATH"
```

Or leave it and tell the operator it remains for further investigation.

## Hard rules

- This recipe reviews; it does not land product patches. If the operator then asks for a tiny/bounded fix, DIY with write_file/edit_file/delete_file; spawn builder for substantial fixes.
- Skywalker MUST NOT run the worktree git; intern does, via `run_shell`.
- Do not implement fixes as part of the review.
- Do not impersonate GitHub-Claude review comments.
