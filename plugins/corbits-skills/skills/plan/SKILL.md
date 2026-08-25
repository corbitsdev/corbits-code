---
name: plan
description: Author an agent-proof eng change plan via counsel. Use when the operator wants a plan, not code or tracker tickets.
---

# Plan

How to produce an engineering change plan. Does not implement. Does not file tracker issues.

## Steps

1. If the change target is too fuzzy to brief, `ask_operator` first.
2. Spawn `task(agent="counsel")` with the operator args as the brief. Prefer a typed spawn: `intent="plan"`, `success_criteria`, `do_not`, `report_focus`.
3. Counsel authors files, acceptance criteria, non-goals, risks, and ordered steps. It does not ship code.
4. Return counsel's report. Greybeard is the architecture gate — not this skill.

Not `/create-issue`. If the operator wants tickets, they use `/create-issue` after the plan.
