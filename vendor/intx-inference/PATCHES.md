# Patch ledger — vendor/intx-inference

**The SHA-diff is authoritative; markers are navigation.**

Recorded upstream commit lives in `docs/VENDORING.md`. A pristine checkout
at that SHA, diffed against `vendor/intx-inference/src`, is the only proof of
which lines are ours — run `bin/vendor-patch-diff` to produce it. The
`Locally patched — see …#<anchor>` comments and the entries below are
signposts that point into that diff; they do not define its extent, and a
marker that drifts over mixed code is still only a marker.

Every divergence from upstream at that commit is a real bug fix or
capability upstream does not carry; none is a workaround for something
upstream has since fixed (each was re-verified against upstream HEAD when
this package was last synced). Each entry below is a site-specific anchor
matched by one or more markers in `src/`.

To re-derive this ledger after a re-sync: run `bin/vendor-patch-diff`, then
confirm every hunk still maps to an entry here (or, if upstream has since
absorbed the same fix, drop the entry and its markers — verify by reading
the new upstream code, not by assuming).

**Vocabulary:** the disposition labels map onto the three-way review
taxonomy as follows — "Promotion candidate" = Upstreamable, "Long-lived" =
Re-carryable, "Kill candidate" = Droppable, and "Companion" entries are
Re-carryable but ride their primary patch's disposition (they ship out or
die with it).

## providers-ts-openai-exclusive-cache-usage

**Promotion candidate.** `providers/openai.ts` subtracts cache-read tokens
from inclusive Chat Completions `prompt_tokens`, clamping the uncached
remainder at zero. The shared conversion covers usage-only and
choice-bearing SSE frames and non-streaming JSON responses, including
builtin OpenAI and Corbits-compatible/Go adapters. Cache reads remain
separate; no cache-write tokens are invented. This prevents double-counted
occupancy and false post-fold nonconvergence.

**Re-carry:** keep normalization in the shared usage conversion, not a
second Corbits-only remap. Regression coverage lives in
`src/provider/chat-completions-usage.test.ts`; drop the patch when the
upstream conversion adopts exclusive input.

## harness-ts-auth-recovery

**Promotion candidate.** `auth.ts`, `harness.ts`, and `reactor.ts` atomically
inject credential-derived identity headers with the live bearer secret, shallow
snapshot the complete source once per call, and expose per-call credential
failure ordinal/history to retry policies. A policy may normalize an attempt
error before the harness computes that ordinal/history, retries, or surfaces the
terminal event, and may preserve a classified refresh diagnostic on abort. After
same-source recovery is exhausted, `credential_failure` is terminal and never
enters automatic source failover.

**Re-carry:** preserve the exact `isCommitting` boundary and immutable call
snapshot. Companion to `runtime-ts-auth-recovery-context` in `@intx/types`.

## reactor-ts-atomic-approval-acceptance

**Promotion candidate.** `reactor.ts` classifies native `approval.granted` /
`approval.denied` headers as conditional decision intent, not authentication.
Its private correlation disposition distinguishes ordinary input from discarded
approvals; stale, ineligible and already-claimed decisions never enter history
or emit `message.received`. `correlation.ts` documents the typed-only exception
to validator false/throw fallback, without changing the validator signature.

The claim spans validation, parsing, dispatch, consumption and publication in
one `try/finally`. Before parsing and after synchronous grant hooks, acceptance
requires the same pending operation and live gate, an accepting lifecycle, and
strictly unexpired gate and persisted deadlines. A clamped rehydration timer
cannot revive an expired persisted operation. Typed targets without a suspended
call are ineligible; eligible bodies must agree with the header. Consumption
and continuation enqueue run without callbacks before `message.correlated`.
Grant hooks may reenter or abort; a failed transition publishes no acceptance.
Arbitrary extension side effects are not rolled back, and observers throwing
after the transition retain the existing fatal-error policy.

**Re-carry:** preserve all acceptance checks and the ordinary-message path when
merging upstream correlation changes. Deterministic real-reactor coverage lives
in `tests/unit/reactor-approval-acceptance.test.ts`. A never-settling validator
retains its claim until settlement; there are no tombstones or discard receipts.
This is a local patch, not a change to the upstream pin or retrieval metadata.

### 2026-09-07 re-sync (upstream `0205b07b`)

Every entry below was re-carried against the new pin; none was dropped as
upstream-absorbed. The sync also dropped one divergence that was **not**
ledgered at the time: `claude-fable-5-1` in `providers/anthropic.ts`'s
`ADAPTIVE_THINKING_MODELS` and its "adaptive thinking request shape" suite in
`providers/anthropic.test.ts`. It is recovered post-sync as
`providers-ts-anthropic-adaptive-fable-5-1` below. Upstream changes in the
pinned range touched exactly two
patched files: `reactor.ts` (doom-loop detection: `doomLoopThreshold`
config, `toolBatchSignature`, run-scoped repeat accounting in `executeTools`,
and a fatal break in the action loop) and `assembly.ts` (a
`doomLoopThreshold` passthrough). Both were three-way merged against the
prior patch set with no conflicts and no rewrites: the patches'
`try/finally` in `tryCorrelate`, the `commitCycle()` call in `executeTools`,
and the `resolvedContextTransforms` resolution all sit alongside the new
upstream code unchanged. New upstream code paths added inside the
`tryCorrelate` critical section (none in this range) or after
`executeTools`' history append (the doom-loop check) compose correctly with
the carried patches. No entry's disposition changed. Every entry below
carries a **Re-carry:** note recording the merge cost and the survivability
risk going into the next sync.

### 2026-09-14 re-sync (upstream `1ad0104`)

Every entry below was re-carried against the new pin; none was dropped as
upstream-absorbed (verified by grepping the new upstream tree for each
patch's concept — `isStreamTerminal`, `isPollOnlyPendingBatch`,
`doomLoopPolicy`/`fail-run`, `ephemeralTurns`, `pendingCompactOutput`,
`lastWrittenTurnsRevision`, `deepFreeze`, `MAX_LINE_LENGTH`,
`loadErrors`, `stopReason` — all absent upstream). Adaptations where the
new upstream moved under the patch:

