# Vendored packages

Corbits Code consumes Interchange as published `@intx/*` npm packages pinned at
0.2.2, with one exception: `@intx/inference` is vendored into
`vendor/intx-inference`. The root `package.json` lists the vendored directory
as a workspace and pins the name via `overrides`, so every consumer — including
the published `@intx/agent`'s transitive dependency — resolves to the local
copy. We never modify or push to the upstream interchange repository; every
local change to interchange code lands in `vendor/` through this repo's normal
review flow.

## Why vendor

- Carry corbits-local patches that published `@intx/inference` does not have.
- Let performance and correctness work on the shared runtime land through this
  repo's normal review flow. Upstreaming is not an option: nothing from this
  repo goes to `faremeter/interchange`.

## Currently vendored

| Package | Vendored path | Baseline |
|---|---|---|
| `@intx/inference` | `vendor/intx-inference` | upstream `v0.2.2` tag source |

## How resolution works

1. The vendored package keeps its original `name: "@intx/inference"` and its
   `exports` pointing at `src` (Bun runs TypeScript natively).
2. Root `package.json` lists `./vendor/intx-inference` in `workspaces` and pins
   `"@intx/inference": "workspace:*"` in `overrides`, so both direct imports
   and the published packages' transitive dependency bind to the vendored copy.
3. `bun install` links it like any other workspace package. Verify with
   `readlink node_modules/@intx/inference`.

## Local patches (`vendor/intx-inference`)

The vendored inference runtime is upstream 0.2.2 source plus the audited
keeper patches (Linear CL-4352 records the audit; git history for
`vendor/intx-inference/**` is the authoritative list). At a high level:

- Commitment-boundary streaming: committed output is delivered incrementally
  rather than as a terminal burst, and retry buffering is memory-linear.
- Streaming inactivity timeout measures silence since the last semantic SSE
  event the adapter parsed, not since the last raw chunk.
- `isStreamTerminal` adapter hook so protocols that signal completion with a
  semantic event (OpenAI Responses) do not hang the read loop.
- Abort-origin propagation through `classifyAbortError`.
- Reactor fixes: correlation-id leak, deliver() rejection surfacing,
  tool-batch checkpointing with `addToHistory`, turns-revision skip-rewrite,
  committed-retry `inference.retry` markers.
- `ephemeralTurns` prompt-tail injection (`ExtendedInferenceOptions`) and
  context transforms riding `Dependencies.contextTransforms` — the two
  surfaces the published packages do not carry.
- SSE unterminated-line cap; state-manager deep-freeze and lazy snapshots.

## Keeping in sync with upstream

When adopting a newer published `@intx/inference`:

1. Fetch the new upstream source for comparison (e.g. `npm pack
   @intx/inference@<version>` or the upstream tag) — read-only; never a clone
   you push from.
2. Diff it against `vendor/intx-inference/src`; expect only the keeper patches
   above. Drop any patch the new version has absorbed.
3. Replay the remaining patches onto the new base, one commit per concern.
4. Bump the vendored `package.json` `version` and this file's baseline row.
5. Run `bun run typecheck`, `bun run build`, and `bun test` from repo root.
6. Update the `@intx/*` pins in root and vendored `package.json` together.

## Licensing

Keep the package's `"license": "LGPL-2.1-only"` field and its `LICENSE` file.
Vendored interchange code stays LGPL-2.1-only; the repo's GPLv2 license and AI
exception do not apply to it.
