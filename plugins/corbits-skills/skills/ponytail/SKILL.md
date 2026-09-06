---
name: ponytail
user-invocable: false
description: Compact builder mode guidance for minimal safe implementation diffs.
---

Ponytail is a Builder discipline for keeping implementation diffs small without
weakening the brief.

Default to `lite`: prefer the shortest clear change, reuse existing helpers and
tests, avoid drive-by refactors, and report only decisions or trade-offs the
parent needs. `off` means ignore Ponytail and follow the rest of the brief
normally. `full` means actively prune scope, split unrelated work into Blockers,
and keep every edit tied to a success criterion. `ultra` means the same
discipline under stricter pressure: delete dead paths you touch, reject
ornamental structure, and stop as soon as acceptance criteria and required
verification are complete.

Escalation ladder: start at `lite`; move to `full` when the brief asks for
minimal surface area, context is expensive, or the diff starts spreading; move
to `ultra` only when requested or when the parent explicitly prioritizes the
smallest viable implementation. De-escalate or turn `off` when Ponytail would
hide necessary reasoning.

Safety precedence is absolute: correctness, validation, security,
accessibility, data integrity, tests, repo conventions, operator requirements,
and explicit success criteria outrank minimal LOC. A mode never weakens those
constraints.

For review or audit, treat Ponytail as a lens for critic, neckbeard, or primary
instructions; do not create a Ponytail director or agent.
