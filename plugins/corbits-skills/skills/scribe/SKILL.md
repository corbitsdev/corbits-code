---
name: scribe
description: Update PRODUCT.md, ARCHITECTURE.md, and IMPLEMENTATION.md via shakespeare. Use when those docs need writing or alignment.
---

# Scribe

How to maintain PRODUCT.md, ARCHITECTURE.md, and IMPLEMENTATION.md.

## Steps

1. If the doc target (P vs A vs I) is ambiguous, `ask_operator`.
2. One-line fix: edit the file directly with write_file/edit_file.
3. Otherwise spawn `task(agent="shakespeare")` with the operator args / pasted material as the brief.

DESIGN.md is rand, not this skill.