- `assembly.ts` now carries a direct `contextTransforms` field; the
  deps-riding patch now resolves direct-wins-over-deps
  (`resolvedContextTransforms`, `resolvedIsPollOnlyPendingBatch`). Kill
  condition still open: upstream `@intx/agent` 0.3.0 forwards no
  `contextTransforms`, so the `deps` channel remains the only path.
- `harness.ts` usage emission is now object-literal style; the
  stop-reason spreads were rewritten to match. The four
  `classifyAbortError()` sites are unchanged upstream, so the
  `signal?.reason` adaptation re-applied as-is.
- `reactor.ts` `tryCorrelate` region was restructured upstream; the
  correlating-ids `try/finally` was re-wrapped around the larger block.
  The fail-run queue purge composes with upstream's `CYCLE_EVENT_TYPES`
  set. `ExtendedInferenceOptions` is defined in `reactor.ts` with its
  marker and re-exported from `index.ts` alongside
  `PollBatchLivenessPredicate`.
- Upstream deleted `packages/types/src/sidecar-placement.ts` and
  `packages/inference/src/providers/google-genai.test.ts`; no ledger
  entry lived in either file, so nothing was triaged out with them.
- Upstream replaced inline `apiKey` with a `credentialId` + credential-cell
  auth model. No entry touches auth, so the vendored trees needed no
  migration; first-party callers were migrated to the new model instead
  (each built source registers its secret in
  `src/config/source-credentials.ts`, handed to the vendored trees as
  their resolver).

### 2026-10-14 re-sync (upstream `5453d0b0` — npm `0.4.0`, CL-10651)

Every entry below re-verified against the pristine `5453d0b0` tree; none
was dropped as upstream-absorbed. The ticket's carried-forward DROP
suspicions are contradicted by direct greps of the `0.4.0` tree —
`isStreamTerminal`, `isPollOnlyPendingBatch`, `ephemeralTurns`,
`loadErrors`, `turnsRevision`/`deepFreeze`, `isCommitting`, and
`ClassifiedAbortRaw`-grade `classifyAbortError(reason)` plumbing are all
absent upstream at this pin — so every entry KEEPs and no disposition
label changes. Upstream churn in this package for the range is limited
to `reactor.test.ts` (test-infra: new `@intx/types/testing` `waitUntil`
adoption and race-window rewrites) and `default-director.test.ts`; **no
upstream-producing source file under a ledger entry changed**, so the
src/ entries re-carried byte-identically with zero adaptation. Marker
spot-checks at the recorded positions are unchanged for the same reason
(`providers/openai.ts:574`, `harness.ts:644/1528/1606/1635/1875`,
`errors.ts:54`, `providers/anthropic.ts:825/832/1084`,
`providers/google-genai-files.ts:172-174`).

- `reactor.test.ts` was the only file with both local content and
  upstream changes; it was three-way merged (ours/base/theirs via
  `git merge-file`). `reactor-test-frozen-turns-mutation` re-applied
  onto upstream's rewritten probe; the local doom-loop trivial-shell
  suite (`reactor-ts-doom-loop-trivial-shell-churn` companion tests) and
  the credential-failure terminal tests
  (`harness-ts-auth-recovery` companions) carried through intact.
- `providers/anthropic.test.ts` (CL-7783/adaptive suites) was untouched
  in this range and keeps its prior state.
- New upstream test dependencies on `@intx/types/testing` (`waitUntil`)
  resolve through the vendored `@intx/types` tree, which now carries the
  `./testing` subpath export.
- CL-7783's `stopReason` chain verified end-to-end at this pin:
  `types/runtime.ts:1449/1715`, `providers/anthropic.ts:825/832/1084`,
  and the harness sites `harness.ts:380/1128-1136/1200` all present.
- Carried-patch coverage at this pin: `ephemeralTurns` and the
  context-transforms `deps` channel are pinned by first-party
  `e2e/vendored-carry.test.ts` (both integration tests pass) plus
  `src/provider/anthropic-cache-breakpoint.test.ts` and
  `src/subagent/nudge-director.test.ts`; the poll-exemption predicate by
  `src/subagent/poll-exempt.test.ts` (wired verbatim through
  `src/provider/inference-dependencies.ts`); the stream-terminal
  consumer by `src/provider/grok-responses.test.ts` and
  `src/provider/codex-responses-sse.test.ts`; `classifyAbortError`'s
  reason now gains an in-tree companion test (added this sync) and is
  exercised on the abort paths of `e2e/reactor-approval-acceptance.test.ts`.

### 2026-10-14 re-sync to `4cc6972` (CL-10656, HEAD drift 0.4.0 → base)

Every entry re-carried against the pristine `4cc6972` tree; none dropped as
upstream-absorbed (grep of the pristine tree: `isStreamTerminal`,
`isPollOnlyPendingBatch`, `ephemeralTurns`, `loadErrors`, `turnsRevision`/
`deepFreeze`, `isCommitting`, `MAX_LINE_LENGTH` — all still absent).
Nine upstream commits touch this package (`0f72f95`, `1ff8805`, `a0be30`,
`660ef8`, `d1e05e`, `cb61da`, `d1835b`, `c8be7e`, `2d973a`). Adaptation
surface: 22 upstream-changed files; 9 vendored files carry local content
and were three-way merged (`git merge-file`, ours/base/theirs), the rest
copied verbatim.

- `errors.ts` conflict: upstream `c8be7e` added
  `classifyRequestBuildError` between `classifyNetworkError` and the
  patched `classifyAbortError(reason?)`; both kept (upstream function
  adopted, patch re-carried with its `ClassifiedAbortRaw` type).
- `reactor.ts` two conflicts: (1) `d1835b` added
  `mergeInferenceOptions`/`PerCallInferenceOptions` strip-copy beside the
  patched `ExtendedInferenceOptions` (`ephemeralTurns`) — both kept; (2)
  `d1835b`/`0f72f95` restructured `processDelivery` (per-send `deliver`
  options, `deliveredInference` adoption, `expectedFrom` removal) inside
  the atomic-acceptance critical section — the upstream adoption block
  was re-slit above the patched `disposition` declaration, and the
  `reactor-ts-atomic-approval-acceptance` `try/finally` boundary is
  intact.
