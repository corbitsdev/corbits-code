---
name: git-worktrees
user-invocable: false
disable-model-invocation: true
description: Create a git worktree from origin/<default-branch> and tear it down. Background library — load via use_skill("git-worktrees"); absent from slash and use_skill listing.
---

# git-worktrees

How to create a worktree from origin/<default-branch> and tear it down. Load via `use_skill("git-worktrees")` and copy commands into an intern brief. Intern executes via `run_shell`. Do not run the git on the parent.

## Create from origin/<default-branch>

```bash
git symbolic-ref refs/remotes/origin/HEAD | sed 's@^refs/remotes/origin/@@'
git fetch origin
git worktree add ../worktree/<branch-name> -b <branch-name> origin/<default-branch>
```

Always base new branches on `origin/<default-branch>` (whatever the repository uses). After creating the worktree, intern `cd`s into it and installs local dependencies (`bun install` when the project uses Bun; otherwise follow developer docs). Worktrees do not share `node_modules`.

## Teardown

```bash
cd <path-to-main-repo>
git fetch origin
git worktree remove ../worktree/<branch-name>
git branch -d <branch-name>
```

If the worktree directory was already deleted: `git worktree prune`.
