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

## types-ts-usage-stop-reason

`src/runtime.ts` — The `inference.usage` variant of `InferenceEvent`
gains optional `data.stopReason: string`, populated by adapters that
observe a wire-level stop/finish reason (Anthropic `stop_reason`).
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
