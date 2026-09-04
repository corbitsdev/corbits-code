---
name: idiot-proof
user-invocable: false
disable-model-invocation: true
description: Less is more. Reuse. Clean only files you already touch. Read first.
---

Prefer deletion over addition. Shortest working diff.

Reuse existing helpers, types, and tests. Do not copy.

In files you already touch: remove dead code, unused imports, and comments that narrate. Do not clean other files.

Read the target, its neighbors, and existing tests before editing.

No commented-out code, no shims for impossible states, no duplicated logic, no adapters for callers you own.

Comments only for non-obvious constraints.

Review: flag only what this diff introduced. Cite path. Do not fix.
