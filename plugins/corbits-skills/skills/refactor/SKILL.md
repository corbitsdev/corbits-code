---
name: refactor
argument-hint: <directory>
description: Examine code, document its design, and collaboratively plan improvements
---

# Refactor

Use this skill to analyze existing code, produce a structured design document, and collaboratively plan improvements for future implementation.

## Initialization

Before doing anything else, load the `philosophy` skill. The principles in that skill guide how you evaluate design decisions.

## Workflow

### Step 1: Understand the Scope

The user has specified a directory to analyze: `$ARGUMENTS`

If the directory is broad, ask clarifying questions:
- Is there a specific concern or area they want to focus on?
- What prompted the desire to refactor?
- Are there known pain points?

### Step 2: Examine the Code

Explore the specified directory to understand:
- What the code does (purpose and behavior)
- Key components and their responsibilities
- How data flows through the system
- Dependencies (internal and external)
- Patterns and conventions in use
- Areas of complexity or inconsistency

### Step 3: Document Current Design

Write a structured markdown document to the current working directory. Choose a filename that reflects what was analyzed.

Document structure:

**Overview** - What this code does and its role in the larger system

**Components** - Key parts and their responsibilities

**Data Flow** - How data moves through the system

**Dependencies** - What it relies on

**Patterns** - Design patterns and conventions observed

**Observations** - Complexity, inconsistencies, or potential concerns (factual, not prescriptive)

### Step 4: Collaborative Improvement Discussion

After documenting the current state:

1. Present your observations and ask the user about their priorities
2. Propose specific improvements with rationale grounded in philosophy principles (pragmatic, simple over easy, etc.)
3. Let the user accept, reject, or modify proposals
4. Ask follow-up questions to refine the approach
5. Iterate until alignment is reached

### Step 5: Write the Plan

Append an **Improvement Plan** section to the document with:

- Specific changes to make
- Rationale for each change
- Suggested order of operations
- Any constraints or risks to be aware of
- Enough detail that another agent could execute the plan
- For structural transformations (renames, signature changes, API migrations), note that the `ast-grep` skill should be loaded during execution — it enables bulk AST-based rewrites instead of manual read-edit-write cycles

## Output

A single markdown file in the user's current working directory containing both the design analysis and the improvement plan.

## Guiding Principles

From the philosophy skill:
- **Pragmatic over idealistic** - Don't propose changes for theoretical purity
- **Simple is usually harder than easy** - Favor designs that are genuinely simple, not just quick
- **Do no harm** - Consider risks to stability and correctness
- Respect existing decisions; understand why things are the way they are before proposing changes
