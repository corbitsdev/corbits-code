# Vendored Interchange packages

Corbits Code consumes most of Interchange as published `@intx/*` npm
packages. A few packages are instead vendored as source, directly from the
upstream Interchange repository, under `vendor/`. This document is the
authoritative record of what is vendored, from which upstream commit, and
whether it carries local patches.

## Why vendor instead of install

The npm registry lags Interchange's own `main` branch, sometimes by weeks.
When a fix or a new primitive on `main` is needed before the next npm
release, the alternative to waiting is vendoring: copying the package's
source directly into this repo as a Bun workspace member, so it resolves at
whatever upstream commit it was last synced to instead of the last
published version.

Vendored packages are TypeScript source with no build step — Bun loads
`.ts` files natively, so a vendored package's `package.json` `exports` map
points straight at `./src/*.ts` files rather than a `dist/` build.

## What's vendored

| Package                | Vendor path                   | License       | Synced from upstream commit                | Retrieved  | Local patches                                |
| ---------------------- | ----------------------------- | ------------- | ------------------------------------------ | ---------- | -------------------------------------------- |
| `@intx/inference`      | `vendor/intx-inference/`      | LGPL-2.1-only | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | 2026-09-07 | Yes — see `vendor/intx-inference/PATCHES.md` |
| `@intx/types`          | `vendor/intx-types/`          | LGPL-2.1-only | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | 2026-09-07 | None — verbatim                              |
| `@intx/storage-isogit` | `vendor/intx-storage-isogit/` | LGPL-2.1-only | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | 2026-09-07 | None — verbatim                              |
| `@intx/agent`          | `vendor/intx-agent/`          | LGPL-2.1-only | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | 2026-09-07 | None — verbatim                              |
| `@intx/authz`          | `vendor/intx-authz/`          | LGPL-2.1-only | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | 2026-09-07 | None — verbatim                              |
| `@intx/log`            | `vendor/intx-log/`            | LGPL-2.1-only | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | 2026-09-07 | None — verbatim                              |
| `@intx/tools-posix`    | `vendor/intx-tools-posix/`    | LGPL-2.1-only | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | 2026-09-07 | None — verbatim                              |
| `@intx/mailbox`        | `vendor/intx-mailbox/`        | LGPL-2.1-only | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | 2026-09-07 | None — verbatim                              |
| `@intx/harness`        | `vendor/intx-harness/`        | LGPL-2.1-only | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | 2026-09-07 | None — verbatim                              |
| `@intx/mime`           | `vendor/intx-mime/`           | LGPL-2.1-only | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | 2026-09-07 | None — verbatim                              |

## Provenance, ownership, and kill dates

Every vendored path with its upstream source, why the published npm package
did not cover the need, its owner, and its kill date. A kill date is a
proposal the operator ratifies on review; each ties an observable condition
to a hard backstop date (2027-03-07, six months after this sync). When the
condition is met the vendored tree is dropped in favour of the published
package; the date is the deadline even if it is not.

| Vendor path                           | Upstream repo           | Upstream commit                            | Patched            | Why not the published package                                                                                                                                   | Owner   | Proposed kill date                                                                         |
| ------------------------------------- | ----------------------- | ------------------------------------------ | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ------------------------------------------------------------------------------------------ |
| `vendor/intx-inference/`              | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | Yes — `PATCHES.md` | Local fixes not yet upstream                                                                                                                                    | runtime | 2027-03-07 or when patches land upstream and publish                                       |
| `vendor/intx-types/`                  | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | No                 | Cross-package coupling with `@intx/inference`                                                                                                                   | runtime | 2027-03-07 or when the coupled trio publishes past `0.3.0`                                 |
| `vendor/intx-storage-isogit/`         | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | No                 | Cross-package coupling with `@intx/inference`                                                                                                                   | runtime | 2027-03-07 or when the coupled trio publishes past `0.3.0`                                 |
| `vendor/intx-agent/`                  | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | No                 | Vendored at Interchange head ahead of npm                                                                                                                       | runtime | 2027-03-07 or when `@intx/agent@>=0.4.0` publishes                                         |
| `vendor/intx-authz/`                  | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | No                 | Vendored at Interchange head ahead of npm                                                                                                                       | runtime | 2027-03-07 or when `@intx/authz@>=0.4.0` publishes                                         |
| `vendor/intx-log/`                    | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | No                 | Vendored at Interchange head ahead of npm                                                                                                                       | runtime | 2027-03-07 or when `@intx/log@>=0.4.0` publishes                                           |
| `vendor/intx-tools-posix/`            | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | No                 | Vendored at Interchange head ahead of npm                                                                                                                       | runtime | 2027-03-07 or when `@intx/tools-posix@>=0.4.0` publishes                                   |
| `vendor/intx-mailbox/`                | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | No                 | Never published to npm (verified 2026-09-07: registry 404 for all versions)                                                                                     | step-1  | 2027-03-07 or when any `@intx/mailbox` version publishes to npm                            |
| `vendor/intx-harness/`                | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | No                 | `driveConnectorReplies`/`AgentEventStream` (`src/reply-drain.ts`) is past npm `0.3.0` (verified 2026-09-07: absent from the published tarball)                  | step-1  | 2027-03-07 or when a published `@intx/harness` exports `driveConnectorReplies`             |
| `vendor/intx-mime/`                   | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | No                 | `buildMessageHeaders` is past npm `0.3.0` (verified 2026-09-07: absent from the published tarball); `@intx/mailbox` re-exports it                               | step-1  | 2027-03-07 or when a published `@intx/mime` exports `buildMessageHeaders`                  |
| `vendor/intx-workflow-host/adapters/` | `faremeter/interchange` | `0205b07b64d03f0fec2e4be3593c764070a9ba8a` | No                 | App-internal: `substrate-mailbox-store.ts` has never been published in any `@intx/workflow-host` release (verified 2026-09-07: absent from the `0.3.0` tarball) | step-1  | 2027-03-07 or when a published `@intx/workflow-host` exports `createSubstrateMailboxStore` |

