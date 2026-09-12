# Patch ledger — vendor/intx-types

**The SHA-diff is authoritative; markers are navigation.**

Recorded upstream commit lives in `docs/VENDORING.md`. A pristine checkout
at that SHA, diffed against `vendor/intx-types/src`, is the only proof of
which lines are ours — run `bin/vendor-patch-diff` to produce it. The
`Locally patched — see …#<anchor>` comments and the entries below are
signposts that point into that diff; they do not define its extent.

## runtime-ts-audit-store-load-errors

`runtime.ts` — `AuditStore` grows `loadErrors(sessionId, signal?)` so a
rebuilt agent can resume the durable error sequence instead of reusing
seq 0. Companion to `store-ts-load-errors` in `@intx/storage-isogit` and
`agent-ts-resume-error-seq` in `@intx/agent`.

**Disposition:** Promotion candidate. **Removal path:** Upstream PR adding
`loadErrors` to `AuditStore`; then drop this entry and its marker.
