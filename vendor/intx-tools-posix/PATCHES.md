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

### 2026-10-19 re-sync to `aa7b78ee` (npm `0.5.0`, CL-10918)

`git diff --name-only 4cc6972 aa7b78ee -- packages/tools-posix` lists only
`package.json` (upstream's own `version` field, which this repo does not
mirror), so the tree is unchanged by this release and `bin/vendor-patch-diff`
prints the same shape as the pre-sync tree: 2 files, 13 +, 1 −.

- **`registry-ts-read-file-paging-description` — KEEP.** The `read_file`
  description at `aa7b78ee` still omits the page-and-continue contract that
  the coupled `size-cap-ts-paged-read-file` patch in `@intx/inference`
  depends on.

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

## plugin-ts-authorize

`plugin.ts` — Extends `ToolPlugin` with an optional `AuthorizeFn` from
`@intx/agent`, allowing installed tool plugins to participate in the standard
Interchange authorization contract. Corbits composes active plugin callbacks in
`src/plugins/tool-plugins.ts`; resolver behavior is covered by
`src/plugins/tool-plugins.test.ts`.

**Disposition:** Promotion candidate; re-carry until upstream exposes the same
optional contract. **Removal path:** drop this patch when the upstream
`ToolPlugin` includes `authorize?: AuthorizeFn`.
