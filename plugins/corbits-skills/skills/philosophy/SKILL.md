---
name: philosophy
user-invocable: false
description: Engineering philosophy and decision principles. Load when making architectural trade-offs, fixing bugs at the right layer, or judging scope and compatibility.
---

# Philosophy

Decision guidance for engineering work. Load alongside `style` when judgment matters — architecture, bug placement, scope, compatibility, and what to ship vs cut. This is guidance for choices, not a ritual or a checklist to recite.

## Guiding principles

**Pragmatic over idealistic.** Skip details that do not change the outcome. If you are unsure whether a detail matters, ask.

**Simple is usually harder than easy** — and it pays off. Prefer the design you can explain in one pass over the clever one that needs a tour.

**Do no harm** (Engineer Hippocratic Oath). Protect customers and their data. When in doubt, the safer path for data integrity wins.

**Benevolent dictatorship.** All ideas are welcome; not all will be acted on. Decide and move — we have work to do.

**The map is not the territory.** Docs guide you to the code. The code is the source of truth. When they disagree, believe the code and fix the map.

## Constraint ownership

Every system has layers. A constraint belongs in **exactly one** layer — the one with enough information to enforce it correctly.

- Downstream re-checks of upstream guarantees → duplication that eventually conflicts.
- Callers pre-processing inputs the callee already validates → needless complexity.
- Three layers enforcing the same rule → two are unnecessary and one is probably wrong.

Find the owning layer. Fix it there. Trust it everywhere else.

**Before fixing a bug, answer:**

1. What invariant is being violated?
2. Which layer owns that invariant?
3. Does that layer already attempt to enforce it?

If (3) is yes, fix that layer — not a downstream consumer. If the fix wants changes in more than one module, stop and name the owning layer and why.

Two or more fix commits in the same subsystem without resolution = symptom-chasing. Describe the constraint violation and ask where it should be fixed.

**It is almost never a bug in the compiler — until it is.** Exhaust your own code first. Do not fully dismiss the toolchain either.

## Backwards compatibility

Compatibility is not inherently virtuous. Context decides.

**Public interfaces deserve it.** External API, CLI, wire format, SDK — breaking those has real cost. Deprecate gracefully; version when you must break.

**Internal code does not.** Dead parameters, dual paths, and shims "just in case" are tech debt with a noble name. If you own the callers, update the callers.

Every leftover adapter is a lie about how the system works. Kill the old path when the new one is proven. **Who breaks if I remove this?** If nobody external, remove it.

## Collaboration

Ask questions early. Prefer public channels over private ones unless the content is secret — others learn from the trail.

When challenged on a design: "it was the best solution with the information I had" is a valid answer when it is true. Respect fellow engineers; judge code, not people. The "insane" implementation you are staring at may be yours from six months ago.

## Code & git (philosophy only)

Concrete formatting and commit mechanics live in `style`. The philosophical bar:

- Commits should read like a story of _why_
- Summaries short; body when the change needs it
- Do not mix refactors with feature additions
- Comments explain _why_, never narrate _what_

## Testing

Tests verify required behavior. They are how you refactor without dread. Prefer tests that pin the contract you care about over tests that freeze incidental structure.

## Automation & tools

Automate when appropriate: the first time may be too soon to understand the problem; by the third time, stop doing it by hand. Build tools when they make the problem easier — do not fear a small tool that removes repeated pain.

## Business context

Without engineering, sales has nothing to sell. Without sales, engineering cannot pay rent. That symbiosis informs priority: ship value that can be sold and supported, not museum pieces.

## Issues & scope

Issues represent real work, not hopes. An issue should be hand-offable and fit in about 2–3 days of implementation. Features may span many cheap tickets — clarity beats giant bags of work. Status updates in the ticket reduce status pings.
