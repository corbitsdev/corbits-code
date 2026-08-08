## Parallel sub-agents actually work now

Running several sub-agents at once was close to unusable. The watchdog meant to
catch a hung run was killing healthy ones, approvals piled up one at a time and
printed twice, and the panel that used to show what each agent was doing had
collapsed to a single line of counts. This release fixes that path end to end.

### Your agents were being killed mid-run

The stall watchdog treated any silence as a hang. In a parallel fan-out the
first sub-agent to finish flipped the run back to "awaiting a response", and
because the parent emits nothing while children work, the whole run looked
silent — so after ninety seconds it announced no response, and after fifteen
minutes it aborted everything still in flight. The watchdog now knows that work
is outstanding and stays quiet while it is.

The same watchdog also ran while you were reading an approval. Being blocked on
an operator is now part of the run's state rather than something only the
painter knew, so a prompt you take your time over cannot be torn down
underneath you. That applies to approvals still queued behind another, not only
the one on screen.

### Approvals

**Answer once, not once per agent.** Granting a permission now clears every
queued request that grant already covers, instead of asking again for each
sub-agent that wanted the same thing. The reconciliation lives in the
permission layer, so it holds for any surface, not just the terminal.

**Every approval printed twice.** A screen of approvals read as twice as many
requests as had actually happened. Now there is exactly one row per decision —
including denials, timeouts, and aborts, which previously left no trace at all.
An agent that died of a refused permission looked identical to one that hung.

**Grants you had already given were being ignored.** A project-scoped grant was
recorded against the session root, while a sub-agent asks from inside its own
git worktree, and the two were compared as plain strings. No project grant ever
matched a sub-agent — so the agents generating the approvals were the ones that
could never benefit from a previous answer. Worktrees are now resolved through
the same registry that governs path containment, matched exactly rather than by
prefix, so a directory that merely starts with the same characters cannot pass
for one.

### Watching the work

The live agents panel is back above the prompt: one row per running sub-agent
with elapsed time, current tool, and whether it has gone quiet. It holds
position as agents work rather than reordering on every event, shrinks a row at
a time when the terminal is short instead of vanishing, and when more agents are
running than fit, the quietest one stays visible — that is the one worth seeing.

### Goal mode no longer sticks at "working"

Two events could register the same tool call under different identities, one by
id and one by name, so a call was counted twice and only cleared once. The turn
then waited forever on a call that had already finished. Worst in goal mode,
which keeps continuing on its own and never emitted the fallback that settles a
stuck turn.

Relatedly, `run.json` now records its turn count at every turn boundary instead
of only at the start and end of a session, so a resumed session reports what it
actually did.