- Clean three-way merges on patched files: `assembly.ts`,
  `correlation.ts`, `errors.test.ts`, `harness.ts`, `index.ts`,
  `providers/anthropic.ts`, `providers/google-genai.ts`,
  `providers/openai.ts`, `reactor.test.ts`; patch hunks carry with zero
  adaptation (`providers-ts-openai-exclusive-cache-usage`,
  `inference-ts-cl-7783-truncated-tool-call` stop-reason chain verified
  against the new `@intx/types` `inference-events.ts` sites and
  `providers/anthropic.ts`). The vendored `index.ts` merged with
  upstream's barrel: upstream moved the `AdapterManifest` export to
  `@intx/types` (`adapter-manifest.ts`); first-party
  `src/provider/inference-dependencies.ts` imports it there now.
- `effort.ts`/`effort.test.ts` (`c8be7e` reasoning-effort mapping) and
  `manifest.ts`'s new callers (`2d973a` adapter manifest) adopted
  verbatim; the vendored `package.json` gains the upstream `./manifest`
  and `./default-director` subpath exports.
- Post-merge divergence proof: `bin/vendor-patch-diff` against the
  recorded SHA prints the same +/− line multiset as the pre-sync ledger
  diff (1324 + / 230 − for this package), i.e. no patch content lost and
  no unledgered divergence gained.

### 2026-10-19 re-sync to `aa7b78ee` (npm `0.5.0`, CL-10918)

`git diff --name-only 4cc6972 aa7b78e -- packages/inference` in the upstream
monorepo lists `packages/inference/package.json` only: the release commit
bumps the upstream `version` field and touches no source. The vendored tree
therefore needs no re-carried content, and `bin/vendor-patch-diff` prints the
identical +/− line multiset as before the sync (20 files, 1432 +, 235 −), i.e. no
patch content lost and no unledgered divergence gained. Every entry above re-ratifies
unchanged; none is upstream-absorbed (re-grepped against `aa7b78e`:
`isStreamTerminal`, `isPollOnlyPendingBatch`, `ephemeralTurns`, `loadErrors`,
`turnsRevision`/`deepFreeze`, `isCommitting`, `MAX_LINE_LENGTH`, and the
`role`/`tool_calls` null-delta tolerances are all still absent upstream).

- `package.json`: the two published-npm `@intx/*` entries (`@intx/log`
  dependency, `@intx/mime` devDependency) move `0.3.0` → `0.5.0`, the first
  release that carries the exports those entries consume. `@intx/types` stays
  `workspace:` so the coupled trio resolves to one source tree, and the local
  `version: 0.2.2` placeholder stays per `docs/VENDORING.md`.
- New seam kept in mind for the next sync: `0.4.0` gained
  `ProviderAdapter.manifest`/`CompletionRequest.signal`, which upstream's
  `provider/inference-dependencies.ts` consumes from `@intx/types`
  (`adapter-manifest.ts`) rather than from this package's barrel — unchanged
  at `0.5.0`, so the vendored `index.ts` needs no new alias.

## adapter-ts-stream-terminal-detector

`adapter.ts` — Adds `StreamTerminalDetector`/`ProviderAdapter.isStreamTerminal`.
The OpenAI Responses protocol marks completion with a semantic
`response.completed` event and holds the connection open rather than closing
the socket or sending `[DONE]`; without this, a client reading the stream
hangs waiting for a socket close that never comes. Consumed by `harness.ts`'s
SSE loop.

**Disposition:** Promotion candidate. Requires upstream to add a
`StreamTerminalDetector` hook (or equivalent) to `ProviderAdapter`. No kill
date until upstream adopts; downstream users not using OpenAI Responses
protocol can ignore. **Removal path:** Upstream PR to
`@intx/inference` adding `isStreamTerminal` to `ProviderAdapter`.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Low risk —
`adapter.ts` is stable upstream and untouched by the doom-loop work.

## authz-ts-authorize-call-context

`authz-extension.ts` — The before-tool hook passes the `ToolCall` itself
(frozen) as the authorize callback's `Ctx` instead of an empty object.
Upstream's `emptyContext` made the third argument dead plumbing: the
docblock invites runtimes to choose the shape, but nothing could ever
populate per-call identity through a build-time closure, so a deployment
whose policy needs arguments (shell command strings, path restrictions)
could not authorize at this seam. Freezing matches the existing
`emptyContext` hygiene; ambient state (cwd, store, principal) stays
closure-captured on the authorize function.

**Disposition:** Promotion candidate. Requires upstream to pass the call
as `Ctx` (or an equivalent per-call projection). No kill date until
upstream adopts; downstream users whose `authorize` ignores the context
are unaffected. **Removal path:** Upstream PR to `@intx/inference`
documenting/populating the per-call context at the `authorize` call site.

## authz-ts-deny-reason

`authz-extension.ts` — `AuthzCallResult` may carry an optional `reason`. A
`deny` effect that includes a non-empty reason uses it as the model-facing
block text (`Denied by policy: ${reason}`) instead of the generic
`resource/action` form. Callers that omit `reason` keep the upstream wording.
Consumed by worker permission authorization so an unresolved ask names the
permission subject.

**Disposition:** Promotion candidate. Requires upstream to accept a deny-reason
passthrough on `AuthzCallResult`. **Removal path:** Upstream PR adding
`reason?: string` and using it in `formatBlockReason`.
**Re-carry:** new after `0205b07b`. Low risk — additive optional field.

## authz-ts-approval-mode

`authz-extension.ts` — `AuthzCallResult` may carry the optional generic
`approvalMode: "allow-once"` marker. On an `ask`, the extension copies that
marker into the durable `ApprovalSnapshot`; absent markers preserve the
upstream snapshot byte shape. This lets hosts retain a scope-less approval
constraint across suspension persistence and restart without a second approval
mechanism or plugin-specific state.

**Disposition:** Promotion candidate. Requires upstream to carry generic
approval settlement provenance through its existing snapshot contract.
**Removal path:** Upstream support for an equivalent allow-once marker on authz
results and approval snapshots. **Re-carry:** keep the copy at snapshot creation
only; do not rerun authorization during resume.

## assembly-ts-deps-context-transforms

`assembly.ts` — Resolves `contextTransforms` from either the direct assembly
config value or `deps.contextTransforms` (`resolvedContextTransforms =
contextTransforms ?? deps.contextTransforms`). The published `@intx/agent`
forwards `deps` into reactor assembly verbatim and exposes no dedicated field
for transforms; riding `deps` reaches the vendored assembly without requiring
a change to the published package.

