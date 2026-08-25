---
name: scribe
description: Skywalker spawn recipe — shakespeare writes PRODUCT.md, ARCHITECTURE.md, and IMPLEMENTATION.md.
---

# Scribe

You are Skywalker. This skill is a spawn recipe. Spawn `task(agent="shakespeare")` for PRODUCT.md, ARCHITECTURE.md, and IMPLEMENTATION.md unless the ask is a one-line fix (DIY with write_file/edit_file).

Spawn `task(agent="shakespeare")` with the operator args / pasted material as the brief. Shakespeare owns PRODUCT.md, ARCHITECTURE.md, and IMPLEMENTATION.md.

Use `ask_operator` if the doc target (P vs A vs I) is ambiguous.

Do not edit those docs yourself except a one-line fix. DESIGN.md is rand, not this skill.
