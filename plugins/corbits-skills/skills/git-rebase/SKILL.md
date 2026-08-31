---
name: git-rebase
user-invocable: false
description: Reshape git history with rebase — edit-in-place, squash/fixup, drop, split, reword, or validate every replayed commit. Plan the surgery; intern executes sequenced non-interactive git via run_shell. Load whenever a commit that is not HEAD needs changing, or for branch-history cleanup before push.
---

# git-rebase

How to reshape a branch's commit history without interactive prompts — squashing fixups, dropping wrong-turn commits, splitting bundled changes, rewording messages. Do not run the rebase or edit files on the parent.

`git rebase -i` is normally driven through an interactive editor. The techniques below drive every editor invocation programmatically so the rebase runs to completion without a human at the keyboard. Scripted rebases are reproducible, re-runnable, and self-documenting in a way that vim-driven ones never are.

## Recipe

1. Read the techniques below. Identify the surgery (drop, squash, split, reword, edit-in-place, validate).
2. If a step needs judgment (what to squash, which commits to drop, how to split, which message), `ask_operator` first. Do not guess.
3. Copy the exact sequenced commands from this skill into an intern brief.
4. Spawn `spawn_agent(agent="intern")` with that sequenced command list, then collect the result with `wait_agents`. Intern executes via `run_shell`. Intern drives every editor via `GIT_SEQUENCE_EDITOR` / `-c sequence.editor` / `-c core.editor` inline in the git command — do not tell intern to `write_file` an editor script. Intern runs git and resolves mechanical conflicts as the brief specifies.
5. If intern hits a judgment call mid-rebase, `ask_operator` then re-dispatch intern with the decision.

Plan and synthesize. Intern mutates git.

## Techniques (copy into the intern brief)

## Assumptions

- Git ≥ 2.18. Earlier versions handle `--autosquash` interaction with
  `GIT_SEQUENCE_EDITOR=true` differently and do not support some of the
  edit-todo behaviors used below. Git ≥ 2.38 adds `--update-refs`,
  which the workflow uses when stacked branches are present (see
  "Stacked branches" below).
- A POSIX shell (`/bin/sh`) is available for inline editor commands
  (`sh -c` as `GIT_SEQUENCE_EDITOR` / `-c sequence.editor` /
  `-c core.editor`). Every editor command in this skill starts with
  `set -eu` so an intermediate failure (failed `sed`, missing file,
  undefined variable) aborts with a non-zero exit — letting the rebase
  fail loudly rather than silently succeeding with a no-op edit.
  Intern does not `write_file` helper scripts; the editor is the quoted
  command git invokes.

- `sed -i.bak <file>` is the portable in-place form across BSD and GNU
  sed; it creates `<file>.bak`, which the editor command then removes with
  `rm -f <file>.bak`. Bare `sed -i` is GNU-only; bare `sed -i ''` is
  BSD-only. Don't mix them.
- If the repository enforces signed commits (`commit.gpgsign=true`,
  `gpg.format=ssh`, or similar), rebase strips signatures from every
  replayed commit unless you pass `-S` / `--gpg-sign` (or set
  `rebase.gpgSign=true`). Re-sign explicitly when the project's policy
  requires it; an unsigned commit that sneaks through a rebase is
  invisible until the next push fails.

## When to use this skill

Reach for it when development pace produced messy history that needs to be
made coherent before the branch is pushed for review:

- A flip-flop: commit X added behavior, commit Y reverted it, commit Z added
  it back. The net change is what Z does, but the history reads as confusion.