### The 2026-09-07 step-1 vendor pass

Three needs from the ticket were verified against npm and found already
covered by published packages, so they are **dependencies, not vendored
trees**:

- `@intx/hub-sessions` `./substrate` — `createAgentRepoStore({ dataDir,
signingKey })` (local disk + keypair, no hub, no database) is present in
  the published `0.3.0` tarball. Root `dependencies` pins `0.3.0`.
- `@intx/mail-memory` — `InMemoryTransport`/`createInMemoryTransport` are
  present in the published `0.3.0`. Root `dependencies` pins `0.3.0`.
- the `@intx/workflow onEvent` seam — the `opts.onEvent` sink on
  `createWorkflowStepInvoker` lives in `@intx/workflow-host`'s
  `adapters/step-invoker.ts`, and the published `@intx/workflow-host@0.3.0`
  tarball already carries it (its `subscribeAgentEvents(agent,
opts.onEvent)` wiring). Root `dependencies` pins `0.3.0`.

Everything vendored in this pass sits at the same upstream commit
`0205b07b64d03f0fec2e4be3593c764070a9ba8a` as the existing trees; no
vendored tree mixes pins.

`vendor/intx-workflow-host/adapters/` is a partial-package vendor: upstream
`packages/workflow-host` has a `package.json`, but this tree carries only
the never-published `substrate-mailbox-store` adapter (source + its test,
563 lines, documented on-disk layout, O(delta) flushes). It is
deliberately **not** a workspace member and nothing in `src/` imports it —
Step 1 decides whether to wire it as a package when it consumes it. Its
`@intx/hub-sessions/substrate` and `@intx/mailbox` imports resolve once
that wiring exists; until then it is inert provenance, not dead weight.

The 2026-09-07 sync moved all three packages together to a single
upstream commit, restoring the single-commit coherence the coupling rule
below assumes. An interim 2026-08-22 sync had moved only `@intx/types`
and `@intx/storage-isogit`; the gap did not regress the coupling — the
`PendingOperation` shape was byte-identical across it — but it was a
staged exception, not the steady state.

The license column records what each package declares in its own
`package.json`; the corresponding `LICENSE` file travels with every vendored
tree and is never edited during a sync. Corbits Code is distributed under
GPLv2, which LGPL-2.1 permits. Retrieval dates are when the copy landed here,
not when the upstream commit was authored — an audit needs both, and the
upstream commit hash supplies the other half.

All three were synced together in one pass because they are not
independently upgradable: the reactor's approval-suspend primitive (upstream
commit `06d39dc6`, "Suspend the reactor on an ask authz decision") spans all
three packages in a single upstream change — `@intx/inference`'s
`authz-extension.ts` and `reactor.ts` return and dispatch a `PendingOperation`
type that lives in `@intx/types`'s `runtime.ts`, and `@intx/storage-isogit`'s
`store.ts` persists it. Vendoring `@intx/inference` at a newer commit than
`@intx/types` (or vice versa) does not typecheck by construction, since the
inference package's exported function signatures reference types that only
exist in the newer `@intx/types`.

