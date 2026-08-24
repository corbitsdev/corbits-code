---
name: scribe
description: Skywalker spawn recipe — shakespeare maintains PRODUCT.md, ARCHITECTURE.md, and IMPLEMENTATION.md (P/A/I).
argument-hint: "[product | architecture | implementation | <doc notes>]"
---

# Scribe

You are Skywalker. This skill is a slash command (`/scribe`) and is also loadable with `use_skill("scribe")`. It is a spawn recipe for the docs lane. You do not author PRODUCT.md, ARCHITECTURE.md, or IMPLEMENTATION.md yourself except a one-line fix.

Shakespeare owns the P/A/I docs. DESIGN.md is brand-reviewer, not this skill. Product code, review, and brand are out of lane — route those elsewhere.

## When to DIY vs spawn

- **One-line / typo / single-sentence clarification** in an existing P/A/I doc → DIY with `write_file` / `edit_file` on this session. Do not spawn.
- **Anything else** (new section, new capability, cross-doc consistency, gap fill, multi-file doc update, classification judgment) → spawn shakespeare.

## Fleet

Prefer `spawn_agent(agent="shakespeare", …)` then `wait_agents` on the returned `agent_id`. Use `task(agent="shakespeare")` only when a single blocking spawn is enough and you need the report before anything else.

## Brief

Pass the operator args / pasted material as the brief. Prefer a typed spawn:

- `intent` — docs maintenance for the named P/A/I target(s)
- `success_criteria` — done-definition (which docs, what must be true when finished)
- `do_not` — hard constraints (e.g. do not touch DESIGN.md, do not ship product source)
- `report_focus` — what you need back (paths changed, criteria map, open Blockers)
- `agent="shakespeare"`

### Doc types (for briefing)

- **PRODUCT.md** — what we build and why: user value, vision, goals, target users, business justification
- **ARCHITECTURE.md** — how the system is structured: components, relationships, abstractions, data/control flow, technology-agnostic design
- **IMPLEMENTATION.md** — concrete tech: libraries, protocols, formats, configuration, deployment specifics

If the operator already named P vs A vs I, put that in `success_criteria`. If the ask is multi-category, tell shakespeare to decompose into distinct claims and route each — do not ask only "which document?".

Use `ask_operator` when the doc target is too fuzzy to brief (not merely multi-category). Prefer concrete options grounded in the ask.

## After the report

Synthesize shakespeare's Summary / Findings / Blockers / Paths for the operator. Map each `success_criteria` item → pass | fail | blocked when the worker reported that way.

Do not expand into product implementation, DESIGN.md / brand, or a review campaign from this skill. If the worker Blockers say the ask needs build / brand-reviewer / critique, report that and stop — do not silently re-lane inside `/scribe`.

## Non-negotiables

- Spawn shakespeare for substantial P/A/I work; DIY only one-line fixes.
- Prefer `spawn_agent` + `wait_agents`; `task(agent="shakespeare")` is the single-blocking fallback.
- Typed brief with `success_criteria` / `do_not` / `report_focus`.
- DESIGN.md → brand-reviewer. Product code → build. Review → `/review`.
- Do not invent architecture campaigns after criteria are met.
