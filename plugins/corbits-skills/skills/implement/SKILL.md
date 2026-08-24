---
name: implement
description: Disciplined per-commit workflow — Skywalker spawns greybeard, builder, intern/tester, critic.
---

# Implement

You are Skywalker. This skill is a per-commit spawn recipe for substantial landings.

DIY is the exception: tiny / single-file / one-route / clear bounded product edits → use write_file/edit_file/delete_file on this session. Do not load this loop for that work.

Spawn remains the default for substantial, multi-file, parallel, or specialist work (scale to named non-overlapping lanes — no hard worker cap). When this recipe runs, spawn workers. Wait for reports. Decide the next spawn from those reports.

## Prerequisites

Load `style` and `philosophy` via `use_skill` on the primary **before spawning**. Follow those conventions in every brief you hand to workers.

## Tracking

Track commit-sized units with `manage_tasks`. One item per unit that will become a commit.

- Before starting: create an item for each unit from the caller's instructions.
- When a unit begins: mark it in progress.
- When critic is clean and the build gate passed: mark it done.
- If new work surfaces (greybeard suggests a prep refactor, critic reveals an edge case that warrants its own commit), append a new `manage_tasks` item and run it through the full loop.

## Per-commit spawn loop

For each unit, run these steps in order. Do not skip. When this loop is running, do not DIY the unit — spawn builder.

### 1. Review — greybeard

`task(agent="greybeard")` on the approach before any code is written.

Send:

- What will change and why
- Files expected
- Design decisions and trade-offs
- Uncertainties

Adjust the plan from the report, then spawn builder. Greybeard is for approach, not execution.

### 2. Implement

`task(agent="builder")` with a typed brief:

- `intent`
- `success_criteria`
- `do_not`
- `report_focus`

**Bug fixes:** tell builder to start from a failing test — write the repro, confirm it fails, then fix, then confirm it passes. If the test does not fail first, the bug is not understood.

**Features:** tests ship with the change. The test asserts the new behavior, not merely that the process did not crash.

Keep scope to this unit. Additional work becomes a later `manage_tasks` item, not a silent expansion of the current brief.

### 3. Build gate — intern or tester

`task(agent="intern")` or `task(agent="tester")` for the project build/test gate (`make`, or the project's full pipeline: format, lint, build, test).

- `intern` — mechanical full pipeline
- `tester` — suite / repro

Do not move forward with a broken build. If failures come from this unit, re-dispatch builder. If they are pre-existing and unrelated, report Blockers and stop. Do not substitute a partial compile for the full gate.

### 4. Critique

`task(agent="critic")` on the diff. Include the intent agreed with greybeard so critic evaluates plan vs execution, not only surface quality. Limit findings to this unit; pre-existing issues in touched files are out of scope unless they block the gate.

If critic is **blocking**, re-dispatch builder once or twice with those findings in `success_criteria` / `do_not`, then re-run the build gate and critic. After two re-fix rounds, report Blockers — do not loop forever.

When critic is clean (or remaining findings are acknowledged judgment calls), mark the unit done and start the next.

## Hard rules

- Tiny / single-file / one-route / clear bounded edits: DIY with write_file/edit_file/delete_file. This recipe is for substantial units — when running it, spawn, do not DIY the coding.
- Spawn with `task(agent="greybeard")`, `task(agent="builder")`, `task(agent="intern")` or `task(agent="tester")`, and `task(agent="critic")`.
- Track only with `manage_tasks`.
- Do not shortcut the loop. Skipping greybeard “because this is simple” or skipping critic “because the build passed” defeats the recipe.
- Build must pass before treating a unit as done.

## Report

When the requested units are done (or blocked), synthesize for the operator:

## Summary

## Findings

## Blockers

## Paths
