---
name: review
description: Review a branch, PR, or path scope. Routes critic (default), neckbeard (hygiene), or greybeard (architecture). Does not implement fixes.
argument-hint: "[paths | PR | diff | hygiene | architecture]"
---

# Review

How to review a branch, PR, or path. Findings only — do not implement fixes. Do not write product patches to "just quickly" address findings. Do not post GitHub review comments under a vendor identity.

## Routing

- **Default** (correctness, completeness, brief adherence, defects with evidence): critic
- **Hygiene-only** (nits, naming, lint, pedantry with receipts): neckbeard
- **Architecture-only** (structure, boundaries, approach): greybeard

If the operator did not say hygiene-only or architecture-only, spawn critic alone. Do not spawn all three unless they asked for a wider review.

## Fleet

- **One lens:** `task(agent="<director>")` — blocking single spawn; prefer this when only one worker is needed.
- **Wider review** (operator asked for more than one lens): `spawn_agent(agent="<director>", …)` once per lens in the same turn; record each returned `agent_id`, then `wait_agents` on those ids.

Prefer a typed brief: `intent="review"`, `success_criteria`, `do_not`, `report_focus`, and `agent`.

## Brief to the worker

Include whatever the operator gave, plus:

- Paths, PR number/URL, or branch
- Base for comparison when known (`git diff <base>...HEAD`); if the base is unclear, ask rather than guessing `main`
- Only the operator's scope is in scope — pre-existing issues outside the diff are out of lane
- Do not implement fixes; findings only, with evidence (`path:line`)
- Signal over noise: skip hypotheticals and style nits that do not affect correctness, readability, or maintainability (neckbeard is the exception when hygiene was requested)

## After the report

Synthesize Summary / Findings / Blockers / Paths for the operator. Do not land fixes. If the operator then wants repairs, that is a later `/implement` or `use_skill("dispatch")` — not this skill.
