# Patch ledger — vendor/intx-tools-posix

**The SHA-diff is authoritative; markers are navigation.**

Recorded upstream commit lives in `docs/VENDORING.md`. A pristine checkout
at that SHA, diffed against `vendor/intx-tools-posix/src`, is the only
proof of which lines are ours — run `bin/vendor-patch-diff` to produce it.

This tree was recorded as verbatim before the 2026-10-14 re-sync, but the
`bin/vendor-patch-diff` re-derivation for that sync found one divergence
that pre-dates it (present against the prior pin `1ad0104` too) and had
never been ledgered. It is ledgered here now rather than silently
dropped, and the `docs/VENDORING.md` table records the tree as patched
from this sync onward.

## registry-ts-read-file-paging-description

`registry.ts` — The `read_file` tool description documents the
offset/limit page-and-continue contract ("Large files are returned one
page at a time … follow the `Use offset=N to continue.` footer"), matching
the behavior the vendored `@intx/inference` `size-cap-ts-paged-read-file`
patch guarantees for footer-bearing pages. Upstream's description is
silent on paging because upstream has no paged-read-file guarantee to
describe. Companion to `size-cap-ts-paged-read-file` in
`vendor/intx-inference/PATCHES.md` — ships out or dies with it.

`tools-posix.test.ts` — carries a small registry-contract test asserting
the description names `Use offset=` and paging, so the wording cannot
drift from the behavior it documents. Upstream did not touch this package
in the `5453d0b0` → `4cc6972` range (CL-10656 re-sync verified: the diff
is empty), so the entry carried byte-identically.

**Disposition:** Companion to `size-cap-ts-paged-read-file` (vendor/
intx-inference). **Removal path:** the same upstream PR that adds the
paged-read-file guarantee to `@intx/inference` would also own the
description wording; drop this entry with it.