**Disposition:** Kill candidate when `@intx/agent` exposes a dedicated
`contextTransforms` field on its assembly config (or when all callers use the
vendored package directly). **Removal path:** Upstream PR to `@intx/agent` to
forward `contextTransforms` explicitly; then delete both this patch and
`harness-ts-context-transforms`.
**Obligation:** both `contextTransforms` patches have live consumers today —
the `contextTransforms` entry in the `deps` argument to
`createAgentWithLiveToolDispatch` in `src/session/assemble-runtime.ts` and in
`src/subagent/run.ts` — so they
must be re-carried on every sync until upstream exposes the field; only then
can they be killed.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts (upstream touched
`assembly.ts` with a passthrough change; the hunk applied cleanly). Low
risk, but the consumer obligation above keeps this on the sync checklist.

## errors-ts-classify-abort-reason

`errors.ts` — `classifyAbortError` takes an optional `reason` argument and
carries it as `raw: { origin: reason }` on the returned `InferenceError`.
`reason` mirrors `AbortSignal.reason` from the send path (e.g. `user-stop` /
`internal-recovery`), giving callers the abort's origin instead of an
undifferentiated "inference aborted". Called with `signal?.reason` from all
four abort-check sites in `harness.ts`.

**Disposition:** Promotion candidate. Small, additive change — adding an
optional `reason` param to `classifyAbortError` and enriching `raw`. **Removal
path:** Upstream PR adding the optional `reason` parameter and `ClassifiedAbortRaw`
type. No kill date until upstream ships it.
Companion test: the "carries a caller-supplied reason as raw.origin" case in
`errors.test.ts` (added at the CL-10651 sync).
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Low risk —
`errors.ts` sees little upstream churn.

## harness-ts-context-transforms

`harness.ts` — `Dependencies.contextTransforms` carries the field
`assembly.ts` reads off `deps` (see assembly-ts-deps-context-transforms).

**Disposition:** Kill candidate — pair with `assembly-ts-deps-context-transforms`.
**Removal path:** Upstream PR to `@intx/agent` exposing `contextTransforms`
explicitly. Ships out together with the assembly patch.
**Obligation:** live consumers at the `contextTransforms` entries in the
`deps` argument to `createAgentWithLiveToolDispatch` in
`src/session/assemble-runtime.ts` and `src/subagent/run.ts` — re-carry until
upstream exposes the field, then kill.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Low risk.

## harness-ts-inactivity-on-semantic-progress

`harness.ts` — Inactivity timer armed only on semantic progress. The watchdog
used to re-arm on every raw SSE chunk; a provider that sends keep-alive bytes
forever without a terminal event never tripped it, pinning the caller
indefinitely. Now it re-arms only when `adapter.parseResponse` actually
produces events from a chunk.

**Disposition:** Promotion candidate. Clear upstream bug fix — the inactivity
timer should not re-arm on raw bytes. **Removal path:** Upstream PR to
`@intx/inference` gating re-arm on parsed-event output.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Moderate risk —
upstream reworked retry/failover inside `harness.ts`'s `runInference` wrapper;
re-verify the SSE-loop arming site on the next sync.

## harness-ts-is-stream-terminal

`harness.ts` — `isStreamTerminal` consulted in the SSE loop. Stops reading
once `adapter.isStreamTerminal?.(sseData)` returns true, for protocols whose
end-of-turn is a semantic event rather than `[DONE]` or socket close.

**Disposition:** Companion to `adapter-ts-stream-terminal-detector`. Ships
out together when upstream adopts the `isStreamTerminal` hook.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Low risk;
same sync-checklist caveat as the inactivity patch above.

## harness-ts-commitment-boundary-streaming

`harness.ts` — `runInference`'s commitment-boundary streaming redesign. The
published wrapper buffers an entire attempt and flushes it only once the
attempt's terminal shape (done/error) is known, which means no event reaches
the caller until the whole response has arrived even on a successful first
attempt. The vendored version streams every event to the caller as it arrives
once the attempt "commits" (its first content-bearing event — the first
text/thinking delta, tool call, image, etc.); only the handful of pre-commit
metadata events (`inference.start`, `inference.usage`) are buffered, so retry
stays possible up to the first real token without holding a whole response in
memory. A retryable failure after commitment can no longer discard
already-streamed output, so retry is suppressed there and the error surfaces
on the live stream. See `isCommitting` and the docblock on `runInference`.

**Disposition:** Long-lived. This is a design-level change to `runInference`
that upstream would need to adopt wholesale, not a simple param fix.
**Removal path:** Upstream redesigns `runInference` with commitment-boundary
streaming built in. No kill date — this is the core streaming architecture
for Corbits and likely to remain a fork patch for the foreseeable future.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Priority risk —
upstream moved retry emission into `harness.ts`'s `runInference` wrapper,
which is exactly the function this patch redesigns; re-verify the
retry-suppression-after-commitment interaction on every sync.

## harness-ts-is-committing

`harness.ts` — `isCommitting` helper used by the commitment-boundary redesign
above. Classifies which events count as commitment (everything except
pre-commit metadata).

**Disposition:** Companion to `harness-ts-commitment-boundary-streaming`.
Ships out together.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Priority risk —
tracks the commitment-boundary patch.

## reactor-ts-ephemeral-turns

`reactor.ts` — `ExtendedInferenceOptions.ephemeralTurns`: turns appended to
the materialized prompt for one inference call only, never written to durable
history, so transient director guidance does not touch the cached transcript
prefix. No native equivalent exists upstream. `index.ts` re-exports the type
(mechanical; no separate marker).

**Disposition:** Long-lived. Upstream carries no transient-turn or
prompt-injection mechanism as of `0205b07b` (verified by reading the
upstream reactor at that SHA); no upstream issue or PR toward one exists in
the clone. **Removal path:** Only if Corbits adopts an alternative mechanism
for transient prompt injection. No kill date.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Priority risk —
upstream's new doom-loop detection added run-scoped accounting and a fatal
break path in `reactor.ts`; re-verify that ephemeral turns do not interact
badly with doom-loop signatures or the run accounting on the next sync.

## reactor-ts-correlating-ids-leak

`reactor.ts` — `correlatingIds` leak on every successful correlated resume.
The in-flight marker was deleted on the three failure exits of `tryCorrelate`
but never on the three success dispatch paths (`redispatch` / `error_result` /
`gate-cleared`), leaking one `Set` entry per correlated message for the life
of the process. Wrapped the whole critical section in `try/finally` so every
exit clears it.

