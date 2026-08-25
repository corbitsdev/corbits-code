---
name: implement
description: Disciplined per-commit workflow with greybeard review, a build gate, and a critic loop. Use when each commit should be reviewed and verified before it lands.
---

# Implement

How to produce reviewed, verified commits. Load when each commit should go through architectural review, build verification, and code critique before it lands.

This is a standalone skill, not part of dispatch. The caller defines what work to do and where the commit boundaries are. This skill defines _how_ each commit gets produced.

Tiny / single-file / one-route / clear bounded edits do not need this loop.

## Prerequisites

Load `style` and `philosophy` first. Follow their conventions throughout. Workers do not mount `use_skill` — copy those conventions into any worker brief.

## Tracking

Track commit-sized units with `manage_tasks`. One item per unit that will become a commit.

- Before starting: create an item for each unit from the caller's instructions
- When a unit begins: mark it in progress
- When critic is clean and the build gate passed: mark it done
- New work that surfaces → append an item and run the full loop

## Per-commit workflow

For each unit, run these steps in order. Do not skip.

### 1. Greybeard — approach

`task(agent="greybeard")` on the approach before any code is written.

Send: what will change and why, files expected, design decisions and trade-offs, uncertainties.

If greybeard identifies problems, adjust before implementing. A different approach deserves a serious look. Disagreement needs a reason. Greybeard is for approach, not execution.

### 2. Implement and test

- **Bug fixes:** write a failing repro first, confirm it fails, fix, confirm it passes. If the test does not fail first, the bug is not understood.
- **Features:** tests ship with the change. Assert the new behavior, not merely that the process did not crash.

Follow the repository's existing test conventions. If there are no tests, ask what framework to use before proceeding.

Keep scope to this unit. Additional work becomes a later `manage_tasks` item.

### 3. Build gate

Run the project's full pipeline (`make`, or format / lint / build / test). `task(agent="intern")` for a mechanical full pipeline, or `task(agent="tester")` for suite / repro evidence.

Do not move forward with a broken build. Failures from this unit → fix and re-run. Pre-existing unrelated failures → Blockers and stop. Do not substitute a partial compile for the full gate.

### 4. Commit

Create the commit. Follow `style`. Tests land in the same commit as the implementation.

### 5. Critic loop

`task(agent="critic")` on `git show HEAD`. Include the intent agreed with greybeard so critic evaluates plan vs execution. Limit findings to this unit.

Blocking findings → fix, re-run the gate, land the fix on the right commit (amend HEAD, or edit-in-place via `git-rebase` for an earlier commit), then re-run critic. Close the loop; if still blocked, report Blockers — do not loop forever.

When critic is clean (or remaining findings are acknowledged judgment calls), mark the unit done and start the next.

## Non-negotiables

- Do not shortcut the loop. Skipping greybeard "because this is simple" or critic "because the build passed" defeats the recipe.
- Build must pass before treating a unit as done.
- Do not invent a worker-count or fan-out ceiling.
- Track only with `manage_tasks`.

## Report

When the requested units are done (or blocked):

## Summary

## Findings

## Blockers

## Paths