The 2026-09-07 sync also vendored the remaining four consumed packages
(`@intx/agent`, `@intx/authz`, `@intx/log`, `@intx/tools-posix`) at the
same upstream commit, completing the set: every `@intx/*` package this
repo imports now resolves to vendored source. None of the four carried
local patches at vendoring time; their trees are verbatim upstream
copies. `@intx/tools-lsp` remains on published npm (`0.3.0`) — it is a
thin adapter whose transitive `@intx/*` dependencies resolve to the
vendored workspaces via root `overrides`, so it tracks the vendored set
without being vendored itself. Published transitive dependencies that
stay on npm (`@intx/crypto`, `@intx/inference-discovery`,
`@intx/inference-testing`) are pinned to the root's published versions so
the lockfile never nests duplicate copies of them either.

A `version` field of `"0.2.2"` in a vendored package's `package.json` is a
carried-over convention from the original `@intx/inference` vendoring, not a
claim about what's actually checked out — the vendored source can be (and
generally is) well ahead of that version number. The commit hash in the
table above is the only thing that reflects actual content; the `version`
field exists only because some tooling expects `package.json` to declare
one.

## How a vendored package resolves

Root `package.json`:

- `workspaces` lists each `vendor/intx-*` directory as a workspace member.
- `overrides` pins the package name to `workspace:*`, so every transitive
  consumer (including other published `@intx/*` packages that declare a
  dependency on it) resolves to the vendored copy instead of installing
  their own nested copy from npm.
- The package's own entry in root `dependencies` reads `"workspace:*"`
  rather than a version string.

A clean `bun install` under those overrides links every consumer —
including nested Bun package layouts such as
`node_modules/.bun/@intx+agent@…/node_modules/@intx/types` — at the
vendored tree. That is the runtime and install-time story.

TypeScript needs a second pin. Published packages such as `@intx/tools-lsp`
ship `dist/*.d.ts` that import `@intx/types/runtime`. When a stale or
partial install leaves a nested published `@intx/types@0.3.0` (with its
older `dist/` shapes, missing fields such as `PendingOperation.kind`),
`tsc` treats that nested copy as a second type identity: first-party
code and vendored inference resolve the vendor source, while agent
declaration files resolve the nested publish, and assignability fails
even though both packages share the name `@intx/types`. Root
`tsconfig.json` therefore forces a single TypeScript-visible identity:

```json
"paths": {
  "@intx/types": ["./vendor/intx-types/src/index.ts"],
  "@intx/types/*": ["./vendor/intx-types/src/*"]
}
```

Overrides keep the filesystem install on vendor; paths keep `tsc` on
vendor even if a nested published copy reappears. Do not remove either
layer without re-checking `bun run typecheck` against a layout that
still has nested `@intx/types` under a published `@intx/*` package.

This is also what collapses a duplicate-dependency problem: before
`@intx/types` was vendored, every published `@intx/*` package we consumed
carried its own nested `arktype` install (pinned to whatever `arktype` minor
version was current when that package was last published on npm), distinct
from the root's own `arktype` — so an `instanceof` check against a type
constructed by one `arktype` instance silently failed against the other.
Vendoring `@intx/types` (and anything that itself vendors `@intx/types` as
`workspace:*`) removes the nested install; every import of `arktype` under
those packages now resolves to the single root instance. As of this sync,
`bun.lock` shows exactly one `arktype` resolution across the whole tree.

## Patched vs. verbatim

`@intx/types` and `@intx/storage-isogit` are verbatim copies of upstream —
no modifications. A diff against any later upstream checkout at the same
paths will show 100% upstream-authored lines.

## Notable upstream shape changes carried by the 2026-08-22 sync

Upstream commit `5f798bea` ("Inject the runtime into iso-git storage")
split `@intx/storage-isogit`'s entry point: the package root (`.`) no
longer exports a bindable `createIsogitStore` free function, and callers
now pick a runtime-bound entry point instead — `./node` (backed by
`createNodeIsogitRuntime`) or `./browser`. `vendor/intx-storage-isogit/`'s
`package.json` `exports` map picks up both new subpaths verbatim from
upstream. The one first-party consumer,
`src/session/optimized-context-store.ts`, now imports `createIsogitStore`
from `@intx/storage-isogit/node` instead of the package root — the
`./node` re-export has the identical `(dir, signer?, gcPolicy?)` signature
the old root export had, so this is an import-path change, not a
behavioral one. The package also picked up two new dependencies
(`@isomorphic-git/lightning-fs`, `buffer`, both used only by the new
`./browser` runtime, which nothing here imports) and a new
`@intx/crypto` dev dependency for its own test suite, pinned to `0.3.0` —
the same "stay on published npm for a package we don't vendor" pattern as
the `@intx/log` dependency on the other vendored packages, kept aligned
with the root's published `0.3.0` pin so the lockfile never nests duplicate
copies; `@intx/mime` joined the vendored set in the 2026-09-07 step-1 pass,
and its consumers now resolve it through the root `workspace:*` override.