**Disposition:** Promotion candidate. Clear upstream bug fix. **Removal
path:** Upstream PR wrapping `tryCorrelate` in try/finally to clear
`correlatingIds` on all exit paths.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Moderate risk —
`tryCorrelate` sits adjacent to upstream's new signal-driven resume dispatch
in `reactor.ts`; re-verify exit paths after upstream changes to gate
clearing.

## reactor-ts-doom-loop-poll-exemption

`reactor.ts` — Doom-loop guard exempts still-pending poll batches. The batch
accounting asks an optional first-party liveness predicate
(`PollBatchLivenessPredicate`, typed in `harness.ts` on `Dependencies` and
resolved direct-wins-over-deps through `assembly.ts` into `ReactorConfig`,
mirroring `assembly-ts-deps-context-transforms`): when the batch is
poll-only and every result still shows pending, the stale signature and
repeat count reset instead of counting. Reset — not skip — so an earlier
streak cannot false-positive later; mixed batches and poll-only-terminal
batches count normally. Without the predicate every batch counts, same as
upstream.

**Disposition:** Promotion candidate. Legitimate `wait_agents` /
`shell_collect` polling repeats the identical batch once per model turn and
trips the upstream guard at the default threshold while targets are still
running. **Removal path:** Upstream PR adding a liveness exemption to the
doom-loop accounting.
**Re-carry:** new at this patch; sits inside the upstream doom-loop
accounting block, re-verify the reset branch after upstream changes to batch
signatures or repeat counting.

## reactor-ts-tool-cycle-turns-only

