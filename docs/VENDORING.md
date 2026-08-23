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
| `@intx/inference`      | `vendor/intx-inference/`      | LGPL-2.1-only | `ad0f99e7977b3ad4f28d8cc8d446ac52a4a2d685` | 2026-08-10 | Yes — see `vendor/intx-inference/PATCHES.md` |
| `@intx/types`          | `vendor/intx-types/`          | LGPL-2.1-only | `55c4431e60cc97dae2f63bfd52de56166e42b13b` | 2026-08-22 | None — verbatim                              |
| `@intx/storage-isogit` | `vendor/intx-storage-isogit/` | LGPL-2.1-only | `55c4431e60cc97dae2f63bfd52de56166e42b13b` | 2026-08-22 | None — verbatim                              |

`@intx/inference` is temporarily behind `@intx/types` and
`@intx/storage-isogit` as of the 2026-08-22 sync: this is stage 2 of a
staged re-vendor (the two lower-coupling packages first), with
`@intx/inference`'s re-sync tracked separately as stage 3. The
cross-package coupling described below did not regress in this gap — the
`PendingOperation` shape both packages already shared did not change
between `ad0f99e7` and `55c4431e` (`vendor/intx-types/src/runtime.ts` and
`src/index.ts` are byte-identical across that range), so `@intx/inference`
built against the older `@intx/types` still typechecks against the newer
one. A later re-sync of `@intx/inference` should still move all three
together per the coupling rule below, since that check only holds for
this specific gap, not in general.

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

The remaining Interchange packages this repo consumes (`@intx/authz`,
`@intx/agent`, `@intx/tools-posix`, `@intx/log`) stay on published npm
releases as of this writing. Whether any of those has the same
cross-package coupling is a question for whoever vendors them next, not
answered here.

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

TypeScript needs a second pin. Published packages such as `@intx/agent@0.2.2`
ship `dist/*.d.ts` that import `@intx/types/runtime`. When a stale or
partial install leaves a nested published `@intx/types@0.2.2` (with its
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
`@intx/crypto` dev dependency for its own test suite, pinned to `0.2.2`
like the existing `@intx/mime` dev dependency on `@intx/inference` — the
same "stay on published npm for a package we don't vendor" pattern.

One new upstream test, `browser-bundle.test.ts`, is excluded via
`bunfig.toml`'s `pathIgnorePatterns`. It bundles `browser.ts` with
`Bun.build` under the `intx-src` export condition, which resolves
`@intx/log` and `@intx/mime` to `./src/*.ts` — real files in upstream's
own monorepo, where those two are also vendored source. Here they remain
published npm installs (`dist/` only, no `src/`), so the condition
matches an export key whose target does not exist and the bundle fails
to resolve. This is an environment gap, not a defect in the vendored
code; re-check it whenever `@intx/log` or `@intx/mime` get vendored too.

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
