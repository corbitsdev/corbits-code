---
name: scribe
description: Maintain PRODUCT.md, ARCHITECTURE.md, and IMPLEMENTATION.md. Routes input, detects gaps, and asks for completeness.
---

# Scribe

How to maintain product, architecture, and implementation docs. Analyze input, route it to the correct document, then check gaps and cross-doc consistency. One-line wording fixes may be edited directly.

Clarifying questions use `ask_operator`. DESIGN.md is rand, not this skill.

## Document discovery

Before classifying input, locate and read existing docs (case-insensitive) in the repo root and `docs/`:

- PRODUCT.md, ARCHITECTURE.md, IMPLEMENTATION.md
- Prefer root when multiple matches exist
- Defaults when missing: create at repository root after confirming

Read existing docs first — vocabulary, patterns, constraints, similar features.

## Document types

**PRODUCT.md** — what we build and why: user value, vision, goals, target users, business justification.

**ARCHITECTURE.md** — how the system is structured: components, relationships, abstractions, data/control flow, technology-agnostic design.

**IMPLEMENTATION.md** — concrete tech: libraries, protocols, formats, configuration, deployment.

## Steps

### 1. Analyze and classify

Use general heuristics plus project vocabulary from the existing docs (project terms win when clear):

- **Product:** user needs, value, market, "users can", goals without how
- **Architecture:** components, interactions, abstractions, tech-agnostic design
- **Implementation:** named technologies, wire formats, config, "uses" / "built on"

### 2. Route and deepen

If classification is clear, update the right document.

If ambiguous or multi-category, do not only ask "which document?" Decompose into distinct claims and route each. Prefer context-aware `ask_operator` options from existing docs; fall back to general options when docs are empty. One statement may update multiple docs.

### 3. Update

Read the target, place content (extend section / new section / revise), match existing style. Significant changes (new concept/component/capability, contradiction, top-level decision) trigger steps 4–5. Minor clarifications skip to the report.

### 4. Cross-document consistency (significant only)

Check sibling docs for implied missing entries (new architecture with no product justification, product capability with no architecture, implementation naming an undescribed component). Surface targeted questions; update from answers.

### 5. Gap detection (significant only)

Scan for thin sections, undefined references, missing failure modes/constraints, decisions without rationale. Probe with contextual options. If the operator declines further probing, stop unless they ask.

### 6. Report

Confirm what changed and where. Summarize consistency/gap follow-ups.

## Errors

- **Missing doc:** `ask_operator` whether to create it.
- **Conflict with existing content:** `ask_operator` replace / keep both / merge.
- **Unclear scope:** `ask_operator` which document and why.
