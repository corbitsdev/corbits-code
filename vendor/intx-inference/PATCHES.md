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

### 2026-09-07 re-sync (upstream `0205b07b`)

Every entry above was re-carried against the new pin; none was dropped as
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
the carried patches. No entry's disposition changed.

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

## harness-ts-context-transforms

`harness.ts` — `Dependencies.contextTransforms` carries the field
`assembly.ts` reads off `deps` (see assembly-ts-deps-context-transforms).

**Disposition:** Kill candidate — pair with `assembly-ts-deps-context-transforms`.
**Removal path:** Upstream PR to `@intx/agent` exposing `contextTransforms`
explicitly. Ships out together with the assembly patch.

## harness-ts-inactivity-on-semantic-progress

`harness.ts` — Inactivity timer armed only on semantic progress. The watchdog
used to re-arm on every raw SSE chunk; a provider that sends keep-alive bytes
forever without a terminal event never tripped it, pinning the caller
indefinitely. Now it re-arms only when `adapter.parseResponse` actually
produces events from a chunk.

**Disposition:** Promotion candidate. Clear upstream bug fix — the inactivity
timer should not re-arm on raw bytes. **Removal path:** Upstream PR to
`@intx/inference` gating re-arm on parsed-event output.

## harness-ts-is-stream-terminal

`harness.ts` — `isStreamTerminal` consulted in the SSE loop. Stops reading
once `adapter.isStreamTerminal?.(sseData)` returns true, for protocols whose
end-of-turn is a semantic event rather than `[DONE]` or socket close.

**Disposition:** Companion to `adapter-ts-stream-terminal-detector`. Ships
out together when upstream adopts the `isStreamTerminal` hook.

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

## harness-ts-is-committing

`harness.ts` — `isCommitting` helper used by the commitment-boundary redesign
above. Classifies which events count as commitment (everything except
pre-commit metadata).

**Disposition:** Companion to `harness-ts-commitment-boundary-streaming`.
Ships out together.

## reactor-ts-ephemeral-turns

`reactor.ts` — `ExtendedInferenceOptions.ephemeralTurns`: turns appended to
the materialized prompt for one inference call only, never written to durable
history, so transient director guidance does not touch the cached transcript
prefix. No native equivalent exists upstream. `index.ts` re-exports the type
(mechanical; no separate marker).

**Disposition:** Long-lived. No upstream equivalent exists and is not planned.
Ephemeral turns are a Corbits-specific mechanism for injecting transient
director guidance. **Removal path:** Only if Corbits adopts an alternative
mechanism for transient prompt injection. No kill date.

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

## reactor-ts-checkpoint-after-tool-cycle

`reactor.ts` — Checkpoint after a tool cycle that appends to history.
`executeTools` now calls `commitCycle()` when `addToHistory` is true, so an
interrupt that rebuilds the agent from the store reloads the completed tool
exchange instead of losing an uncommitted tool turn (context previously
committed only at cycle terminals).

**Disposition:** Promotion candidate. Durability correctness fix —
interrupting after a tool cycle must not lose committed tool turns.
**Removal path:** Upstream PR adding `commitCycle()` call in
`executeTools` when `addToHistory` is true.

## reactor-ts-skip-unchanged-history

`reactor.ts` — Skip re-serializing unchanged history on checkpoint.
`commitCycle` now compares `stateManager.getTurnsRevision()` against the
revision most recently written and skips `contextStore.writeTurns` when
nothing changed, avoiding an O(history) re-serialize (including historical
tool-output blobs) on every checkpoint.

**Disposition:** Promotion candidate. Performance optimization with no
behavioral change — reduces checkpoint cost from O(history) to O(1) when
no turns were added. **Removal path:** Upstream PR adding revision check
in `commitCycle`.

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

## reactor-ts-last-written-turns-revision

`reactor.ts` — `lastWrittenTurnsRevision` state backing the skip-rewrite
optimization (reactor-ts-skip-unchanged-history). Tracks the turns revision
most recently serialized to the context store.

**Disposition:** Companion to `reactor-ts-skip-unchanged-history`. Ships out
together.

## sse-ts-max-line-length

`sse.ts` — `MAX_LINE_LENGTH` (16 MiB) caps the unterminated SSE line buffer
and throws instead of growing unbounded — an unbounded run of bytes with no
newline is indistinguishable from a stuck or hostile stream and would
otherwise OOM the process.

**Disposition:** Promotion candidate. Security/correctness fix — prevents
OOM from a stuck or malicious stream. **Removal path:** Upstream PR adding
`MAX_LINE_LENGTH` cap to SSE line parsing.

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

## google-genai-files-ts-body-init-cast

`providers/google-genai-files.ts` — Casts `opts.bytes as unknown as BodyInit`
— DOM lib's `BodyInit` type is narrower than Node's `Uint8Array` typing, but
`fetch` accepts the bytes at runtime. Worth filing upstream as a real typing
gap rather than carrying indefinitely.

**Disposition:** Promotion candidate. Typing gap — should be fixed upstream.
**Removal path:** Upstream PR widening `BodyInit` to accept `Uint8Array`, or
Corbits adds a local type assertion wrapper and removes the cast from the
vendored patch.

## providers-ts-anthropic-adaptive-fable-5-1

`providers/anthropic.ts` — Adds `claude-fable-5-1` to
`ADAPTIVE_THINKING_MODELS`, so the adapter sends the
`thinking:{type:"adaptive"}` + `output_config.effort` wire shape the model
requires instead of the `thinking:{type:"enabled",budget_tokens}` shape
adaptive-only models reject. Upstream's list lacks the model. Consumed by the
`first-class-providers` registry (`claude-fable-5-1` is a shipped, selectable
anthropic and zen model; CHANGELOG 0.3.17 advertises adaptive thinking for
Fable 5) and guarded by the "adaptive thinking request shape" suite in
`providers/anthropic.test.ts`.

**Disposition:** Re-carryable — a one-line list addition that survives sync
trivially; the guard suite re-applies verbatim. Risk: upstream may grow its
own adaptive-models list; reconcile the two on next sync. **Removal path:**
Upstream adding `claude-fable-5-1` to its own `ADAPTIVE_THINKING_MODELS`.

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
