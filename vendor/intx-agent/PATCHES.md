# Patch ledger — vendor/intx-agent

**The SHA-diff is authoritative; markers are navigation.**

Recorded upstream commit lives in `docs/VENDORING.md`. A pristine checkout
at that SHA, diffed against `vendor/intx-agent/src`, is the only proof of
which lines are ours — run `bin/vendor-patch-diff` to produce it. The
`Locally patched — see …#<anchor>` comments and the entries below are
signposts that point into that diff; they do not define its extent.

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
