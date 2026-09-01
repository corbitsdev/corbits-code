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

## adapter-ts-stream-terminal-detector

`adapter.ts` — Adds `StreamTerminalDetector`/`ProviderAdapter.isStreamTerminal`.
The OpenAI Responses protocol marks completion with a semantic
`response.completed` event and holds the connection open rather than closing
the socket or sending `[DONE]`; without this, a client reading the stream
hangs waiting for a socket close that never comes. Consumed by `harness.ts`'s
SSE loop.

## assembly-ts-deps-context-transforms

`assembly.ts` — Resolves `contextTransforms` from either the direct assembly
config value or `deps.contextTransforms` (`resolvedContextTransforms =
contextTransforms ?? deps.contextTransforms`). The published `@intx/agent`
forwards `deps` into reactor assembly verbatim and exposes no dedicated field
for transforms; riding `deps` reaches the vendored assembly without requiring
a change to the published package.

## errors-ts-classify-abort-reason

`errors.ts` — `classifyAbortError` takes an optional `reason` argument and
carries it as `raw: { origin: reason }` on the returned `InferenceError`.
`reason` mirrors `AbortSignal.reason` from the send path (e.g. `user-stop` /
`internal-recovery`), giving callers the abort's origin instead of an
undifferentiated "inference aborted". Called with `signal?.reason` from all
four abort-check sites in `harness.ts`.

## harness-ts-context-transforms

`harness.ts` — `Dependencies.contextTransforms` carries the field
`assembly.ts` reads off `deps` (see assembly-ts-deps-context-transforms).

## harness-ts-inactivity-on-semantic-progress

`harness.ts` — Inactivity timer armed only on semantic progress. The watchdog
used to re-arm on every raw SSE chunk; a provider that sends keep-alive bytes
forever without a terminal event never tripped it, pinning the caller
indefinitely. Now it re-arms only when `adapter.parseResponse` actually
produces events from a chunk.

## harness-ts-is-stream-terminal

`harness.ts` — `isStreamTerminal` consulted in the SSE loop. Stops reading
once `adapter.isStreamTerminal?.(sseData)` returns true, for protocols whose
end-of-turn is a semantic event rather than `[DONE]` or socket close.

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

## harness-ts-is-committing

`harness.ts` — `isCommitting` helper used by the commitment-boundary redesign
above. Classifies which events count as commitment (everything except
pre-commit metadata).

## providers-openai-ts-null-tool-calls-quirk

`providers/openai.ts` — Adds the opt-in `normalizeNullToolCalls` OpenAI quirk.
Some OpenAI-compatible chat-completions APIs emit `delta.tool_calls: null`
to represent an absent tool-call delta. Opted-in sources normalize only that
field/value to absence before strict chunk validation; the default parser and
all non-null malformed values remain strict. Verified against upstream main at
`ee17074a`, which still rejects null and has no equivalent quirk.

## reactor-ts-ephemeral-turns

`reactor.ts` — `ExtendedInferenceOptions.ephemeralTurns`: turns appended to
the materialized prompt for one inference call only, never written to durable
history, so transient director guidance does not touch the cached transcript
prefix. No native equivalent exists upstream. `index.ts` re-exports the type
(mechanical; no separate marker).

## reactor-ts-correlating-ids-leak

`reactor.ts` — `correlatingIds` leak on every successful correlated resume.
The in-flight marker was deleted on the three failure exits of `tryCorrelate`
but never on the three success dispatch paths (`redispatch` / `error_result` /
`gate-cleared`), leaking one `Set` entry per correlated message for the life
of the process. Wrapped the whole critical section in `try/finally` so every
exit clears it.

## reactor-ts-checkpoint-after-tool-cycle

`reactor.ts` — Checkpoint after a tool cycle that appends to history.
`executeTools` now calls `commitCycle()` when `addToHistory` is true, so an
interrupt that rebuilds the agent from the store reloads the completed tool
exchange instead of losing an uncommitted tool turn (context previously
committed only at cycle terminals).

## reactor-ts-skip-unchanged-history

`reactor.ts` — Skip re-serializing unchanged history on checkpoint.
`commitCycle` now compares `stateManager.getTurnsRevision()` against the
revision most recently written and skips `contextStore.writeTurns` when
nothing changed, avoiding an O(history) re-serialize (including historical
tool-output blobs) on every checkpoint.

## reactor-ts-after-checkpoint-director-only

`reactor.ts` — `afterCheckpoint` fires only for a director-requested
checkpoint. The hasWork-only auto-commit after `executeTools` is internal
durability plumbing, not a checkpoint the caller asked for; without gating on
`hasOverride` (`pendingMessage !== null`), a director that checkpoints in a
later `decide()` call got `afterCheckpoint` invoked twice for what is, from
its perspective, a single checkpoint.

## reactor-ts-last-written-turns-revision

`reactor.ts` — `lastWrittenTurnsRevision` state backing the skip-rewrite
optimization (reactor-ts-skip-unchanged-history). Tracks the turns revision
most recently serialized to the context store.

## sse-ts-max-line-length

`sse.ts` — `MAX_LINE_LENGTH` (16 MiB) caps the unterminated SSE line buffer
and throws instead of growing unbounded — an unbounded run of bytes with no
newline is indistinguishable from a stuck or hostile stream and would
otherwise OOM the process.

## state-ts-deep-freeze-turns-revision

`state.ts` — `deepFreeze`s appended turns and tracks a `turnsRevision`
counter so `ReactorState.snapshot()`'s `turns` becomes a lazy, memoized
getter instead of a `structuredClone` on every director decision.
High-frequency events (`tool.done`, `inference.error`) reach directors that
never inspect `turns`, so the prior eager deep-clone made per-event cost
scale with session length. `getTurnsRevision()` also backs
`reactor.ts`'s checkpoint-skip optimization.

## google-genai-files-ts-body-init-cast

`providers/google-genai-files.ts` — Casts `opts.bytes as unknown as BodyInit`
— DOM lib's `BodyInit` type is narrower than Node's `Uint8Array` typing, but
`fetch` accepts the bytes at runtime. Worth filing upstream as a real typing
gap rather than carrying indefinitely.

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
