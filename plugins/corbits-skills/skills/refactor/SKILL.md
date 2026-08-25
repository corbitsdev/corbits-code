---
name: refactor
argument-hint: <directory>
description: Map a directory then plan improvements. Explore, then plan. Does not ship product code.
---

# Refactor

How to map a directory and plan improvements. `$ARGUMENTS` is the directory. This recipe maps and plans; it does not ship. Tiny / single-file / one-route product edits outside this recipe may be DIY with write_file/edit_file/delete_file.

## Steps

1. Load philosophy via `use_skill("philosophy")` on the primary **before spawning**. Those principles guide how to evaluate design decisions and what goes in worker briefs.
2. If `$ARGUMENTS` is missing or the directory is broad, `ask_operator` before exploring:
   - Is there a specific concern or area to focus on?
   - What prompted the desire to refactor?
   - Are there known pain points?
3. Spawn `task(agent="explorer")` to map `$ARGUMENTS`. Brief it to cover:
   - What the code does (purpose and behavior)
   - Key components and their responsibilities
   - How data flows through the system
   - Dependencies (internal and external)
   - Patterns and conventions in use
   - Areas of complexity or inconsistency (factual, not prescriptive)
4. From the explore report, `ask_operator` for collaborative choices: priorities, which observations to act on, accept / reject / modify proposals. Iterate until alignment. Do not invent a plan the operator did not choose.
5. Spawn `task(agent="counsel")` for the improvement plan. Include the operator's choices, the explore findings, and `$ARGUMENTS`. The plan should cover:
   - Specific changes to make
   - Rationale for each change (grounded in philosophy: pragmatic over idealistic, simple is usually harder than easy, do no harm, respect existing decisions)
   - Suggested order of operations
   - Constraints or risks
   - Enough detail that a builder worker could execute later
   - For structural transformations (renames, signature changes, API migrations), note that execution should load the `ast-grep` skill — bulk AST rewrites, not manual read-edit-write cycles

Do not write the plan to disk. Counsel's report is the artifact. A later `/implement` or `use_skill("dispatch")` ships it.

## Hard rules

- Do not write the plan to disk or author design documents on this session — counsel's report is the artifact.
- Do not skip explore "because the directory is already known."
- Do not skip `ask_operator` when the operator has not chosen among alternatives.
- Spawn with `task(agent="explorer")` then `task(agent="counsel")`.
