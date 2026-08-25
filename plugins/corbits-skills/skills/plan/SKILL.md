---
name: plan
description: Author an agent-proof eng change plan. Does not implement. Does not file tracker issues.
---

# Plan

How to produce an engineering change plan. Does not implement. Does not file tracker issues.

If the change target is too fuzzy to plan, `ask_operator` first.

## What the plan must contain

1. Files / paths to touch
2. Acceptance criteria mapped from the ask
3. Non-goals
4. Risks and open questions
5. Ordered steps a later `/implement` can execute without guessing

When requirements are fuzzy, put open questions under Blockers instead of inventing scope.

## What this is not

- Not `/create-issue`. If the operator wants tickets, they use `/create-issue` after the plan.
- Not an architecture gate. Greybeard reviews approach; this skill only authors the plan.
- Not implementation. Do not ship the change.
