# CL-5479 — HITL / Auto, drop native tiers, project path grants

Planning note for the product simplification tracked in CL-5479. Not a shipped
feature until the implementation PR lands and this plan is either folded into
PRODUCT/ARCHITECTURE or deleted.

## Goals

1. **Drop native model tiers** (`fast` / `standard` / `clever`).
2. **Two permission modes only:** HITL (ask) and Auto (free reign).
3. **Project path grants** for `@`-mentioned files and directories, persisted in
   global settings keyed by project identity (no repo-local grant file).

## Model tiers

### Remove from core

| Surface | Today | After |
|---|---|---|
| `settings.tiers` | `Partial<Record<ProviderTier, TierConfig>>` | Gone (migrate: warn + ignore) |
| Slash `/fast` `/standard` `/clever` | Switch active model to tier | Removed |
| `/model` tiers chrome | Assign tier legs | Providers + default/favorite only |
| Agent profile `tier` | Resolve via settings.tiers | Explicit provider/model or profile only |
| `task(tier=…)` | Per-spawn override | Removed (use profile / parent model) |
| Evaluator “prefer fast tier” | Fallback chain | Prefer default or a single configured cheap model if any |

### Migration

- Load still accepts `tiers` in JSON for one release.
- Log a one-shot warning: tiers are ignored; pick a default model in `/model`.
- Next major: reject or strip the key on save.

Related prior tickets: CL-5192, CL-5200, CL-5196.

## Permission modes

### HITL (default)

Current interactive gate behavior:

- Read-only tools allow inside workspace (+ worktrees + path grants).
- Ask for side-effecting tools, outside-workspace content, secrets, network, etc.
- Hard denials stay (OOM shell patterns, catastrophic recursive rm, secret-guard
  path-keyed reads/writes as today).

### Auto (free reign)

Operator-enabled unrestricted autonomy for the session (and optionally the run):

- Gate short-circuits to allow (same family as today’s `skipPermissions`).
- No permission modal for tools.
- UX must make the risk obvious when enabling (status chrome + one-line
  confirmation).
- Headless default remains fail-closed unless Auto is explicitly set for that
  run.

This **replaces** the current “soft auto” envelope (partial auto-allow with many
forced asks). Soft-auto rule tables become HITL-only complexity we can simplify
over follow-ups; Auto no longer consults them.

### Toggle

- SHIFT+TAB (or successor) switches HITL ↔ Auto.
- Status bar shows `HITL` or `Auto` clearly.

## Project path grants

### Trigger

When the operator sends a message containing `@path` that resolves to a real
file or directory **outside** the primary workspace (+ registered worktrees):

1. Still block sensitive paths (`.env`, keys, certs, …).
2. Inline content / directory summary into the message as today (when safe).
3. Register a **read-only grant** for the realpath:
   - File → that file only.
   - Directory → that directory tree.

### Storage

- Global settings only (e.g. under `~/.corbits/settings.json` or the project-key
  map already used for per-project state), keyed by project identity.
- **Never** write grants into the git worktree — other users and clones must not
  inherit them.

Sketch (names illustrative):

```json
{
  "projectPathGrants": {
    "<project-key>": [
      { "path": "/abs/benchmark", "mode": "read", "kind": "dir" },
      { "path": "/abs/notes.txt", "mode": "read", "kind": "file" }
    ]
  }
}
```

### Gate integration

- Path restriction treats granted realpaths as in-bounds for **reads** and pure
  listings.
- Writes / edits / shell mutations under a grant still **ask** in HITL
  (default). Auto free-reign already allows them.
- Symlink policy: evaluate realpath at use time; only paths under a granted
  realpath root (or equal to a granted file) count.

### UX

- Transcript line: `Granted read-only access to ../benchmark/ for this project.`
- `/permissions` (or settings) lists and revokes grants for the current project.

## Suggested implementation order

1. Path grants (storage + `@` resolution + path-restriction) — high user value,
   smaller blast radius.
2. HITL rename + Auto free-reign (gate short-circuit) — product mode clarity.
3. Strip native model tiers (settings, slash, task, profiles, docs) — largest
   surface; can land as a follow-up PR on the same branch stack.

## Out of scope for the first land

- Plugin-owned mode ladders (future; see platform plugin work).
- Repo-committed shared path grants for teams.
- Write grants from `@` (read-only only).

## Test plan (acceptance)

- Settings load with legacy `tiers` does not crash; resolution ignores tiers.
- No `/fast` `/standard` `/clever` in slash menu; `task` schema has no `tier`.
- HITL: outside content still asks; secret dump still asks.
- Auto: outside content and shell mutation do not prompt.
- `@../fixture.txt` and `@../fixture-dir/` grant and auto-allow subsequent reads
  under HITL; no file written under the repo root for grants.
- Secret `@.env` remains blocked and does not create a grant.
