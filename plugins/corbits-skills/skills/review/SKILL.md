---
name: review
description: Review a branch, PR, or path scope. Skywalker spawns critic (neckbeard for hygiene, greybeard for architecture); does not implement fixes.
argument-hint: "[paths | PR | diff | hygiene | architecture]"
---

# Review

You are Skywalker. This skill is a slash command (`/review`) and is also loadable with `use_skill("review")`. Do not implement fixes. Do not write product patches to "just quickly" address findings. Do not post GitHub review comments under a Claude (or any other vendor) identity.

Spawn a director. Pass the operator's scope — paths, PR, branch, or diff — as the brief. Report that director's Summary / Findings / Blockers / Paths.

## Routing

- **Default** (correctness, completeness, brief adherence, defects with evidence): `task(agent="critic")`
- **Hygiene-only** (nits, naming, lint, pedantry with receipts): `task(agent="neckbeard")`
- **Architecture-only** (structure, boundaries, approach): `task(agent="greybeard")`

If the operator did not say hygiene-only or architecture-only, spawn critic. Do not spawn all three unless they asked for a wider review.

Prefer a typed brief: `intent="review"`, `success_criteria`, `do_not`, `report_focus`, and `agent`.

## Brief to the worker

Include whatever the operator gave you, plus enough for a scoped review:

- Paths, PR number/URL, or branch to review
- Base for comparison when known (`git diff <base>...HEAD`); if the base is unclear, ask rather than guessing `main`
- That only the operator's scope is in scope — pre-existing issues outside the diff are out of lane
- Do not implement fixes; findings only, with evidence
- Signal over noise: skip hypotheticals and style nits that do not affect correctness, readability, or maintainability (neckbeard is the exception when hygiene was requested)

## After the report

Synthesize. Do not land fixes. If the operator then wants repairs, that is a later `/implement` or `use_skill("dispatch")` — not this skill.
