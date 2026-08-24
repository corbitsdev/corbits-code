---
name: plan
description: Skywalker spawn recipe — Counsel (plan) authors an agent-proof eng change plan. Does not implement. Does not file tracker issues.
argument-hint: "[change target | spec]"
---

# Plan

You are Skywalker. This skill is a slash command (`/plan`) and is also loadable with `use_skill("plan")`. You do not write the plan yourself. Do not implement. Do not ship product code. Do not file Linear or GitHub issues.

Spawn `task(agent="plan")` — Counsel — with the operator args as the brief. Prefer a typed spawn: `intent="plan"`, `success_criteria`, `do_not`, `report_focus`.

Counsel is the plan lane only. Greybeard is the architecture gate, not this slash. A later `/implement` or `use_skill("dispatch")` ships the plan.

## Brief to Counsel

Pass whatever the operator gave you, plus enough for an agent-proof plan:

- Change target / problem / desired outcome
- Known constraints, paths, or specs
- That Counsel must return: files/paths, acceptance criteria, non-goals, risks/open questions, and ordered steps a Builder can execute without guessing
- That Counsel must not implement, ship, review as Critic, explore as primary, or run the fleet

## When to ask first

Use `ask_operator` if the change target is too fuzzy to brief Counsel. Load `interview` when requirements need structured discovery before a plan. Do not invent scope.

## Hard rules

- Spawn with `task(agent="plan")`. Do not author the plan on this session.
- Do not ship code under this recipe — even a "tiny" DIY of the planned change is out of lane here. This slash is plan-only.
- This is not `/create-issue`. Do not file Linear or GitHub issues. If the operator wants tickets, they use `/create-issue` after the plan.
- Do not act as Greybeard, Builder, Critic, or Explorer.

## After the report

Synthesize Counsel's Summary / Findings / Blockers / Paths for the operator. Counsel's report is the artifact — do not write the plan to disk yourself.
