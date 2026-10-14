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

## store-ts-load-errors

`store.ts` — Implements `AuditStore.loadErrors` by reading
`state/errors/<sessionId>/*.json`, validating each file as `ErrorRecord`,
and returning records ordered by seq. Missing session directories return
`[]`. Companion to `runtime-ts-audit-store-load-errors` in `@intx/types`.

**Disposition:** Promotion candidate. **Removal path:** Upstream PR adding
the same loader; then drop this entry and its marker.
