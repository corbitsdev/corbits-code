# Patch ledger — vendor/intx-types

**The SHA-diff is authoritative; markers are navigation.**

Recorded upstream commit lives in `docs/VENDORING.md`. A pristine checkout
at that SHA, diffed against `vendor/intx-types/src`, is the only proof of
which lines are ours — run `bin/vendor-patch-diff` to produce it. The
`Locally patched — see …#<anchor>` comments and the entries below are
signposts that point into that diff; they do not define its extent.

### 2026-09-14 re-sync (upstream `1ad0104`)

Both entries re-carried; the `stopReason` spread sites in the Anthropic
and Gemini adapters were rewritten to match upstream's new object-literal
usage emission. Upstream deleted `packages/types/src/sidecar-placement.ts`;
no entry lived there. Unaffected by upstream's `credentialId` auth-model
rewrite.

### 2026-10-14 re-sync (upstream `5453d0b0` — npm `0.4.0`, CL-10651)

All three entries re-carried; upstream did not touch `runtime.ts` or
`mediated-credential.ts` in this range, so both entries re-applied
byte-identically with zero adaptation (`stopReason` chain verified at
`runtime.ts:1449/1715`, auth-recovery context at
`mediated-credential.ts:27`). Upstream did change `base64.ts`
(chunked encoding), `grants.ts` (new `ApprovalItem` type),
`sidecar.ts`/`sidecar.test.ts` (`approvedGrants` widened to
`ApprovalItem[]`) — all carried verbatim — and added the new
`src/testing/` subpackage (`waitUntil`), which the vendored
`package.json` now exposes via the upstream `./testing` subpath export.

## runtime-ts-auth-recovery-context

`mediated-credential.ts` and `runtime.ts` — credential material can atomically
carry provider identity headers with its bearer secret. Retry situations carry
the immutable call-start source plus per-call credential-failure ordinal and
history; retry policies may expose an error normalizer, and abort decisions may
replace the surfaced classified error.

**Disposition:** Promotion candidate. **Removal path:** upstream equivalent
credential rotation and retry-context contracts, then drop this entry.

## runtime-ts-audit-store-load-errors

`runtime.ts` — `AuditStore` grows `loadErrors(sessionId, signal?)` so a
rebuilt agent can resume the durable error sequence instead of reusing
seq 0. Companion to `store-ts-load-errors` in `@intx/storage-isogit` and
`agent-ts-resume-error-seq` in `@intx/agent`.

**Disposition:** Promotion candidate. **Removal path:** Upstream PR adding
`loadErrors` to `AuditStore`; then drop this entry and its marker.

## types-ts-usage-stop-reason

`src/runtime.ts` — The `inference.usage` variant of `InferenceEvent`
gains optional `data.stopReason: string`, populated by adapters that
observe a wire-level stop/finish reason (Anthropic `stop_reason`, Gemini
`finishReason`).
`inference.usage` is the only harness-level signal that records how a
turn ended; without the provider's stop reason the harness cannot
distinguish a complete turn from a truncation (`max_tokens` with a tool
call still open), which is the CL-7783 failure: truncated `tool_use`
input was dispatched as a well-formed call. Absent when the provider
surfaces none; consumers must treat a missing `stopReason` as "unknown",
never as "complete".

**Disposition:** Promotion candidate (companion to the `intx-inference`
CL-7783 entry `inference-ts-cl-7783-truncated-tool-call` — ships out or
dies with it). Requires upstream to add a stop-reason field to the
usage event (or equivalent). **Removal path:** Upstream PR to
`@intx/types` carrying the field; drop the marker and this entry once
the re-sync pin includes it.
