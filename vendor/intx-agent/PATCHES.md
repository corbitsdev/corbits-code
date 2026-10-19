# Patch ledger — vendor/intx-agent

**The SHA-diff is authoritative; markers are navigation.**

Recorded upstream commit lives in `docs/VENDORING.md`. A pristine checkout
at that SHA, diffed against `vendor/intx-agent/src`, is the only proof of
which lines are ours — run `bin/vendor-patch-diff` to produce it. The
`Locally patched — see …#<anchor>` comments and the entries below are
signposts that point into that diff; they do not define its extent.

### 2026-09-14 re-sync (upstream `1ad0104`)

All three entries re-carried as-is; upstream has no `loadErrors`
(`store.ts` grep is clean) and no error-seq resumption in `createAgent`.
No adaptation needed — upstream did not touch these regions. Upstream's
`credentialId` auth-model rewrite does not intersect these patches.

### 2026-10-14 re-sync (upstream `5453d0b0` — npm `0.4.0`, CL-10651)

All three entries re-carried unchanged: upstream did not touch
`agent.ts` or `testing/audit-noop.ts` in this range, and `loadErrors` is
still absent upstream. Upstream moved `waitForReactorDone` out of three
test files into the new `testing/reactor-waiters.ts` (exported from
`testing/index.ts`); `flush-errors.test.ts` and
`audit-integration.test.ts` were three-way merged so the local
`loadErrors` hooks and the FORBIDDEN_DEPS credential-failure companion
suite re-carried onto the new shapes.

### 2026-10-14 re-sync to `4cc6972` (CL-10656, HEAD drift 0.4.0 → base)

All three entries re-carried; none dropped (`loadErrors` and error-seq
resumption still absent upstream in this range). Upstream touched
`agent.ts` (`d1835b` per-send `deliver` options adopted upstream, `660ef8`
signature reflow); `agent.ts` three-way merged cleanly with zero
adaptation — no upstream change intersects the two patch sites. New
upstream files `authoring.ts` (authoring-only subpath barrel) and the
`canonicalize.ts` helpers carried verbatim, with the `./authoring` and
`./canonicalize` subpath exports wired into the vendored `package.json`
(the inert `vendor/intx-workflow-host/workflow-definition-loader.ts` copy
imports `./authoring` at its new pin). Upstream also deleted no vendored
files and changed `testing/` not at all.

### 2026-10-19 re-sync to `aa7b78ee` (npm `0.5.0`, CL-10918)

`git diff --name-only 4cc6972 aa7b78ee -- packages/agent` lists only
`package.json`, whose single changed line is upstream's own `version` field —
a field this repo deliberately does not mirror (the `0.2.2` placeholder, per
`docs/VENDORING.md`). The tree is therefore unchanged by this release, and
`bin/vendor-patch-diff` prints the same shape as the pre-sync tree — 4 files,
382 +, 2 −: nothing absorbed, nothing lost.

- **`agent-ts-resume-error-seq` — KEEP.** `aa7b78ee` still never reads the
  durable error sequence back when building an agent, so a rebuilt agent would
  still restart `errorSeq` at 0.
- **`agent-ts-duplicate-error-flush` — KEEP.** Upstream `flushErrors` still
  treats `Duplicate error record:` as a flush failure.
- **`testing-audit-noop-ts-load-errors` — KEEP.** Follows the `AuditStore`
  contract patch in `vendor/intx-types`; that contract is still local.

## agent-ts-resume-error-seq

`agent.ts` — `createAgent` resumes `errorSeq` from `auditStore.loadErrors`
so a rebuilt agent does not reuse seq 0 and collide with files the
previous assembly already committed. If `loadErrors` throws, assembly
still succeeds and seq starts at 0; a later colliding flush is dropped
by `agent-ts-duplicate-error-flush` rather than failing the session.

**Disposition:** Promotion candidate. **Removal path:** Upstream PR to
`createAgent` that resumes the durable error sequence; then drop this
entry and its marker.

## agent-ts-duplicate-error-flush

`agent.ts` — `flushErrors` treats `Duplicate error record:` from
`commitErrors` as already-durable instead of failing `afterCheckpoint`.
Only the record named by the colliding `<sessionId>/<seq>-<category>`
key is dropped; the rest of the batch is retried in the same flush, so
a stale-seq assembly flushing `[seq0/dup, seq1/fresh]` still persists
the fresh record. An unparseable key falls back to dropping the batch.
Identical-bytes exact retries still commit normally upstream.

**Disposition:** Promotion candidate. **Removal path:** Upstream PR with
the same duplicate-flush handling; then drop this entry and its marker.

## testing-audit-noop-ts-load-errors

`testing/audit-noop.ts` — No-op `AuditStore` implements `loadErrors` as
an empty array so it satisfies the patched `AuditStore` contract.

**Disposition:** Companion of `runtime-ts-audit-store-load-errors`.
**Removal path:** Ships out with the types patch.
