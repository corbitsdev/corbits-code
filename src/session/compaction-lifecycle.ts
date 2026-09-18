// CL-8220: abort-aware compaction lifecycle.
//
// Diagnosis: the post-compaction TUI wedge parks inside the vendored reactor's
// `await compactor.apply(...)` (vendor/intx-inference/src/reactor.ts
// executeCompact) — the abort hop queues behind it, unreachable. The reactor
// offers no abort seam there, but the host owns the injected `Compactor`, so
// the bound lives here instead of a vendor fork: `wrapCompactor` races the
// inner apply against the session compact signal, and the summary call itself
// is cancellable through the summarizer's existing `getSignal` seam
// (see summarizer.ts `ModelSummarizerOptions.getSignal`).
//
// On abort the wrapper returns a no-op result (input turns unchanged, no
// blobs) so executeCompact still runs its local write/commit path and the
// reactor returns to dequeue — no continuation hop is dropped, the loop just
// resumes from the pre-compact context.

import type {
  Compactor,
  ConversationTurn,
  StrategyResult,
} from "@intx/types/runtime";

/** Machine-readable record reason for a compact cut short by abort. */
export const COMPACTION_ABORTED_REASON = "compact aborted";

export interface CompactionEndInfo {
  aborted: boolean;
}

export interface CompactionLifecycleEvents {
  /** Fires when a compact actually starts running (not on pre-abort skip). */
  onCompactionStart?: () => void;
  /** Always fires when a started compact settles, aborted or not. */
  onCompactionEnd?: (info: CompactionEndInfo) => void;
}

/**
 * CL-8220 checkbox 3: the visible in-progress indicator. Maps lifecycle
 * events onto operator-facing notices so a long summarize never looks like a
 * stall; a cut-short pass says so instead of going silent.
 */
export function createCompactionEventNotices(
  notify: (text: string) => void,
): CompactionLifecycleEvents {
  return {
    onCompactionStart: () => notify("Compacting conversation context…"),
    onCompactionEnd: ({ aborted }) => {
      if (aborted) notify("Compaction interrupted — keeping prior context.");
    },
  };
}

export interface CompactionLifecycle {
  /** Signal the summary call and the apply race listen on. */
  getSignal: () => AbortSignal;
  /** True while a wrapped apply is in flight. */
  isCompacting: () => boolean;
  /**
   * Abort the in-flight compact (interrupt, rotation). The next compact on
   * this controller short-circuits to a no-op until `reset` mints a fresh
   * signal — callers must reset when the replacement agent is built.
   */
  abortCompaction: (reason: string) => void;
  /** Mint a fresh signal for the (re)built agent. */
  reset: () => void;
  /** Bind the abort race and lifecycle events around an inner compactor. */
  wrapCompactor: (inner: Compactor) => Compactor;
}

function abortedResult(
  inner: Compactor,
  turns: ConversationTurn[],
): StrategyResult<ConversationTurn[]> {
  return {
    output: turns,
    record: {
      strategy: inner.name,
      version: inner.version,
      parameters: {},
      reason: COMPACTION_ABORTED_REASON,
      decisions: {},
    },
  };
}

export function createCompactionLifecycle(
  events: CompactionLifecycleEvents = {},
): CompactionLifecycle {
  let controller = new AbortController();
  let compacting = false;

  return {
    getSignal: () => controller.signal,
    isCompacting: () => compacting,
    abortCompaction: (reason: string): void => {
      controller.abort(new Error(reason));
    },
    reset: (): void => {
      controller = new AbortController();
      compacting = false;
    },
    wrapCompactor: (inner: Compactor): Compactor => ({
      name: inner.name,
      version: inner.version,
      apply: async (turns, ctx) => {
        const signal = controller.signal;
        // Aborted before start (e.g. interrupt landed ahead of a threshold
        // compact): skip the inner run entirely, without lifecycle events —
        // the interrupting path already told the operator what happened.
        if (signal.aborted) return abortedResult(inner, turns);
        compacting = true;
        events.onCompactionStart?.();
        let aborted = false;
        try {
          let onAbort: (() => void) | undefined;
          const abortedPromise = new Promise<{ done: false }>((resolve) => {
            onAbort = () => {
              resolve({ done: false });
            };
            signal.addEventListener("abort", onAbort, { once: true });
          });
          try {
            // Promise.race subscribes to the inner promise synchronously, so
            // a late inner rejection after an abort win is still handled —
            // never an unhandled rejection.
            const winner = await Promise.race([
              inner
                .apply(turns, ctx)
                .then((result) => ({ done: true as const, result })),
              abortedPromise,
            ]);
            if (!winner.done) {
              aborted = true;
              return abortedResult(inner, turns);
            }
            return winner.result;
          } finally {
            if (onAbort !== undefined)
              signal.removeEventListener("abort", onAbort);
          }
        } finally {
          compacting = false;
          events.onCompactionEnd?.({ aborted });
        }
      },
    }),
  };
}