`reactor.ts` — Tool-cycle persistence coalescing (CL-10667; supersedes
#reactor-ts-checkpoint-after-tool-cycle). A tool cycle that appends to history
now touches the store's on-disk segments only: `executeTools` calls
`contextStore.writeTurns(stateManager.getTurns())` (guarded by
`pendingCompactOutput === null` and the shared `lastWrittenTurnsRevision`
revision gate from #reactor-ts-last-written-turns-revision) and defers the
full `commitCycle` (manifest, metadata, git index + commit) to the next
reply/wait/done/suspend/shutdown terminal. Durability contract is the
segments-on-disk story: the optimized context store keeps uncommitted turn
segments in the working tree, and `load()` (the path an interrupt-rebuild
takes) reads them, so the tool exchange survives a rebuild exactly as the
old per-batch commit did.

The loop's `resume.tool_result` step (a parked call rejected, timed out or
dropped without running) writes turns the same way, through the shared
`writeTurnsIfChanged` helper `executeTools` also calls, so a rebuild before
the next terminal loads the result. That closes the parked approval only
because Corbits' optimized context store drops, on load, a pending operation
whose call has a `tool_result` in the turn log (`openPendingOperations` in
`src/session/optimized-context-store.ts`). The reactor does not clear the
record itself: a store that returns pending operations from metadata as last
committed, such as `@intx/storage-isogit`, reloads both the result and the
parked approval, and the re-armed gate's deadline adds a second result.
Upstream needs no equivalent while it commits every tool cycle. A staged
compact skips the write in both places; a parked approval cannot coincide
with one, since the suspend terminal commits and clears it.

`initiateShutdown` appends any `resume.tool_result` still queued behind the
abort (a decision the reactor accepted and removed from its pending set, but
never processed, since the loop serves `abort` first), before
`gates.shutdown()` clears the gate timers. It then writes turns once, only
when it appended something, inside a `try/catch` that reports a non-fatal
`reactor.error`, so a failing store cannot skip `reactor.done` or leak the
workdir lock. Approved calls (`resume.execute_tools`) are not flushed: one
that never ran stays parked on disk rather than gaining a result for a
tool that did not run. A flushed result closes the approval under the same
store dependency as the `resume.tool_result` write.

**Disposition:** Promotion candidate. Performance coalescing — collapses K
git commits per agentic turn to one deferred commit while preserving
rebuild-from-disk durability. The `resume.tool_result` write and the
shutdown flush rely on the store closing an answered call's approval, which
upstream stores do not do, so promoting them also needs the reactor to clear
that pending operation when it writes the result.
**Removal path:** Upstream PR replacing the `executeTools` checkpoint with a
writeTurns-only segments touch and deferring the cycle commit to cycle
terminals.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Moderate risk —
a doom-loop abort skips the deferred terminal (previously the in-flight
batch committed); the turns still reach disk segments, so only the cycle's
manifest records and metadata staging stay uncommitted. Intentionally not
committed; re-verify after upstream doom-loop accounting changes.

## reactor-ts-skip-unchanged-history

`reactor.ts` — Skip re-serializing unchanged history on checkpoint.
`commitCycle` now compares `stateManager.getTurnsRevision()` against the
revision most recently written and skips `contextStore.writeTurns` when
nothing changed, avoiding an O(history) re-serialize (including historical
tool-output blobs) on no-op checkpoints.

**Disposition:** Promotion candidate. Performance optimization with no
behavioral change — reduces checkpoint cost from O(history) to O(1) when
no turns were added. **Removal path:** Upstream PR adding revision check
in `commitCycle`.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Low risk;
depends on the `turnsRevision` plumbing in `state.ts`, which is itself a
patch (below).

**Known pre-existing hazard (documented, file-for-later — do not fix inside
this lane):** `lastWrittenTurnsRevision` advances only after a successful
`commitCycle`. When a commit fails after `contextStore.writeTurns` already
landed, the revision stays behind the turns actually on disk. Consequences
are bounded: the next checkpoint re-serializes and re-writes the same
generation (a perf cost, never a staleness bug — a larger revision is
always written on the next success, and the reactor resets accumulators on
the failure path). A staged compaction between revisions is guarded by
`pendingCompactOutput === null` in every writeTurns site. Keep this guard
intact when touching either site.

## reactor-ts-after-checkpoint-director-only

`reactor.ts` — `afterCheckpoint` fires only for a director-requested
checkpoint. The hasWork-only auto-commit after `executeTools` is internal
durability plumbing, not a checkpoint the caller asked for; without gating on
`hasOverride` (`pendingMessage !== null`), a director that checkpoints in a
later `decide()` call got `afterCheckpoint` invoked twice for what is, from
its perspective, a single checkpoint.

**Disposition:** Promotion candidate. Event correctness fix — prevents
spurious double `afterCheckpoint` events that confuse directors.
**Removal path:** Upstream PR gating `afterCheckpoint` on
`hasOverride`/`pendingMessage !== null`.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Low risk.

## reactor-ts-last-written-turns-revision

`reactor.ts` — `lastWrittenTurnsRevision` state backing the skip-rewrite
optimization (reactor-ts-skip-unchanged-history). Tracks the turns revision
most recently serialized to the context store.

**Disposition:** Companion to `reactor-ts-skip-unchanged-history`. Ships out
together.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Low risk;
tracks the skip-unchanged-history patch.

## reactor-ts-compact-publish-then-memory

`reactor.ts` — `executeCompact` persists blobs, stages `writeTurns`, and
leaves reactor memory on the old generation until `commitCycle` publishes.
`replaceTurns` runs only after a successful commit. `commitCycle` must not
`writeTurns` live (old) memory over that staging. A failed commit clears
`pendingCompactOutput` so a later infer/tools cycle writes live history and
does not `replaceTurns` with the unpublished compact.

**Disposition:** Promotion candidate. Compaction durability — an interrupt
between stage and commit must resume the complete old generation, not a
half-applied rewrite. **Removal path:** Upstream PR reordering compact
persist/stage/commit/replaceTurns.
**Re-carry:** new patch on this pin; expect a three-way against
`executeCompact` and `commitCycle` on the next sync.

## reactor-ts-doom-loop-warning-turn

`harness.ts`, `reactor.ts` — `deps.doomLoopCorrectiveNote` builds a note
appended to each tool result when a repeated batch reaches
`doomLoopThreshold - 1`, so the model sees the exact call already ran before
the fatal trip. Unset appends nothing, same as upstream. **Disposition:**
Re-carryable — sits inside the doom-loop accounting block in `executeTools`.

## reactor-ts-doom-loop-fail-run

`harness.ts`, `reactor.ts` — `deps.doomLoopPolicy: "fail-run"` makes a
tripped guard close the message run and purge the doomed batch's queued
continuations instead of shutting the reactor down; the next inbound message
opens a fresh run. Upstream's fatal exit wedges a long-lived session —
`deliver` drops every later message. Unset is `"shutdown"`, same as
upstream; workers keep it. **Disposition:** Re-carryable — sits at the
doom-loop fatal break in the main loop.

## reactor-ts-doom-loop-trivial-shell-churn

`reactor.ts` — Doom-loop batch signature normalizes trivial `run_shell`
no-ops. `toolBatchSignature` maps each call through `canonicalCallIdentity`:
a bare `echo`/`true` (or `/bin`/`/usr/bin` of those) with no shell
metacharacters (chaining, piping, redirection, substitution, grouping,
comments, newlines) collapses to `{ name: "run_shell", trivialNoopShell: true }`,
so `echo churn-1`, `echo churn-2`, and `true whatever` count as the same
consecutive loop instead of evading the guard via fresh payload strings.
The marker is disjoint from any legal `(name, arguments)` pair — it is
not a fake command string — so a real `trivial-noop-shell` invocation
cannot trip with echo churn. Relative paths (`./true`, `scripts/echo`)
are not the closed set and keep their exact signatures. Extra fields
(`cwd`, `timeout`) drop from the marker and collapse among no-ops only.
Anything that may do real work (`echo hi > file`, `npm test`, distinct
commands) keeps its exact `(name, arguments)` signature and never
collapses.

**Disposition:** Promotion candidate. Guard-evasion fix — upstream's exact
`(name, arguments)` identity lets a runaway model loop forever on
ever-varying no-op shells. **Removal path:** Upstream PR normalizing
trivial-shell signatures in the doom-loop accounting.
**Re-carry:** sits on `toolBatchSignature`; re-verify the normalization
after upstream changes to batch signatures or repeat counting.

## sse-ts-max-line-length

`sse.ts` — `MAX_LINE_LENGTH` (16 MiB) caps the unterminated SSE line buffer
and throws instead of growing unbounded — an unbounded run of bytes with no
newline is indistinguishable from a stuck or hostile stream and would
otherwise OOM the process.

**Disposition:** Promotion candidate. Security/correctness fix — prevents
OOM from a stuck or malicious stream. **Removal path:** Upstream PR adding
`MAX_LINE_LENGTH` cap to SSE line parsing.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Low risk —
`sse.ts` has a single upstream commit and is effectively frozen.

## state-ts-deep-freeze-turns-revision

`state.ts` — `deepFreeze`s appended turns and tracks a `turnsRevision`
counter so `ReactorState.snapshot()`'s `turns` becomes a lazy, memoized
getter instead of a `structuredClone` on every director decision.
High-frequency events (`tool.done`, `inference.error`) reach directors that
never inspect `turns`, so the prior eager deep-clone made per-event cost
scale with session length. `getTurnsRevision()` also backs
`reactor.ts`'s checkpoint-skip optimization.

**Disposition:** Promotion candidate. Performance optimization — eliminates
O(n) structuredClone on every event for directors that don't inspect turns.
**Removal path:** Upstream PR lazy-ifying `ReactorState.snapshot().turns`
with revision tracking.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Low risk —
`state.ts` sees little upstream churn.

## reactor-test-frozen-turns-mutation

`reactor.test.ts` — the "director cannot corrupt reactor state" test wraps
its snapshot-mutation probe in try/catch: upstream's `snapshot()` returns
mutable clones so the assignment succeeds silently, but with
`state-ts-deep-freeze-turns-revision` carried the same assignment throws on
the frozen turn, which the reactor treats as a fatal director exception and
which would fail the test before it reaches its isolation assertion.
Isolation still holds when the throw is ignored.

**Disposition:** Re-carryable — sits inside the one test that probes snapshot
mutability and must track the deep-freeze patch.
**Removal path:** Upstream PR freezing snapshots (or upstream test tolerating
the throw) subsumes it.
**Re-carry:** previously unledgered at `0205b07b` (local-only test hunk, found
by diffing the base tree); now ledgered with a marker. Re-applied by hand at
the new pin — upstream's probe is still the bare assignment.

## google-genai-files-ts-body-init-cast

`providers/google-genai-files.ts` — Casts `opts.bytes as unknown as BodyInit`
— DOM lib's `BodyInit` type is narrower than Node's `Uint8Array` typing, but
`fetch` accepts the bytes at runtime. Worth filing upstream as a real typing
gap rather than carrying indefinitely.

**Disposition:** Promotion candidate. Typing gap — should be fixed upstream.
**Removal path:** Upstream PR widening `BodyInit` to accept `Uint8Array` so
the cast can be deleted from the vendored file.
**Re-carry:** clean three-way at `0205b07b`, zero conflicts. Low risk.

## inference-ts-cl-7783-truncated-tool-call

End-of-stream finalization in `harness.ts` (`finalizeStreamTurn`) never
dispatches a tool call whose arguments do not parse as a normal call. The
prior code fell back to a `{ _raw: <partial JSON> }` tool_call block, which
the reactor dispatched — executing a tool with truncated arguments when the
model was cut off by `max_tokens` (CL-7783: a truncated `Bash`
`rm -rf /tm…` fragment reached the executor). Now: when `stopReason` is
`max_tokens` and a tool call is still open, the turn fails with an
`inference.error` naming the tool and the truncated prefix, advising a
larger budget or a narrower scope for the model's next attempt; any other
unparseable-args case fails the same way as invalid JSON. Both errors carry
category `retryable`, but end-of-stream finalization always runs after the
attempt has committed visible output, so the harness commitment boundary
suppresses the mechanical retry — the failure is terminal for the turn, and
the message is guidance for the next attempt rather than a re-issued retry.
Two supporting changes: `providers/anthropic.ts` parses
`stop_reason` out of `MessageDelta` (previously stripped by the schema) and
surfaces it on `inference.usage`, and `vendor/intx-types`' `InferenceUsageEvent`
gains the optional `stopReason` field both halves flow through. Guarded by the
CL-7783 regression suite in `providers/anthropic.test.ts`, which drives the
exact incident wire sequence and asserts no `tool_call` block reaches the
reactor. The OpenAI-compatible adapter was audited for the same path: it has
no adapter-local args fallback (the harness was the only dispatch site) but
still drops `finish_reason` on both paths, so OpenAI streams get the generic
invalid-JSON failure rather than the truncation-specific message. The Gemini
adapter forwards its terminal `finishReason` onto `inference.usage` (same
spread idiom as Anthropic), but forwards the provider's raw spelling
(`MAX_TOKENS`), which the harness `max_tokens` comparison does not match —
so Gemini truncation still lands on the generic invalid-JSON failure until
the harness normalizes provider spellings.

**Disposition:** Promotion candidate. Safety/correctness fix — prevents
executing tools with truncated arguments after a `max_tokens` cutoff.
**Removal path:** Upstream PR (a) surfacing `stop_reason`/`finish_reason` on
usage events and (b) failing the turn instead of dispatching unparseable tool
calls at end-of-stream finalization. **Re-carry:** localized to
`finalizeStreamTurn`, the `MessageDelta` schema, and one optional event
field; re-applies against upstream `harness.ts`/`anthropic.ts` unless the
finalization path is reworked.

---

## Upstream promotion ledger

Every Promotion candidate above, as a tracked dependency row per CL-7302.
These are dependencies on upstream maintainers, not work we schedule; the
tracking reference is this ledger until an upstream issue is filed, and the
revisit point is the next vendored sync (see `docs/VENDORING.md`).

| Patch | Upstream ask | Upstream contact | Tracking | Revisit |
| --- | --- | --- | --- | --- |
| adapter-ts-stream-terminal-detector (+ harness-ts-is-stream-terminal) | Add an `isStreamTerminal`/`StreamTerminalDetector` hook to `ProviderAdapter` for semantic end-of-stream protocols | Alexander Guy <alexander.guy@pm.me> | This ledger (vendor/intx-inference/PATCHES.md#adapter-ts-stream-terminal-detector) | Next vendored sync |
| authz-ts-deny-reason | Optional `AuthzCallResult.reason` used as the deny block text | Alexander Guy <alexander.guy@pm.me> | This ledger (#authz-ts-deny-reason) | Next vendored sync |
| authz-ts-approval-mode | Carry a generic allow-once marker from authz ask results into durable approval snapshots | Alexander Guy <alexander.guy@pm.me> | This ledger (#authz-ts-approval-mode) | Next vendored sync |
| errors-ts-classify-abort-reason | Add optional `reason` param to `classifyAbortError`, carried as `raw: { origin }` | Alexander Guy <alexander.guy@pm.me> | This ledger (#errors-ts-classify-abort-reason) | Next vendored sync |
| harness-ts-inactivity-on-semantic-progress | Gate the inactivity watchdog's re-arm on parsed events, not raw SSE bytes | Alexander Guy <alexander.guy@pm.me> | This ledger (#harness-ts-inactivity-on-semantic-progress) | Next vendored sync |
| reactor-ts-correlating-ids-leak | Wrap `tryCorrelate` in try/finally so `correlatingIds` clears on success dispatch paths | Alexander Guy <alexander.guy@pm.me> | This ledger (#reactor-ts-correlating-ids-leak) | Next vendored sync |
| reactor-ts-tool-cycle-turns-only (supersedes reactor-ts-checkpoint-after-tool-cycle) | `executeTools` and the `resume.tool_result` step write turns to store segments only and defer the cycle commit to terminals | Alexander Guy <alexander.guy@pm.me> | This ledger (#reactor-ts-tool-cycle-turns-only) | Next vendored sync |
| reactor-ts-skip-unchanged-history (+ reactor-ts-last-written-turns-revision) | Skip `contextStore.writeTurns` when `getTurnsRevision()` is unchanged | Alexander Guy <alexander.guy@pm.me> | This ledger (#reactor-ts-skip-unchanged-history) | Next vendored sync |
| reactor-ts-compact-publish-then-memory | Persist compact blobs, stage `writeTurns`, commit, then `replaceTurns` so memory stays on the old generation until publication | Alexander Guy <alexander.guy@pm.me> | This ledger (#reactor-ts-compact-publish-then-memory) | Next vendored sync |
| reactor-ts-after-checkpoint-director-only | Gate `afterCheckpoint` on `hasOverride` so auto-commits do not emit it | Alexander Guy <alexander.guy@pm.me> | This ledger (#reactor-ts-after-checkpoint-director-only) | Next vendored sync |
| sse-ts-max-line-length | Cap the unterminated SSE line buffer (`MAX_LINE_LENGTH`, 16 MiB) | Alexander Guy <alexander.guy@pm.me> | This ledger (#sse-ts-max-line-length) | Next vendored sync |
| state-ts-deep-freeze-turns-revision | Make `ReactorState.snapshot().turns` a lazy, revision-tracked getter | Alexander Guy <alexander.guy@pm.me> | This ledger (#state-ts-deep-freeze-turns-revision) | Next vendored sync |
| inference-ts-cl-7783-truncated-tool-call | Surface `stop_reason`/`finish_reason` on usage events; fail the turn instead of dispatching unparseable tool calls at end-of-stream finalization | Alexander Guy <alexander.guy@pm.me> | This ledger (#inference-ts-cl-7783-truncated-tool-call) | Next vendored sync |
| google-genai-files-ts-body-init-cast | Widen `BodyInit` to accept Node's `Uint8Array` typing so the cast can be removed | Alexander Guy <alexander.guy@pm.me> | This ledger (#google-genai-files-ts-body-init-cast) | Next vendored sync |
| size-cap-ts-paged-read-file | Skip `createSizeCapTransform` for footer-bearing `read_file` pages so `Use offset=` survives the default 10k cap | Alexander Guy <alexander.guy@pm.me> | This ledger (#size-cap-ts-paged-read-file) | Next vendored sync |

Contact basis: identified from the read-only upstream clone
(`faremeter/interchange`); Alexander Guy <alexander.guy@pm.me> is the
overwhelmingly dominant author of every upstream file these patches touch
(`packages/inference/src/{reactor,harness,adapter,errors,sse,state}.ts`,
`providers/google-genai-files.ts`, `packages/inference/src/assembly.ts`),
so he is the named contact for every row. Next action per row: file the
upstream issue and replace the ledger tracking reference.

## providers-ts-anthropic-adaptive-fable-5-1

`providers/anthropic.ts` — Adds `claude-fable-5-1` to
`ADAPTIVE_THINKING_MODELS`, so the adapter sends the
`thinking:{type:"adaptive"}` + `output_config.effort` wire shape the model
requires instead of the `thinking:{type:"enabled",budget_tokens}` shape
adaptive-only models reject. Upstream's list lacks the model. Consumed by the
`first-class-providers` registry (`claude-fable-5-1` is a shipped, selectable
anthropic and zen model; CHANGELOG 0.3.17 advertises adaptive thinking for
Fable 5). The companion "adaptive thinking request shape" suite that once
guarded the wire shape in `providers/anthropic.test.ts` was dropped by the
2026-09-14 pristine overwrite (`5a291aad5`) and never re-applied, so the
wire shape currently rides without an in-tree guard; only the model id is
covered, by the first-party `first-class-providers` registry test.

**Disposition:** Re-carryable — a one-line list addition that survives sync
trivially. Risk: upstream may grow its own adaptive-models list; reconcile
the two on next sync, and consider restoring the dropped guard suite.
**Removal path:**
Upstream adding `claude-fable-5-1` to its own `ADAPTIVE_THINKING_MODELS`.

## size-cap-ts-paged-read-file

`transforms/size-cap.ts` — Footer-bearing `read_file` pages already carry a
plain `Use offset=N to continue.` contract and are sized to the 50KB page
budget. The default 10k size-cap would slice the body and drop the footer,
stranding pagination. Pass those pages through unchanged (no spill). Other
`read_file` results, and any other tool, still cap as before.

**Disposition:** Promotion candidate. Requires upstream to skip size-cap when
a `read_file` result already names the next offset. Downstream users that
never emit that footer are unaffected.
**Removal path:** Upstream PR to `@intx/inference` exempting footer-bearing
`read_file` pages from `createSizeCapTransform`.
**Re-carry:** isolated predicate at the start of `apply`; low merge risk.

---

The `void track(p)` → `track(p)` change at three call sites in `reactor.ts`
removes a redundant `void` operator with no behavioral effect (kept from the
prior sync for consistency); it is not marked.

Two 0.2.2-era patches are **not carried** because upstream HEAD has already
absorbed the underlying fix: an unhandled-rejection guard around
`tryCorrelate` in `deliver()` (upstream's `deliver()` now wraps the whole
correlation dispatch in try/catch and routes failures through
`closeMessageRun`, superseding the vendored version), and a reactor-level
`inference.retry` emission around same-source retry/failover (upstream moved
retry entirely into `harness.ts`'s `runInference` wrapper, which now emits
`inference.retry` itself before the commitment boundary — see
harness-ts-commitment-boundary-streaming; a reactor-level emission would
double the event).

## providers-ts-openai-null-delta-tolerance

**Promotion candidate.** `providers/openai.ts` tolerates explicit `null` for
`role` and `tool_calls` on Chat Completions streamed deltas and the
non-streaming message (CL-3010: vLLM serializers behind OpenAI-compatible
relays — NEAR AI, Qwen3.8-Flash-Next on vast.ai 2xH200 — emit `"role": null`
on every delta and `"tool_calls": null` on non-tool chunks; the strict schema
rejected each frame, so `protocol_mismatch` aborted the turn). `null` now
means absent, mirroring how sibling(`content`/`refusal`/`reasoning*`) and
nested tool-call (`id`/`function.name`/`function.arguments`) fields already
treat it: `role` widens to `string | null`, `tool_calls` widens to
array-or-null with the streaming parser coalescing null → undefined before
iteration. Wrong-type values stay rejected (`role: 42` still fails schema
validation → `ProtocolMismatchError`, keeping the `protocol_mismatch` abort
path and its rework in `src/agent/retry-policy.test.ts` intact). No consumer
reads `delta.role`; `tool_calls: []` on every chunk (vLLM) was already
tolerated and keeps its semantics.

**Re-carry:** spans `OpenAIToolCallDelta`/`OpenAIChunkDelta`, the streaming
`tool_calls` null-coalesce in `parseResponse`, and the mirrored
`NonStreamingMessage` widening; regression coverage lives in
`src/provider/chat-completions-null-delta.test.ts` (Corbits-side — vendored
OpenAI adapter has no co-located test file at this pin and vendor tests are
outside the repo gate). Drop when upstream opens `delta.role` /
`delta.tool_calls` (and the message schema) to null.