One new upstream test, `browser-bundle.test.ts`, is excluded via
`bunfig.toml`'s `pathIgnorePatterns`. It bundles `browser.ts` with
`Bun.build` under the `intx-src` export condition, which resolves
`@intx/log` and `@intx/mime` to `./src/*.ts`. Both are vendored source as
of the 2026-09-07 syncs (`@intx/mime` in the step-1 pass, which vendored
it for `buildMessageHeaders`), so the condition has a `src/` target again;
the exclusion remains because a local re-run of the bundle fails for a
different reason — the vendored mime sources import `@intx/crypto`, which
stays on published npm, and `Bun.build` cannot resolve that bare specifier
from inside the vendor workspace.

`@intx/inference` carries local patches — real fixes not yet present
upstream, not workarounds for something upstream has since fixed. Every
patched location carries a one-line comment naming its site-specific entry
in `vendor/intx-inference/PATCHES.md` (e.g. `#reactor-ts-correlating-ids-leak`),
so `grep -rn "Locally patched" vendor/intx-inference/src` finds every
divergence. **Markers are navigation; the SHA-diff is proof.** Run
`bin/vendor-patch-diff` against a pristine upstream checkout at the
recorded SHA to print exactly the lines that are ours. A correspondence
test (`tests/unit/vendor-patch-ledger.test.ts`) fails if a marker anchor
does not resolve to a ledger heading, or if a ledger heading has no marker.

## Re-syncing a vendored package to a newer upstream commit

1. In the read-only upstream clone, confirm the commit to sync to and note
   its hash for this document's table.
2. For a **verbatim** package (`@intx/types`, `@intx/storage-isogit`):
   copy `src/`, `README.md` over the vendored directory's `src/`,
   `README.md` (leave `package.json` and `LICENSE` as they are unless the
   package's own `package.json` exports or dependencies changed upstream —
   diff the two `package.json` files by hand). Run `bun install`,
   `bun run typecheck`, `bun run build`, `bun run test`.
3. For a **patched** package (`@intx/inference`): before overwriting
   anything, run `bin/vendor-patch-diff` (optionally
   `--upstream /path/to/interchange`) to re-derive the exact local
   divergences against the recorded SHA — do not trust `PATCHES.md`'s
   prose alone. Then overwrite `src/` with the new upstream commit's
   source, and re-apply each patch from the ledger by hand against the
   new file shapes. For each patch, confirm from the new upstream source
   whether it: (a) still applies as-is, (b) needs adapting to a changed
   surrounding shape, or (c) has been subsumed by an equivalent upstream
   fix and can be dropped — verify (c) by reading the new upstream code,
   never by assumption. Update `PATCHES.md` and the site-specific
   `Locally patched` markers to reflect what actually landed, including
   any patches dropped as superseded and why. Run the full gate
   (`typecheck`/`build`/`test`, including
   `tests/unit/vendor-patch-ledger.test.ts`) and do not consider the sync
   complete until it passes clean.
4. Because `@intx/inference`, `@intx/types`, and `@intx/storage-isogit` are
   coupled (see above), a re-sync that moves any one of their commit hashes
   should move all three together, even if only one had code changes worth
   vendoring — otherwise the trio drifts out of the single-commit coherence
   this document assumes.
5. Update this document's table with the new commit hash and retrieval date.
6. Land the sync as **two commits, in this order**: first the pristine
   upstream copy with no local changes, then the re-applied patches. The
   point is that the unmodified upstream state becomes a checkout rather
   than a reconstruction — an auditor diffs one commit against the upstream
   clone and is done, instead of subtracting a prose ledger from a merged
   tree. It also makes the next upgrade cheaper, because the patch commit is
   exactly the thing to replay. The 2026-08-08 sync landed as two
   commits split by package rather than by pristine-then-patched, so neither
   isolates an unmodified upstream tree; `PATCHES.md` is what makes that state
   reconstructible, which is why that ledger is load-bearing rather than
   merely descriptive.
