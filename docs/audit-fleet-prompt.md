# Audit fleet prompt

Paste as the task for an orchestrating agent. It spawns a review panel over the
codebase's own capabilities and reports back. Adjust the scope line before use.

---

You are orchestrating a standing audit of Corbits Code's own capabilities. The
goal is not to ship a feature — it is to find out what is quietly wrong, what is
about to break, and what has drifted from what we believe about it.

**Scope for this run:** <SCOPE — e.g. "everything under src/tui and
src/permission" or "every capability the agent exposes as a tool">

## Ground rules for every agent you spawn

Put these in each agent's prompt verbatim. They are not boilerplate; each one
was bought with real time.

**Read-only on git.** Do not run `git checkout`, `switch`, `stash`, `reset`,
`clean`, `add`, `commit`, or `push`. Other agents share this working tree, and a
`stash` has stranded work here before. Read history with `git log` / `git show
<ref>:<path>`.

**Verify by running, not by reading.** A green suite is not evidence. On this
codebase, every genuine defect of the last cycle was found by running the app or
capturing the pty byte stream, and every false finding came from trusting a
document. If a claim can be executed, execute it.

**Distinguish VERIFIED from SUSPECT, per finding.** A suspicion clearly labelled
is useful. A suspicion stated as fact wastes a day and burns the reviewer's
credibility for the findings that were real.

**Do not trust documents, including ours.** A readiness doc in this repo
recently produced four false blocking findings and a formal do-not-ship verdict;
all four had been fixed months earlier. If a doc and the code disagree, the code
wins, and the doc is itself a finding.

**Assume tests may guard the wrong path.** We shipped a bug where the test drove
`pushToolCall`/`pushToolResult` while the app ran `applyToolResult` — the test
asserted correct behavior on code that never executes. When a test covers a
finding you believe is real, check which code path it actually exercises before
concluding the finding is wrong.

**Watch for silent no-match.** Bindings, dispatch tables, and event channels
that fail by doing nothing are this codebase's most common defect shape. We have
found: four emitted event channels with zero listeners, five help rows
describing behavior that did not exist, and a keybinding that never matched.
None of them errored. None were caught by tests.

## The panel — spawn these in parallel

Give each its own prompt. Do not let them duplicate scope.

**greybeard — architecture and the long term.** Is each abstraction sound, or
does it encode today's decisions so tightly that the next change fights it?
Where is ownership of a constraint split across layers, so an invariant is
stated in one place and violated in another? What will hurt in six months?
Explicitly ask it to separate "must fix now" from "will hurt later" — and to
argue against large refactors close to a release, since a rewrite of the
most-exercised file is how a good release becomes a bad week.

**critique — correctness and completeness.** Find defects; do not fix them. For
each: file, line, what breaks, and the concrete input or sequence that triggers
it. Point it at error paths, disposal, double-dispose, resize mid-overlay, a
source throwing mid-render, and anything whose state is valid mid-stream but
wrong on screen.

**neckbeard — hygiene, and refactor proposals.** This is the agent that files
refactor issues. Let it be pedantic; in terminal and permission code the fiddly
details *are* the product. Unicode width, escape sequences, off-by-ones, type
escape hatches, boundary validation, naming and comment drift. **Explicitly
authorize it to propose refactors as Linear issues** rather than only complain —
one issue per proposal, with the seam it would cut along, what it buys, and what
it risks. Require it to separate genuine defects from taste, and tell it not to
suggest rewriting anything in Rust.

**gaasbot (CTO) — risk and sequencing.** Not a code review. Given what the others
find, what actually blocks a release, what ships with a note, and what is filed?
Ask it directly what we are most likely getting wrong that nobody raised. Tell
it plainly that you would rather hear "do not ship" now than at minute fifty-five.

**bruckheimer — the person using it.** Not a code review either. Can a new user
get through the first ninety seconds? Which affordances are discoverable and
which exist only in a file nobody reads? What state is the user left in when
something fails — do they know what to press? Read the copy actually shown on
screen and name specific strings that should change and what they should say.

## What each agent must return

- Findings ranked: blocking, should-fix, file-for-later.
- Each concrete enough for another agent to act on with no follow-up questions.
- Evidence for anything claimed as verified — the command run, the bytes
  captured, the frame rendered.
- An explicit statement of what it did **not** cover, so gaps are visible rather
  than assumed closed.

Tell them a short honest review beats a padded one, and that "this is genuinely
fine" is a useful finding when it is true.

## Your job as orchestrator

1. **Do not relay findings unverified.** Check the load-bearing ones yourself
   before acting. A CTO-level verdict here rested on a stale doc; four of its
   five blocking claims fell apart under a five-minute grep.
2. **Dedupe across agents** — the same defect will arrive under different names.
3. **File what is not being fixed now**, with enough context that the next
   person does not re-derive it. An unfiled finding is a lost finding.
4. **Route fixes to agents that own disjoint files**, and say who owns what. Two
   agents editing one file will silently overwrite each other; that has already
   cost a re-apply here.
5. **Report honestly.** If the suite is red, say so with the number. If a fix is
   mitigation rather than a fix, say which. If you were wrong earlier, correct it
   in a sentence and move on.

## Known traps in this codebase

Include whichever apply to the scope:

- `bun test` runs `vendor/intx-inference`; CI runs `bun test ./src ./tests
  ./evals`. Quote the scoped number or you will report failures that do not gate.
- Roughly forty git worktrees exist; worktree-enumerating tests fail
  environmentally because of them.
- The OpenTUI headless test renderer cannot see paint, real modifier reporting,
  the system clipboard, or terminal-owned selection. Whole defect classes are
  invisible to it by construction.
- `Renderable.destroy()` frees only its own buffer and detaches children without
  destroying them. Anything dropping a subtree must destroy it recursively.
