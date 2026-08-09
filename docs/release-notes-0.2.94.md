## Orchestrator-first release

A truthful fleet board, thrash salvage that stops false completes, steering that
keeps your input, and one TUI root. Goal mode is gone. Coupled Interchange
packages are vendored at head.

### Fleet

**One fleet board** replaces the agents strip and task panel — identity, elapsed
time, and what each leaf is doing, clamped to the rows it was granted.

**Lane tools show a subject**, not just a tool name: a bounded, secret-scrubbed
preview of path / command / pattern on the board and dispatch trailer.

**Task dispatch collapses to a sentence** (description, else prompt) instead of
dumping raw argument JSON; expanded detail uses real line breaks.

**Fleet progress reports without a prompt**; bursts settle to one row per agent;
a mid-rebuild drop surfaces a not-delivered notice.

**`/new` and `/clear` wipe the painted transcript** and cancel live sub-agents so
orphans do not keep burning tokens under the old session.

### Thrash and leaf salvage

**`intent=implement` that never edits is not a successful complete.** Tool-using
leaves that never write salvage as never-edited and hard-block identical
re-dispatch (same path as never-acted and thrash).

**Soft mid-run re-read nudge** before the hard thrash stop: implement leaves are
asked to edit or wrap up; explore leaves are asked to expand findings or change
approach — never forced into edit.

**Format characters no longer break loop detection.** Zero-width spaces, BOM,
bidi marks, soft hyphens, and word joiners are stripped before period detection.

### Steering and interrupt

**Queue and steer are one mid-run gesture**; stop-and-reinject cuts the current
turn and puts a new instruction in its place.

**Queued operator input survives Ctrl+C** instead of being discarded.

### Permissions and workspace

**`--dangerously-skip-permissions` reaches pre-gate sandboxes** (path-escape,
delete, list_dir, shell cwd). Secret-guard path denies and authz hard blocks are
unchanged.

**Contained git worktree ops auto-allow in auto mode**, through the same
workspace-containment authority as shell path restrictions.

**`manage_tasks` no longer asks for approval.**

**Queued approval timers arm only when the gate is shown.**

### Goal mode removed

The goal subsystem is gone end to end — runtime, TUI chrome, slash commands, and
docs. Continuous work is the orchestrator plus task dispatch.

### TUI

**OpenTUI shell flattened into `src/tui/`** — one product root (path rewrite only).

**Landing snow paints**; mountain and hero survive startup load notices.

**Slash popup** shows `/name` only; Ctrl+O palette and bare `?` are removed.

**Semantic activity ticker**; skill and agent names highlight in the prompt;
duplicate pasted images are rejected by content hash.

**MCP auth banner clears** after mid-session re-auth succeeds.

### Sessions and process

**Active-run liveness is one write**; crashed sessions no longer list as running
forever; a rotated session stays crash-coverable.

**SIGINT / SIGTERM / SIGHUP terminate the process**; a detached throw restores
the terminal before exit.

### Providers and onboarding

**In-session provider connect actually connects**; onboarding validates a
credential before reporting a provider as configured.

**Model picker no longer overwrites the persisted default** when you only
inspect models.

OAuth success footer links the product site and GitHub.

### Vendoring, telemetry, hygiene

**`@intx/types`, `@intx/storage-isogit`, and `@intx/inference` vendored at
Interchange head** (local inference patches reapplied); licenses recorded and
re-sync documented.

Process-wide session id on every capture; PostHog AI events in privacy mode;
expanded anonymous product event catalog.

**Grep results go through the secret scrub.**

Shared helpers for grep truncation, MCP tool identifiers, pricing tree walks,
and grant scoping; nightly random-seed CI job dropped.
