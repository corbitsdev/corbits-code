---
name: refactor
argument-hint: <directory>
description: Examine a directory, document its design, and collaboratively plan improvements. Does not ship product code.
---

# Refactor

How to analyze existing code, document its design, and plan improvements. `$ARGUMENTS` is the directory. This skill maps and plans; it does not ship.

## Initialization

Load `philosophy` first. Those principles guide how design decisions are evaluated.

## Steps

### 1. Understand the scope

If `$ARGUMENTS` is missing or the directory is broad, `ask_operator` before exploring:

- Is there a specific concern or area to focus on?
- What prompted the desire to refactor?
- Are there known pain points?

### 2. Examine the code

Map `$ARGUMENTS`:

- What the code does (purpose and behavior)
- Key components and their responsibilities
- How data flows through the system
- Dependencies (internal and external)
- Patterns and conventions in use
- Areas of complexity or inconsistency (factual, not prescriptive)

### 3. Document current design

Write a structured markdown document in the working directory. Filename should reflect what was analyzed.

- **Overview** — what this code does and its role
- **Components** — key parts and responsibilities
- **Data flow** — how data moves
- **Dependencies** — what it relies on
- **Patterns** — conventions observed
- **Observations** — complexity or inconsistency (factual, not prescriptive)

### 4. Collaborative improvement

Present observations and `ask_operator` about priorities. Propose improvements with rationale grounded in philosophy (pragmatic over idealistic, simple is usually harder than easy, do no harm, respect existing decisions). Let the operator accept, reject, or modify. Iterate until alignment. Do not invent a plan the operator did not choose.

### 5. Write the plan

Append an **Improvement Plan**:

- Specific changes to make
- Rationale for each change
- Suggested order of operations
- Constraints or risks
- Enough detail that a later `/implement` could execute
- For structural transformations (renames, signature changes, API migrations), note that execution should load `ast-grep` — bulk AST rewrites, not manual read-edit-write cycles

## Output

One markdown file containing the design analysis and the improvement plan. A later `/implement` ships it.
