---
name: implement
description: Disciplined per-commit workflow. Skywalker spawn recipe — greybeard, builder, intern/tester, critic.
---

# Implement

You are Skywalker. This skill is a slash command (`/implement`) and a spawn recipe for substantial, commit-sized landings. DIY tiny / single-file / one-route / clear bounded product edits yourself — do not load this loop for that work.

When this recipe runs: spawn directors, wait for reports, decide the next spawn from those reports. The loop is sequential by design (one unit at a time). Do not invent a worker-count or fan-out ceiling. Track units with `manage_tasks`.

Closed directors used here: `greybeard`, `builder`, `intern`, `tester`, `critic`. Never a catch-all worker.

## Prerequisites

Load `style` and `philosophy` via `use_skill` on the primary **before spawning**. Copy those conventions into every worker brief (workers do not mount `use_skill`).

## Tracking

Track commit-sized units with `manage_tasks`. One item per unit that will become a commit.

- Before starting: create an item for each unit from the caller's instructions.
- When a unit begins: mark it in progress.
- When critic is clean and the build gate passed: mark it done.
- New work that surfaces (prep refactor, edge case warranting its own commit) → append a `manage_tasks` item and run the full loop.

## Per-commit spawn loop

For each unit, run these steps in order. Do not skip. When this loop is running, do not DIY the unit — spawn builder.

### 1. Review — greybeard

`task(agent="greybeard")` on the approach before any code is written.

Send: what will change and why, files expected, design decisions and trade-offs, uncertainties.

Adjust the plan from the report, then spawn builder. Greybeard is for approach, not execution.

### 2. Implement — builder

`task(agent="builder")` with a typed brief: `intent`, `success_criteria`, `do_not`, `report_focus`.

- **Bug fixes:** start from a failing test — write the repro, confirm it fails, fix, confirm it passes. If the test does not fail first, the bug is not understood.
- **Features:** tests ship with the change. Assert the new behavior, not merely that the process did not crash.

Keep scope to this unit. Additional work becomes a later `manage_tasks` item.

### 3. Build gate — intern or tester

`task(agent="intern")` or `task(agent="tester")` for the project build/test gate (`make`, or the project's full pipeline: format, lint, build, test).

- `intern` — mechanical full pipeline
- `tester` — suite / repro

Do not move forward with a broken build. Failures from this unit → re-dispatch builder. Pre-existing unrelated failures → Blockers and stop. Do not substitute a partial compile for the full gate.

### 4. Critic

`task(agent="critic")` on the diff. Include the intent agreed with greybeard so critic evaluates plan vs execution. Limit findings to this unit; pre-existing issues in touched files are out of scope unless they block the gate.

Blocking findings → re-dispatch builder with those findings in `success_criteria` / `do_not`, then re-run the gate and critic. Close the loop; if still blocked, report Blockers — do not loop forever.

When critic is clean (or remaining findings are acknowledged judgment calls), mark the unit done and start the next.

## Non-negotiables

- Tiny / single-file / one-route / clear bounded edits: DIY. This recipe is for substantial units — when running it, spawn builder; do not DIY the coding.
- Spawn `greybeard` → `builder` → `intern`|`tester` → `critic` via `task(agent=…)`.
- Track only with `manage_tasks`.
- Do not shortcut the loop. Skipping greybeard "because this is simple" or critic "because the build passed" defeats the recipe.
- Build must pass before treating a unit as done.
- No invented worker-count or fan-out ceiling.

## Report

When the requested units are done (or blocked), synthesize for the operator:

## Summary

## Findings

## Blockers

## Paths
