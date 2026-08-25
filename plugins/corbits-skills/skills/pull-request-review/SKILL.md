---
name: pull-request-review
description: Review a pull request by branch name or URL, using a git worktree. Loads the review skill for the actual read. Does not implement fixes.
---

# Pull Request Review

How to review a pull request given a branch name or URL. Do not implement fixes. Do not impersonate GitHub-Claude (or any other vendor) review comments.

## Input

- A branch name (e.g. `feature/add-auth`)
- A pull request URL from GitHub or GitLab (e.g. `https://github.com/owner/repo/pull/123`)

## Steps

### 1. Parse input

If given a URL, extract the branch:

```bash
# GitHub
gh pr view <url-or-number> --json headRefName --jq '.headRefName'

# GitLab
glab mr view <number> --output json | jq -r '.source_branch'
```

### 2. Repository root

```bash
git rev-parse --show-toplevel
```

### 3. Fetch and verify the branch

```bash
git fetch origin <branch-name>
git rev-parse --verify "origin/<branch-name>"
```

If the branch does not exist, report the error and stop. Do not create a worktree or review.

### 4. Create worktree

```bash
REPO_ROOT=$(git rev-parse --show-toplevel)
WORKTREE_PATH="${REPO_ROOT}/../worktree/<branch-name>"
mkdir -p "${REPO_ROOT}/../worktree"
git worktree add "$WORKTREE_PATH" "origin/<branch-name>"
```

Path is `../worktree/<branch-name>` relative to the repository root.

### 5. Checkout

```bash
cd "$WORKTREE_PATH"
git checkout <branch-name>
git branch --show-current
```

Confirm the branch name before continuing.

### 6. Set up the repository

Follow documented setup exactly — `README.md`, `CONTRIBUTING.md`, `docs/`, `DEVELOPMENT.md`, or `SETUP.md`. Typical: install deps, env, migrations, build.

Do not assume the setup process. If no setup docs exist, `ask_operator` before proceeding.

### 7. Base branch

```bash
gh pr view --json baseRefName --jq '.baseRefName'
# or
glab mr view --output json | jq -r '.target_branch'
```

Branch-name only: do not guess if both `main` and `master` exist — `ask_operator`.

If any command fails, stop, report the error, and `ask_operator`. Do not retry workarounds.

### 8. Review

Load and follow the `review` skill. That skill covers:

- Scope via `git diff <base>...HEAD`
- Pre-existing code
- Convention compliance
- Test-coverage philosophy
- Signal over noise
- Cite the check
- The review checklist
- Posting on GitHub when a PR URL/number is known

### 9. Post on GitHub

When the review targets a GitHub PR, post the finished review on the PR before cleanup. A review that only lives in chat is not done. Follow **Post on GitHub** in the `review` skill.

Do not skip the post because chat already summarized the findings.

## Cleanup

```bash
git worktree remove "$WORKTREE_PATH"
```

Or leave it and tell the operator it remains for further investigation.

## Error handling

If any command fails, stop and `ask_operator`. Common cases: missing remote branch, worktree/checkout/setup failure, `gh`/`glab` missing or unauthenticated. Present the error output.
