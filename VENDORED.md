# Vendored packages

Intercode vendors a small number of `@intx/*` packages from the `interchange`
submodule into `vendor/` instead of consuming them directly from
`interchange/packages/`. The root `package.json` `workspaces` list points at the
vendored copy, and Bun resolves `@intx/<name>` by package name, so every
consumer transparently uses the local copy.

## Why vendor

- Carry intercode-local patches that are not yet upstream in
  `faremeter/interchange`, without opening pull requests against that submodule.
- Let performance and correctness work on the shared runtime land through this
  repo's normal review flow rather than a cross-repo submodule change.

## Currently vendored

| Package | Vendored path | Copied from |
|---|---|---|
| `@intx/inference` | `vendor/intx-inference` | `interchange/packages/inference` at submodule commit `69c75847` |

## How resolution works

1. The vendored package keeps its original `name: "@intx/<name>"` and its
   `exports` pointing at `src`.
2. Root `package.json` `workspaces` lists `./vendor/intx-<name>` and does **not**
   list `./interchange/packages/<name>`. Because Bun resolves workspace packages
   by name, `@intx/<name>` binds to the vendored copy everywhere.
3. `bun install` links it like any other workspace package.

## Adding a new vendored package

1. `cp -R interchange/packages/<name> vendor/intx-<name>` and delete the copy's
   `node_modules`.
2. In root `package.json` `workspaces`, replace `./interchange/packages/<name>`
   with `./vendor/intx-<name>`.
3. `bun install`.
4. Add a row to the table above recording the submodule commit it was copied
   from.

Do not vendor a package unless a change actually needs to land locally — an
unmodified vendored copy only adds drift. If a planned change turns out not to
require local edits, revert the vendoring and consume the submodule package
directly.

## Local patches (`vendor/intx-inference`)

The vendored inference runtime carries intercode-local changes on top of the
`69c75847` baseline. See the git history for `vendor/intx-inference/**` for the
authoritative list; at a high level:

- Reactor snapshots share deep-frozen turn references instead of
  `structuredClone`-ing the full conversation on every director decision, and
  unchanged history is not re-persisted per checkpoint.
- Retry-safe inference buffering is memory-linear (compact pre-commit buffering
  instead of a full partial-response snapshot per token), and committed output
  is delivered incrementally rather than as a terminal burst.
- Streaming inactivity timeout measures silence since the last semantic SSE
  event the adapter parsed, not since the last raw chunk (CL-3477).
- The reactor checkpoints after each tool batch with `addToHistory` so an
  interrupt rebuild reloads assistant tool_call turns and results (CL-3478).

## Keeping in sync with upstream

A vendored copy drifts from `interchange` over time. When adopting a newer
`interchange` commit, re-apply the local patches on top of the updated package
(cherry-pick the `vendor/intx-inference/**` patch commits, or re-copy and replay
them), then update the submodule commit recorded in the table above. Treat that
commit as the baseline the current vendored copy was derived from.

### Sync checklist (CL-3331)

Before bumping the `interchange` submodule or cutting a release that touches inference:

1. Record current baseline: `git -C interchange rev-parse HEAD` and the table row above.
2. Diff vendored tree vs submodule package: `diff -ru interchange/packages/inference/src vendor/intx-inference/src` (expect intentional deltas only).
3. After re-copy or merge from upstream, replay local patch commits listed in `vendor/intx-inference` git history; do not edit submodule `interchange/packages/inference` for intercode-only fixes.
4. Run `bun run typecheck`, `bun run build`, and `bun test` from repo root.
5. Update the **Copied from** commit in the table when the vendored baseline changes.
6. Confirm no workspace entry points at `./interchange/packages/inference` in root `package.json`.