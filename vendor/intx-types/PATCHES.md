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

### 2026-10-14 re-sync to `4cc6972` (CL-10656)

All three entries re-carried; none dropped as upstream-absorbed (grep of the
pristine `4cc6972` `packages/types` tree: `loadErrors`, `stopReason`,
`normalizeError`, `credentialFailureOrdinal` all absent upstream). Upstream
split `runtime.ts` into `runtime-core.ts` (runtime contracts) + the new
`inference-events.ts` (event union). `runtime.ts` is those split
re-exports plus the compat re-export of `formatSafetyRatingText`
(about lines 1–11; see the entry below). The patch sites follow the split:

- `inference.usage` stopReason → both declarations in
  `inference-events.ts` (arktype mapping and the TS union) carry the
  `types-ts-usage-stop-reason` marker.
- `AuditStore.loadErrors` → `runtime-core.ts`, marker intact.
- Retry-context (`RetryDecision.error?`, `RetrySituation.source` /
  `credentialFailureOrdinal` / `credentialFailureHistory`,
  `RetryPolicy.normalizeError`) → `runtime-core.ts`; the sites moved
  unchanged from the old `runtime.ts`, and each now carries the
  `runtime-ts-auth-recovery-context` marker (previously only the
  `mediated-credential.ts` site carried one).
- `mediated-credential.ts` was untouched upstream; its entry carried
  byte-identically.

Upstream also added `adapter-manifest.ts` (adapter manifest schema),
`attachment-validation.ts`, `inbound-mail-policy.ts`,
`credential-delivery.ts`, `format-safety-rating.ts`, `repo.ts`,
`workflow-definition.ts`, `workflow-lifecycle.ts` — all carried verbatim,
with the subpath exports the adopted vendored consumers import
(`runtime-core`, `attachments`, `credential-delivery`,
`format-safety-rating`, `inference-events`) wired into the vendored
`package.json`. Resume audit (same day): the first pass wired only the
five consumer-used new subpaths and dropped fifteen upstream exports
(`base64`, `signals`, `hex`, `has-code`, `agent-address`,
`workflow-run-id`, `message-id`, `concat`, `grants`, `grant-snapshot`,
`credential-cipher`, `repo`, `inbound-mail-policy`,
`workflow-definition`, `adapter-manifest`) that upstream's export map
carries; since the vendored tree is wholesale, the vendored export map
now mirrors upstream's 33 entries verbatim (src paths instead of dist).
The vendored `@intx/inference` `package.json` likewise gained the
`./manifest` subpath it was missing.
The `sync.request` frame and the `agent.undeploy.ack`
`statePushed` field left `sidecar.ts` with upstream `e75eee2`; first-party
`src/` has zero references to either (grep evidence recorded in
docs/VENDORING.md).

### 2026-10-19 re-sync to `aa7b78ee` (npm `0.5.0`, CL-10918)

`git diff --name-only 4cc6972 aa7b78ee -- packages/types` lists `package.json`,
`sidecar.ts`, `sidecar.test.ts`, `workflow-lifecycle.ts` and `workflows.ts`;
all four source files were adopted verbatim. None of them is a file this
ledger patches, so no merge was needed, and `bin/vendor-patch-diff` prints the
same shape as the pre-sync tree: 4 files, 43 +, 6 −.

- **`vendor-types-ts-runtime-format-safety-rating-compat` — KEEP.** Upstream
  still defines `formatSafetyRatingText` in `format-safety-rating.ts` and the
  published `@corbits/openai-responses` dist this repo imports still resolves
  it off `@intx/types/runtime`; the compat re-export in the barrel is the only
  thing that keeps that seam type-identical to the vendored source.
- **`runtime-ts-auth-recovery-context` — KEEP.** `aa7b78ee` still has no
  provider-identity headers on `CredentialMaterial` and no retry-context field
  on the auth-recovery shapes; `git grep` for the ledgered keys in
  `mediated-credential.ts`/`runtime.ts` at the new pin returns nothing.
- **`runtime-ts-audit-store-load-errors` — KEEP.** `AuditStore` at `aa7b78ee`
  still has no `loadErrors`, which is the contract
  `vendor/intx-storage-isogit` implements and `vendor/intx-agent` resumes from.
- **`types-ts-usage-stop-reason` — KEEP.** The `inference.usage` variant of
  `InferenceEvent` at `aa7b78ee` still lacks `data.stopReason`.

## vendor-types-ts-runtime-format-safety-rating-compat

`runtime.ts` — after the upstream moved `formatSafetyRatingText` to
`format-safety-rating.ts`, the barrel keeps one compat re-export because
the published `@corbits/openai-responses@0.2.1` dist imports it from the
`./runtime` subpath (`dist/protocol/body.js`), and npm has no newer
release that compiles against the new subpath. Without the re-export,
`bun run build` fails to bundle the installed dist.

**Disposition:** Compat shim, not a divergence of behavior. **Removal
path:** the `@corbits/openai-responses` release whose dist imports
`@intx/types/format-safety-rating`; drop this entry and the re-export
lines in the same change.

## runtime-core-ts-approval-mode

`runtime-core.ts` — `ApprovalSnapshot` accepts the optional generic
`approvalMode: "allow-once"` marker. Old snapshots remain valid and unchanged;
marked snapshots let a host reconstruct an approval request without persistable
scopes after a durable suspension resumes.

**Disposition:** Promotion candidate. Companion to `authz-ts-approval-mode` in
`@intx/inference`. **Removal path:** upstream support for equivalent generic
allow-once provenance in the approval snapshot contract. **Re-carry:** preserve
the single literal value and optionality so malformed modes fail parsing while
unmarked historical snapshots remain backward compatible.

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
