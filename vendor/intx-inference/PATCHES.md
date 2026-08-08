# Patch ledger — vendor/intx-inference

Every divergence from the upstream Interchange source at the commit recorded
in `docs/VENDORING.md`. Each entry is a real bug fix or capability upstream
does not carry; none is a workaround for something upstream has since fixed
(each was re-verified against upstream HEAD when this package was last
synced). A patched file carries a one-line `Locally patched — see
vendor/intx-inference/PATCHES.md#<anchor>` comment at each patched location so
a diff against upstream shows exactly which lines are ours.

To re-derive this ledger after a re-sync: diff the pre-sync `src/` against
the new upstream checkout at the same paths; every hunk that survives the
diff is a patch that needs re-applying (or, if upstream has since absorbed
the same fix, dropping — verify by reading the new upstream code, not by
assuming).

## adapter.ts

Adds `StreamTerminalDetector`/`ProviderAdapter.isStreamTerminal`. The OpenAI
Responses protocol marks completion with a semantic `response.completed`
event and holds the connection open rather than closing the socket or
sending `[DONE]`; without this, a client reading the stream hangs waiting for
a socket close that never comes. Consumed by `harness.ts`'s SSE loop.

## assembly.ts

Resolves `contextTransforms` from either the direct assembly config value or
`deps.contextTransforms` (`resolvedContextTransforms = contextTransforms ??
deps.contextTransforms`). The published `@intx/agent` forwards `deps` into
reactor assembly verbatim and exposes no dedicated field for transforms;
riding `deps` reaches the vendored assembly without requiring a change to
the published package.

## errors.ts

`classifyAbortError` takes an optional `reason` argument and carries it as
`raw: { origin: reason }` on the returned `InferenceError`. `reason` mirrors
`AbortSignal.reason` from the send path (e.g. `user-stop` /
`internal-recovery`), giving callers the abort's origin instead of an
undifferentiated "inference aborted". Called with `signal?.reason` from all
four abort-check sites in `harness.ts`.

## harness.ts

Three independent fixes:

- **Dependencies.contextTransforms** — carries the field `assembly.ts`
  reads off `deps` (see above).
- **`classifyAbortError(signal?.reason)`** — passes the abort reason through
  at all four sites that classify an aborted signal.
- **Inactivity timer armed only on semantic progress** — the watchdog used to
  re-arm on every raw SSE chunk; a provider that sends keep-alive bytes
  forever without a terminal event never tripped it, pinning the caller
  indefinitely. Now it re-arms only when `adapter.parseResponse` actually
  produces events from a chunk.
- **`isStreamTerminal` consulted in the SSE loop** — stops reading once
  `adapter.isStreamTerminal?.(sseData)` returns true, for protocols whose
  end-of-turn is a semantic event rather than `[DONE]` or socket close.
- **`runInference`'s commitment-boundary streaming redesign** — the
  published wrapper buffers an entire attempt and flushes it only once the
  attempt's terminal shape (done/error) is known, which means no event
  reaches the caller until the whole response has arrived even on a
  successful first attempt. The vendored version streams every event to the
  caller as it arrives once the attempt "commits" (its first content-bearing
  event — the first text/thinking delta, tool call, image, etc.); only the
  handful of pre-commit metadata events (`inference.start`,
  `inference.usage`) are buffered, so retry stays possible up to the first
  real token without holding a whole response in memory. A retryable failure
  after commitment can no longer discard already-streamed output, so retry
  is suppressed there and the error surfaces on the live stream. See
  `isCommitting` and the docblock on `runInference`.

## reactor.ts

Five independent fixes, all inside `tryCorrelate` / the cycle-commit path:

- **`correlatingIds` leak on every successful correlated resume** — the
  in-flight marker was deleted on the three failure exits of
  `tryCorrelate` but never on the three success dispatch paths
  (`redispatch` / `error_result` / `gate-cleared`), leaking one `Set` entry
  per correlated message for the life of the process. Wrapped the whole
  critical section in `try/finally` so every exit clears it.
- **`ExtendedInferenceOptions.ephemeralTurns`** — turns appended to the
  materialized prompt for one inference call only, never written to durable
  history, so transient director guidance does not touch the cached
  transcript prefix. No native equivalent exists upstream.
- **Checkpoint after a tool cycle that appends to history** — `executeTools`
  now calls `commitCycle()` when `addToHistory` is true, so an interrupt
  that rebuilds the agent from the store reloads the completed tool
  exchange instead of losing an uncommitted tool turn (context previously
  committed only at cycle terminals).
- **`afterCheckpoint` fires only for a director-requested checkpoint** — the
  hasWork-only auto-commit after `executeTools` is internal durability
  plumbing, not a checkpoint the caller asked for; without gating on
  `hasOverride` (`pendingMessage !== null`), a director that checkpoints in
  a later `decide()` call got `afterCheckpoint` invoked twice for what is,
  from its perspective, a single checkpoint.
- **Skip re-serializing unchanged history on checkpoint** — `commitCycle`
  now compares `stateManager.getTurnsRevision()` against the revision most
  recently written and skips `contextStore.writeTurns` when nothing
  changed, avoiding an O(history) re-serialize (including historical
  tool-output blobs) on every checkpoint.

The `void track(p)` → `track(p)` change at three call sites removes a
redundant `void` operator with no behavioral effect (kept from the prior
sync for consistency).

Two 0.2.2-era patches are **not carried** because upstream HEAD has already
absorbed the underlying fix: an unhandled-rejection guard around
`tryCorrelate` in `deliver()` (upstream's `deliver()` now wraps the whole
correlation dispatch in try/catch and routes failures through
`closeMessageRun`, superseding the vendored version), and a reactor-level
`inference.retry` emission around same-source retry/failover (upstream
moved retry entirely into `harness.ts`'s `runInference` wrapper, which now
emits `inference.retry` itself before the commitment boundary — see
harness.ts above; a reactor-level emission would double the event).

## sse.ts

`MAX_LINE_LENGTH` (16 MiB) caps the unterminated SSE line buffer and throws
instead of growing unbounded — an unbounded run of bytes with no newline is
indistinguishable from a stuck or hostile stream and would otherwise OOM the
process.

## state.ts

`deepFreeze`s appended turns and tracks a `turnsRevision` counter so
`ReactorState.snapshot()`'s `turns` becomes a lazy, memoized getter instead
of a `structuredClone` on every director decision. High-frequency events
(`tool.done`, `inference.error`) reach directors that never inspect `turns`,
so the prior eager deep-clone made per-event cost scale with session length.
`getTurnsRevision()` also backs `reactor.ts`'s checkpoint-skip optimization
above.

## index.ts

Re-exports `ExtendedInferenceOptions` from `reactor.ts` (mechanical; follows
that file's patch).

## providers/google-genai-files.ts

Casts `opts.bytes as unknown as BodyInit` — DOM lib's `BodyInit` type is
narrower than Node's `Uint8Array` typing, but `fetch` accepts the bytes at
runtime. Worth filing upstream as a real typing gap rather than carrying
indefinitely.