- A commit with a process-talk message ("Address review findings", "Fix bug
  from last commit") that should describe the behavior change instead.
- A commit that bundles unrelated changes that belong in different earlier
  commits.
- A drive-by lint fix smuggled into an unrelated feature commit.
- A bug fix discovered during integration testing that belongs in the commit
  that introduced the bug.

Do **not** reach for it when:

- The commit you want to fix is HEAD itself. Use `git commit --amend`
  (with `-m` for a pre-written message, `--no-edit`
  to keep the existing one). No rebase needed.
- The branch is already pushed and other people are basing work on it.
- The history is already coherent and you are only chasing aesthetic
  perfection. Style and philosophy say "commits should read like a story" —
  not "every commit must be perfect."
- The base branch is unstable and your branch will need to rebase repeatedly.
  Wait until things settle, or enable `git rerere` (see "Repeated rebases"
  below).
- The job is repo-wide history surgery — removing a secret from every
  commit, splitting a monorepo, rewriting author identities, mass-rewriting
  hundreds of commits. Reach for [`git filter-repo`](https://github.com/newren/git-filter-repo)
  instead. Scripting `GIT_SEQUENCE_EDITOR` for that many commits is a path
  of suffering.

## The non-interactive insight

Git invokes an editor at several points during a rebase. The two that
matter for scripting are:

| Editor invocation         | Env var               | What it edits                                                                                       |
| ------------------------- | --------------------- | --------------------------------------------------------------------------------------------------- |
| Rebase plan ("todo list") | `GIT_SEQUENCE_EDITOR` | The list of `pick`/`reword`/`edit`/`fixup`/`drop`/`squash` lines                                    |
| Commit message editing    | `GIT_EDITOR`          | A single commit message file (used for `reword`, `squash` combined messages, and amend-during-edit) |

`GIT_EDITOR` also fires for `git rebase --edit-todo` and for conflict-file
editing when configured. The risk of using `GIT_EDITOR="cp ..."` is exactly
that it fires for _every_ editor invocation in the rebase, not just the
one you have in mind. See "Pattern 3" below for safer dispatchers.

`GIT_SEQUENCE_EDITOR` is the killer feature. Almost everything else flows
from being able to script the rebase plan.

## Safety first: branch your way back

Before any history surgery, create a backup branch at the current HEAD so a
hard reset returns you to a known-good state if anything goes wrong:

```bash
git branch backup-$(git rev-parse --abbrev-ref HEAD)-pre-rebase
```

(Avoid `backup/<branch>` if your branch names contain `/` — git refs cannot
be both a directory and a file. A flat `backup-<branch>` namespace is
safer.)

If you need to restore and a rebase is in progress, abort it first:

```bash
git rebase --abort 2>/dev/null   # safe if no rebase is in progress
git reset --hard backup-<branch-name>-pre-rebase
```

**`git rebase --abort` is your deliberate bail-out.** If you find
yourself in a tangled `--continue`/`--skip` loop and have lost the
thread of what each conflict means, abort and start over from the
backup branch. Re-running a planned rebase from a clean state is almost
always faster than rescuing one mid-flight.

**If you skipped the backup branch, the reflog is your fallback.** Every
update to a branch ref is recorded:

```bash
git reflog show <branch-name>           # find the pre-rebase entry
git reset --hard <branch-name>@{<n>}    # reset to that entry
```

The reflog entries expire (default 90 days for reachable, 30 for
unreachable), so this is a recovery path of last resort — the backup
branch is the right primary mechanism.

Validate the rewritten branch against the backup at the end. Use the
two-argument form of `git diff` (not the `A..B` range form): `git diff`
operates on trees, not commit ranges.

```bash
git diff backup-<branch-name>-pre-rebase HEAD --stat
```

An empty diff is the "you did not lose any content, only reshaped history"
proof. Run this after every meaningful rebase step.

**Detecting a zombie rebase.** Some safety configs — notably
`rebase.missingCommitsCheck=error` — pause a rebase rather than
aborting it when the rebase plan is rejected, leaving
`.git/rebase-merge/` in place. The editor command exits 0 and the outer
`git rebase` command exits 0 too, so a naive caller sees apparent
success. After every rebase, check explicitly:

```bash
if [ -d .git/rebase-merge ] || [ -d .git/rebase-apply ]; then
  echo "rebase in progress — investigate before proceeding" >&2
  exit 1
fi
```

Treat a leftover rebase dir as a failure regardless of what git's exit
code said.

## Patterns

### Pattern 1: Drop a commit cleanly

The cleanest non-interactive way to drop a single commit is `git rebase
--onto`. No editor needed.

```bash
# Drop commit BAD_SHA, replay everything after it onto BAD_SHA's parent.
# Pass the branch name (not HEAD) so the branch ref moves on success.
git rebase --onto BAD_SHA^ BAD_SHA <branch-name>
```

If `BAD_SHA` is the root commit it has no parent, and `BAD_SHA^` fails to
resolve. Use `--root` instead and reshape the rebase to start from a known
empty tree, or first create a parent for it (rare; consult `git rebase
--root` documentation if you hit this).

If the dropped commit had a counterpart in a later commit (e.g. you added
something in X and reverted it in Y), expect a conflict when the later
commit tries to apply. Resolve by editing the conflict markers out of the
file directly with whatever editing tool is available, then:

```bash
git add <conflicted-file>
git rebase --continue
```

**Detached-HEAD caveats:**

- During the rebase itself, HEAD is detached. If conflicts arise mid-way,
  you are resolving them on a detached HEAD; that's normal and expected.
- Do _not_ `git checkout` away from a mid-rebase detached HEAD as a way
  to "escape" an unexpected state. Doing so abandons the in-flight
  rebase work — only the reflog can recover what was committed, and
  only within its expiry window. If you want out, `git rebase --abort`
  first.
- On _successful completion_, passing `<branch-name>` causes git to move
  the branch ref forward. Passing `HEAD` does not — you finish on a
  detached HEAD and have to re-attach manually with `git checkout -B
my-branch HEAD`.

### Pattern 2: Script the rebase todo list

Pass an inline editor that takes the todo file path as `$0` (git appends
it) and rewrites it in place. Point `GIT_SEQUENCE_EDITOR` — or the
equivalent `git -c sequence.editor=...` — at that command. Do not
`write_file` a helper script, then run it.

```bash
# Substitute the real abbreviated SHA before running — a no-op sed pattern
# produces a successful no-op rebase that looks like it worked.
GIT_SEQUENCE_EDITOR='sh -c "set -eu; sed -i.bak \"s/^pick abc1234/edit abc1234/\" \"\$0\"; rm -f \"\$0.bak\"; echo \"--- rewritten rebase plan ---\" >&2; cat \"\$0\" >&2"' git rebase -i origin/main
# equivalent: git -c sequence.editor='sh -c "..."' rebase -i origin/main
```

The `echo` + `cat` to stderr is cheap insurance: any time you don't see
the expected change in the printed plan, abort and inspect.

For more complex rewrites, replace the todo wholesale. Note that
`rebase.missingCommitsCheck=error` (a common safety setting) does _not_
reject a wholesale-replace plan that omits commits — it pauses the
rebase mid-flight with `No commands done` and leaves
`.git/rebase-merge/` in place. The editor command exits 0 and so does
the outer `git rebase` command, so a naive caller sees apparent
success. Preserve every line you don't want to drop, and explicitly use
`drop` rather than just removing lines, so the check is satisfied and
the rebase actually runs to completion. Combine with the zombie-rebase
detection from "Safety first" above to catch any case where a paused
rebase slips past.

```bash
GIT_SEQUENCE_EDITOR='sh -c "set -eu; printf \"%s\\n\" \
  \"pick   aaaaaaa First commit\" \
  \"pick   bbbbbbb Second commit\" \
  \"reword ccccccc Rename me\" \
  \"fixup  ddddddd Fold me into ccccccc\" \
  \"drop   eeeeeee Drop me explicitly so missingCommitsCheck stays happy\" \
  \"pick   fffffff Keep going\" \
  > \"\$0\"; echo \"--- rewritten rebase plan ---\" >&2; cat \"\$0\" >&2"' git rebase -i origin/main
```

The command runs once when git opens the editor for the plan. Its job is to
leave the todo file in the state you want git to execute.

### Pattern 3: Provide pre-written commit messages

For `reword` actions (and for `squash` actions that combine messages), git
invokes `GIT_EDITOR` (or `git -c core.editor=...`) on a temp file containing
the current message, expecting you to edit it. Replace the editor with an
inline command that overwrites that file — do not `write_file` a message
file, then `cp` it:

```bash
GIT_EDITOR='sh -c "printf \"%s\\n\" \"A descriptive subject line under 72 characters\" \"\" \"A body that explains why the change was made, wrapped to 72 columns.\" \"Each paragraph is a complete thought.\" > \"\$0\""' git rebase --continue
# equivalent: git -c core.editor='sh -c "printf ... > \"\$0\""' rebase --continue
```

Git passes the message file path as the editor's only argument, which
becomes `$0` for `sh -c`.

`>` truncates in place (same inode). Avoid `GIT_EDITOR="cp ..."`: `cp`
follows symlinks (overwriting the target rather than the link) and
changes the destination's inode and mtime — which can confuse hooks that
fingerprint the file. Git creates a fresh regular file each time it opens
the message editor, so the symlink hazard is largely theoretical in the
common case, but the `printf > "$0"` form costs nothing.

**Scope-of-invocation pitfall.** `GIT_EDITOR="cp ..."` (and a too-broad
inline editor) fires for _every_ editor invocation during the wrapped
command, including conflict editors and any other commits' message
editing. Use it only when you know exactly which one invocation will
happen. For any rebase where you don't know, use an inline dispatcher
(below) or prefer the direct alternatives:

- `git commit --amend -m "subject" -m "body"` — supplies the message
  directly, no editor.
- `git commit -m "subject" -m "body"` — same for fresh commits.

The inline `GIT_EDITOR` / `-c core.editor` trick is the right tool only
when git owns the invocation (mid-rebase).

#### Multiple reword targets in one rebase

When several commits are being reworded in a single rebase pass, git calls
the editor once per `reword` action. Use an inline dispatcher that recognizes
which commit is being reworded by inspecting the current message — and
fails loudly when an invocation doesn't match anything it knows about:

```bash
GIT_EDITOR='sh -c "set -eu
target=\$0
first_line=\$(head -1 \"\$target\")
case \"\$first_line\" in
  \"Old subject line A\")
    printf \"%s\\n\" \"New subject A\" \"\" \"Body A\" > \"\$target\" ;;
  \"Old subject line B\"*)
    printf \"%s\\n\" \"New subject B\" \"\" \"Body B\" > \"\$target\" ;;
  *)
    echo \"msg-dispatch: unmatched message: \$first_line\" >&2
    exit 1 ;;
esac
"' git rebase -i origin/main
# equivalent: git -c core.editor='sh -c "..."' rebase -i origin/main
```

The `*)` catch-all is mandatory. Without it, a `reword` action whose
message doesn't match any known case silently accepts the original
message, and the rebase reports success — violating the "errors must
surface" rule. A failing exit aborts the rebase at the unmatched commit
and tells you which one.

Disambiguation: if two commits share an identical subject line, the
dispatcher can't tell them apart from `head -1` alone. Either:

- Match on a longer prefix using more of the message body, or
- Use `git rebase -i` with explicit SHAs in the todo and have the
  dispatcher key on the commit currently being reworded by reading
  `git rev-parse HEAD` inside the editor command. During a `reword` action, git
  cherry-picks the target commit onto the rebase head _before_ opening
  the editor, so HEAD inside the dispatcher resolves to the target's
  newly-rewritten SHA. The same is true at the editor invocation for
  `edit` (HEAD = the commit you stopped at, before any amend) and at
  the message-combine step of `squash` (HEAD = the partially-combined
  commit so far). `fixup` does not invoke the editor — the message is
  taken from the predecessor unchanged — so no dispatcher fires.

### Pattern 4: Edit a commit in place

This is the workhorse for folding a change into an earlier commit. If
the target is HEAD, don't rebase at all — `git commit --amend` (with
`-m` for a pre-written message, `--no-edit` to keep the existing one).

The rest of this pattern is for editing an earlier commit.

Mark the target `edit`, modify the working tree at the stop, and
`git commit --amend`:

```bash
GIT_SEQUENCE_EDITOR='sh -c "set -eu; sed -i.bak \"s/^pick TARGET_SHA/edit TARGET_SHA/\" \"\$0\"; rm -f \"\$0.bak\"; echo \"--- rewritten rebase plan ---\" >&2; cat \"\$0\" >&2"' git rebase -i origin/main
# equivalent: git -c sequence.editor='sh -c "..."' rebase -i origin/main

# At the stop, intern edits files in the working tree:
git add <files>
git add <files>
git commit --amend --no-edit
git rebase --continue
```

If a later commit's diff conflicts with the amendment, git stops again at
the conflicted commit. Resolve and continue. This is the price of editing
mid-history: every commit downstream of the edit gets replayed and may
conflict.

**Why prefer this over the `fixup! + --autosquash` flow (Pattern 5)?**
With `edit`, you author the fix against the _target commit's actual
tree_ — what was there at that point in history. With `fixup!`, you
author the change at HEAD's tree (after all intervening commits), and
`--autosquash` later tries to apply that diff against the much-earlier
target tree. When the fix touches anything that intervening commits
also modified, that backward apply conflicts — and you end up
resolving a conflict between a hunk written against late state and a
tree from early state, which is easy to get wrong (dragging in
late-state assumptions). Reach for `edit` whenever the fix's content
might depend on intervening commits, or whenever the branch has
non-trivial churn between the target and HEAD. Reach for `fixup!`
(Pattern 5) for small, isolated changes you're confident don't overlap
intervening work.

Two smaller wins follow from the same property: at the `edit` stop,
the working tree is exactly the target commit's state. First, no
accidentally-bundled drive-by changes from HEAD can sneak into your
amend. Second, you can install dependencies, lint, build, and run
tests against the _historical_ state — verifying the commit actually
works in the world it lived in. With `fixup!`, your validation only
ever sees HEAD's tree; the squashed commit is never tested against
the rewound state where it lands. (Pattern 7's `--exec` mechanizes
this validation across every commit in the rebase.)

### Pattern 5: Fixup + autosquash

For small, isolated changes that don't depend on context introduced
after the target commit, the `fixup!`-subject + `--autosquash` flow is
the cleanest path. When the fix overlaps intervening work, prefer
Pattern 4 (Edit in place) instead.

```bash
# Make the change at HEAD, then:
git commit -m "fixup! <exact subject of target commit>"

# Later, fold all such fixups into their targets:
GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash origin/main
```

`--autosquash` reorders the todo so each `fixup! X` commit becomes a
`fixup` action right after commit `X`. With `GIT_SEQUENCE_EDITOR=true`,
the editor (`true`, a successful no-op) accepts the autosquashed plan
unchanged.

**Generate the fixup subject automatically** with `git commit --fixup=SHA`
when the target SHA is known and stable. It writes `fixup! <target
subject>` for you.

**Pitfall: `--no-verify` only for commit-msg hooks on transient fixups.**
A commit-msg hook that enforces a subject-length limit will reject `fixup!
<long subject>` even though the squashed result inherits the target's
compliant message. `--no-verify` on the transient fixup is acceptable
because the message is discarded at squash time. Note that
`--no-verify` is a single switch — it disables _both_ the commit-msg
and pre-commit hook chains; you can't disable one without the other.

**`--no-verify` is NOT acceptable for pre-commit hooks** that run linters,
formatters, or tests on the working tree. The squashed commit inherits the
same working tree, so any defect that would have been caught at the fixup
commit will still be there in the squashed result. The hook would catch
it next time anyway, and you've just lost the early warning.

**Pitfall: every `--fixup` commit runs the full pre-commit hook chain.**
On projects with slow pre-commit hooks (full test suites, codegen, type
generation), creating ten fixups in a row is ten hook runs. There's no
correctness-preserving shortcut — pace your fixups accordingly, or use
`git commit -n` only on hooks you're sure won't matter for the
intermediate state (and accept the same caveat as above).

**Exception: hooks that mutate the working tree fight the rebase.** A
pre-commit hook that re-formats files, regenerates code, or stages
additional files during the hook itself can desync a rebase — git
replays a commit, the hook rewrites the tree, and the resulting commit
no longer matches what the rebase plan recorded. When you must rebase
under such a hook, temporarily disable the _mutating step specifically_
(uninstall pre-commit, comment out the relevant hook, set the hook's
documented no-op env var) rather than reaching for blanket
`--no-verify`, which discards every other pre-commit safety check on
every replayed commit. Restore the hook after the rebase.

### Pattern 6: Split a commit into pieces

Builds on the `edit` mechanism from Pattern 4: stop the rebase at the
commit you want to split, then reconstruct it as multiple commits before
continuing.

```bash
GIT_SEQUENCE_EDITOR='sh -c "set -eu; sed -i.bak \"s/^pick TARGET_SHA/edit TARGET_SHA/\" \"\$0\"; rm -f \"\$0.bak\"; echo \"--- rewritten rebase plan ---\" >&2; cat \"\$0\" >&2"' git rebase -i origin/main
# equivalent: git -c sequence.editor='sh -c "..."' rebase -i origin/main

# Git stops at TARGET_SHA with that commit applied. Verify the working
# tree is clean (the commit-being-split is the only thing in the
# working/staging area):
git status

# Undo the commit but keep its changes in the working tree (--mixed is
# the default, but spell it out so the intent is unambiguous):
git reset --mixed HEAD~

# Stage and commit the pieces. Use exact paths, NOT `git add -A` or
# wildcards — a typo here can re-introduce content from outside the split
# commit if your working tree had unrelated changes.
git add path/to/group-a/specific-file.ts
git commit -m "Subject for group A"
git add path/to/group-b/specific-file.ts
git commit -m "Subject for group B"

# Resume the rebase:
git rebase --continue
```

If the pieces should fold into different _other_ commits, name them with
the `fixup!` prefix and let a follow-up autosquash route them. The
`--no-verify` below disables _both_ pre-commit and commit-msg hook
chains (the flag can't disable one without the other). It's acceptable
on these transient fixups because (a) the commit-msg hook would reject
the `fixup! <long subject>` line that the squash discards anyway, and
(b) the working tree at this fixup is the same tree that will be
squashed into the target — the next commit through the pre-commit hook
will see exactly the same state and either accept or reject it on the
same merits:

```bash
git add path/to/group-a/specific-file.ts
git commit --no-verify -m "fixup! <subject of target A>"
git add path/to/group-b/specific-file.ts
git commit --no-verify -m "fixup! <subject of target B>"
git rebase --continue

# Then:
GIT_SEQUENCE_EDITOR=true git rebase -i --autosquash origin/main
```

### Pattern 7: Validate every commit during the rebase

For "every commit on this branch must build / lint / test," let `git
rebase --exec` enforce it during the rebase itself:

```bash
# Substitute the project's build / type-check / test command.
git rebase --exec '<build-command>' origin/main
```

`--exec` runs the given command after each pick. If it fails, the rebase
stops at the broken commit — intern amends in place. This is
strictly better than the after-the-fact validation loop in the workflow
below, because the broken commit is right there under intern's fingers with
the failed state still in the working tree.

For a quick gate, use the project's build or type-check command. For
full validation, use the project's test command — slower, but catches
commits where tests don't yet pass.

### Stacked branches: `--update-refs`

If the branch you're rebasing has dependent branches stacked on it —
intermediate refs pointing at commits the rebase will rewrite — git ≥
2.38 can move them forward automatically:

```bash
git rebase --update-refs -i origin/main
```

Without `--update-refs`, the stacked branches end up pointing at the
_old_, now-orphaned commits, and you have to reset each one manually
against the reflog. Enable globally with `git config rebase.updateRefs
true` if you work with stacked branches routinely.

### Repeated rebases against an unstable base

If you must rebase the same branch repeatedly against a moving base, enable
`git rerere` (reuse recorded resolution) so you only resolve each conflict
once:

```bash
git config rerere.enabled true
```

The first time you resolve a conflict, git records the resolution keyed on
the conflict's content. On a subsequent rebase that produces the same
conflict, git applies the recorded resolution automatically. You still
need to `git add` and continue, but you don't re-do the resolution work.

## Workflow: a rebase session start to finish

Intern executes this sequence via `run_shell`. Do not run git on the parent.
If a step needs judgment, `ask_operator` first, then copy the decision into
the intern brief.

1. **Identify what needs fixing.** Intern reads `git log --oneline origin/main..HEAD`
   and the diffs. List the surgery: drops, rewords, squashes,
   splits, in-place amends — `ask_operator` when which-commits is a judgment call.

2. **Branch your way back.** Intern:

   ```bash
   git branch backup-<branch-name>-pre-rebase
   ```

3. **Plan the smallest viable set of operations.** Each operation is a
   separate rebase. Multiple small rebases with validation between is
   easier to debug than one giant rebase.

4. **For each operation, intern:**
   - Runs the rebase with `GIT_SEQUENCE_EDITOR` / `-c sequence.editor` inline (if scripting the todo). Do not `write_file` an editor script.
   - Supplies pre-canned commit messages via `-c core.editor` / `GIT_EDITOR` inline (if rewording), or `git commit --amend -m`.
   - Resolves conflicts as they arise (mechanical). Judgment → intern stops; `ask_operator` then re-brief intern.
   - When the rebase finishes, runs `git diff backup-<branch-name>-pre-rebase HEAD`.
     If the intent was to change content, the diff is meaningful and intern reports
     it. If the intent was only to reshape history, the diff is empty.

5. **Validate.** Intern:
   - `git diff backup-<branch-name>-pre-rebase HEAD --stat` — empty unless
     intended.
   - Per-commit build, capturing failure output so a red mark is
     actionable:
     ```bash
     branch=$(git rev-parse --abbrev-ref HEAD)
     mkdir -p /tmp/per-commit-build
     for sha in $(git log --reverse --format=%h origin/main..HEAD); do
       git checkout -q $sha
       if <build-command> > "/tmp/per-commit-build/$sha.log" 2>&1; then
         echo "pass $sha"
       else
         echo "FAIL $sha — see /tmp/per-commit-build/$sha.log"
       fi
     done
     git checkout -q "$branch"
     ```
     Note: capture the symbolic branch name _before_ the loop (the loop's
     checkouts leave you on detached HEAD if you don't).
   - Per-commit tests (the same loop with `<test-command>`).
   - Final tree: the project's full build and test command.
   - Even better, fold validation into the rebase itself with `git rebase
--exec` (Pattern 7) so the rebase stops at the first broken commit.

6. **Delete the backup** once the branch is pushed and the final state is confirmed. Intern:
   ```bash
   git branch -D backup-<branch-name>-pre-rebase
   ```

## Common conflict patterns and resolutions

When a dropped commit had a counterpart in a later commit (added X in A,
removed X in B), dropping A causes B's removal to fail to apply. The right
resolution is "keep neither side" — the file should end up as if neither
A nor B happened. Edit the conflict markers out directly:

```
<<<<<<< HEAD
// nothing here, X was never added
=======
// B's removal of X
>>>>>>> B (later commit)
```

becomes:

```
// nothing here, X was never added
```

When you `edit` a commit and modify a hunk that a later commit also
touches, that later commit may conflict on the same hunk. Note that during
a rebase, `--ours` and `--theirs` are _inverted_ from the normal merge
sense:

- `--ours` = the rebase target (HEAD at the conflict point, which is your
  edited result so far)
- `--theirs` = the commit being replayed (your in-flight commit's version)

So in both common cases — your edit _includes_ the later commit's intent,
or your edit _supersedes_ it — the version you want to keep is in `--ours`
(HEAD). The conflicting commit is either now a no-op (and git drops it
automatically when its tree change becomes empty) or partially still
needed (in which case `git rebase --skip` after deciding deliberately, or
edit the markers manually).

Resolution decision tree:

- If your edit makes the later commit redundant (its intent is already in
  HEAD): `git checkout --ours <file>` then `git add`. On `git rebase
--continue`, git's handling of the now-empty commit is configurable
  via `--empty=` (the documented default for the interactive merge
  backend is `stop`, not `drop`). If git stops on the empty commit:
  - Confirm the diff is genuinely empty: `git diff --cached` should be
    silent.
  - `git rebase --skip` to drop with intent, or
  - `git commit --allow-empty` then `git rebase --continue` to preserve
    an empty marker commit if that's what you actually want.
    Older versions and some configs auto-drop without stopping — be ready
    for either path.
- If the later commit's version is what you actually want (your edit
  was wrong, or your edit accidentally over-included downstream
  content): `git checkout --theirs <file>`. Whether this is "rare"
  depends on why you started the rebase — it's common in mid-edit
  reconsiderations, rare in pure cleanup rebases.
- If neither side alone is right: edit the conflict markers manually.

**Beware: `git checkout --ours <file>` and `--theirs <file>` are
whole-file operations.** If a file has five hunks and only one
conflicts, `--ours` blows away non-conflicting `--theirs` content
elsewhere in the file (and vice versa). For files with mixed
conflicting and non-conflicting hunks, edit the conflict markers
manually — don't reach for `--ours`/`--theirs` as a shortcut.

## What not to do

- **Don't use `--no-verify` to bypass pre-commit hooks** (lint, format,
  tests). The squashed commit inherits the same working tree, so the hook
  failure will resurface. The commit-msg-hook carve-out for `fixup!
<long subject>` commits is the only acceptable use; document any other
  use explicitly.
- **Don't `git rebase --skip` to dodge a conflict you don't understand.**
  Skip discards the currently-applying commit's intent entirely; any
  partially-staged resolution is also discarded. If you intended to keep
  the commit, you'll lose content. Resolve the conflict instead — or use
  `git rebase --abort` if you've lost the thread.
- **Don't reach for `--force-with-lease` to push** until you've validated
  the rebased branch against the backup branch. The backup is your last
  line of defense.
- **Don't try to clean up history that's already pushed and shared**
  unless the rest of the team is on board. Force-pushing rebased history
  forces every collaborator to reset their local copies.
- **Don't use `GIT_EDITOR="cp ..."` for an unknown number of editor
  invocations** — it will fire for every one, including conflict editors
  you didn't plan for. Use an inline dispatcher (Pattern 3) or prefer
  `git commit -m` / `--amend -m` when you control the call directly.
- **Don't trust a scripted rebase's exit code alone.** Some safety
  configs (e.g. `rebase.missingCommitsCheck=error`) pause rather than
  abort when the rebase plan is rejected; the editor command exits 0 and
  the outer `git rebase` command exits 0 too, but `.git/rebase-merge/`
  is left in place. Always check for a leftover rebase dir after the
  command returns — see "Detecting a zombie rebase" in "Safety first".
