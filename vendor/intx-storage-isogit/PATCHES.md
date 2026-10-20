# Patch ledger — vendor/intx-storage-isogit

**The SHA-diff is authoritative; markers are navigation.**

Recorded upstream commit lives in `docs/VENDORING.md`. A pristine checkout
at that SHA, diffed against `vendor/intx-storage-isogit/src`, is the only
proof of which lines are ours — run `bin/vendor-patch-diff` to produce it.
The `Locally patched — see …#<anchor>` comments and the entries below are
signposts that point into that diff; they do not define its extent.

### 2026-09-14 re-sync (upstream `1ad0104`)

Re-carried as-is with its three tests; upstream `store.ts` has no
`loadErrors`. No adaptation needed.

### 2026-10-14 re-sync (upstream `5453d0b0` — npm `0.4.0`, CL-10651)

Re-carried as-is: upstream did not touch `src/store.ts` or
`src/store.test.ts` in this range (`loadErrors` still absent upstream),
so both files and the entry are byte-identical to the prior pin.

### 2026-10-14 re-sync to `4cc6972` (CL-10656, HEAD drift 0.4.0 → base)

Re-carried: upstream touched `store.ts` in this range for the first time
since vendoring (nine commits in `packages/storage-isogit`, net +15/−16);
the `store-ts-load-errors` entry three-way merged cleanly (`git
merge-file`) with zero adaptation, and `loadErrors` is still absent
upstream at `4cc6972`. Upstream `e75eee2` ("Remove sync.request and the
undeploy's agent-state push") dropped `createStatePack`'s only remaining
hub-side consumer and the two comment blocks in `pack-send.ts` /
`repo-lock.ts` that described the state-pack flow (`createDeployPack`
itself keeps its export); the vendored-side safety of that removal is
recorded in docs/VENDORING.md. The tree now types off the same
`4cc6972` pin as the coupled `@intx/types`/`@intx/inference` trio.

### 2026-10-19 re-sync to `aa7b78ee` (npm `0.5.0`, CL-10918)

`git diff --name-only 4cc6972 aa7b78ee -- packages/storage-isogit` is the real
drift of this release: `README.md`, `package.json`, `commit-helpers.ts`, new
`commit-helpers.test.ts`, `node.ts`, new `node-durability.ts`, `runtime.ts`,
`runtime.test.ts`, `store.ts`, `store.test.ts`. Upstream's conversation
checkpoints now stage the context files and the tool-output directory in one
index update, and the new `node-durability.ts` carries the fsync boundary that
commit publication relies on; the whole set was adopted verbatim, and the
`README.md` gained the matching tool-output paragraph.

Adoption touched `store.ts`, the one file this ledger patches, so that file
was three-way merged (ours / base `4cc6972` / theirs `aa7b78ee`) rather than
copied. The merge is verified by the post-sync divergence shape:
`bin/vendor-patch-diff intx-storage-isogit` prints the same shape as the pre-sync tree: 2 files, 73 +, 1 −
as the pre-sync tree, i.e. the only remaining difference from upstream is the
ledgered content below.

- **`store-ts-load-errors` — KEEP.** `git grep -c loadErrors aa7b78ee --
  packages/storage-isogit` returns no hits, so upstream still does not read
  back the durable error sequence, and `vendor/intx-types` still declares
  `AuditStore.loadErrors` (see that package's ledger). The coupled trio moves
  together per `docs/VENDORING.md`.
- `package.json`: published-npm `@intx/log` dependency, `@intx/mime`
  dependency and `@intx/crypto` devDependency move `0.3.0` → `0.5.0`, kept
  aligned with the root pins so the lockfile nests no second copy.

## store-ts-load-errors

`store.ts` — Implements `AuditStore.loadErrors` by reading
`state/errors/<sessionId>/*.json`, validating each file as `ErrorRecord`,
and returning records ordered by seq. Missing session directories return
`[]`. Companion to `runtime-ts-audit-store-load-errors` in `@intx/types`.

**Disposition:** Promotion candidate. **Removal path:** Upstream PR adding
the same loader; then drop this entry and its marker.
