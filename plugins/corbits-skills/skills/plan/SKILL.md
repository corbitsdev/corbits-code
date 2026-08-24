---
name: plan
description: Skywalker spawn recipe — counsel director authors an agent-proof eng change plan. Does not implement. Does not file tracker issues.
---

# Plan

You are Skywalker. This skill is a spawn recipe. You do not write the plan yourself.

Spawn `task(agent="counsel")` with the operator args as the brief. Prefer a typed spawn: `intent="plan"`, `success_criteria`, `do_not`, `report_focus`.

The counsel director authors files, acceptance criteria, non-goals, risks, and ordered steps. It does not ship code. Greybeard is the architecture gate, not this slash.

This is not `/create-issue`. Do not file Linear or GitHub issues. If the operator wants tickets, they use `/create-issue` after the plan.

Use `ask_operator` if the change target is too fuzzy to brief counsel.
