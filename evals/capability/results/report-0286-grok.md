# Gate verdict: 0.2.86 behavior changes, measured on grok-4.5

Both matrices ran on the real configured provider (xai/thegreataxios : grok-4.5,
OAuth, provider pinned per cell and verified — no fallback), same instrument on
both sides: today's eval tooling, 7 cases x 3 repeats each. Baseline = the
pre-dispatch product tree; After = the completed tree.

## Headline

| | baseline (old build) | after (new build) |
|---|---|---|
| pass rate | 19/21 | 21/21 |
| wall time | 54.8 min | 7.2 min |
| total turns | 312 | 106 |
| input tokens | 2.82M | 1.12M |

## Gate criteria

1. Pass-rate not down: HOLDS — up, 19/21 -> 21/21. complex-jwt went 1/3 -> 3/3;
   the old build blew its turn budget twice (42 and 88 turns vs a 40 cap).
2. Targeted behaviors down: HOLDS on every measurable axis —
   - tool-only streak medians: simple-health 16->2, loop-bait 9->1, env-bait 6->1,
     subagent-bait 4->1, complex-jwt 42->6
   - web-bait network shell commands 1->0 with web_fetch used in every after run
   - repeated searches 0 across all after cells; old build re-polled the slow
     command in 1 of 3 subagent-bait runs
3. Turns/tokens not up: HOLDS — roughly 3x fewer turns and 2.5x fewer input
   tokens for strictly more passing work.

## The operator's standard: zero sub-agent churn

Met on this instrument: after-build subagent-bait waited through the slow command
once per run (~36s wall, longest turn ~32s, zero repeated searches, streak <= 2,
no stall nudge needed). The standing protections (stall nudge -> salvage, thrash
caps, loop pause) remain the backstop for shapes these fixtures do not cover.

## Honesty notes

- env-bait and edit-bait pass on both builds with zero env-assignments and zero
  shell edits on both sides: those baits still do not reproduce their misbehavior
  on grok-4.5, so for those two metrics this comparison demonstrates
  no-regression, not improvement. Their enforcement is carried by deterministic
  gate tests instead.
- web-bait streak ticked 2->4 (the after build narrates around a two-step
  fetch+verify); within noise, flagged for completeness.
- Reasoning effort was provider-default on both sides (not the interactive
  sessions' high); pinning effort into the eval config is a tracked follow-up.
- Single model. Kimi and a control model remain unmeasured; the matrix rerun on
  those is the standing CL-4836 follow-up.

Verdict: the gate CLEARS on grok-4.5. The dispatch made the product
significantly better on every axis this instrument can see.
