import type {
  ConversationTurn,
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
} from "@intx/types/runtime";
import { compactionThresholdFor } from "../provider/context-window.js";
import { createContextEstimate } from "./context-estimate.js";

const COMPACTOR_NAME = "pruning-compactor";
const MIN_TURNS_TO_COMPACT = 6;
const MAX_OVERFLOW_RECOVERIES = 2;

// A compact action runs in its own reactor cycle, after which the reactor
// idles until the next inbound event. Worker loops (sub-agents, the coding
// director) have no operator to send that next message, so the governor swaps
// the post-tool infer for a compact action, asks the host to deliver an empty
// continuation message, and re-issues the infer when that message arrives.
// Without a continuation channel the governor stays inert: stalling the loop
// would be worse than growing the context.
export type CompactionGovernor = ReturnType<typeof createCompactionGovernor>;

export function createCompactionGovernor(requestContinuation?: () => void) {
  let pending = false;
  let idlePending = false;
  let postCompactInfer = false;
  let overflowRecoveries = 0;

  // Running local estimate of the turns we send. Providers that omit usage or
  // report zero leave the proactive path blind; the estimate fills that gap.
  // When the provider reports real usage we prefer it so a coarse local count
  // cannot thrash against a trustworthy signal.
  const estimate = createContextEstimate();

  // Re-sync after turn appends, tool results, and compaction rewrites. Callers
  // pass the full turn list so the estimate stays accurate without incremental
  // add/subtract bookkeeping.
  function syncFromTurns(turns: readonly ConversationTurn[]): number {
    return estimate.syncFromTurns(turns);
  }

  function noteInferenceDone(
    event: Extract<ReactorInboundEvent, { type: "inference.done" }>,
    turns: readonly ConversationTurn[],
  ): void {
    overflowRecoveries = 0;
    if (requestContinuation === undefined) return;
    syncFromTurns(turns);
    const reportedTokens = event.usage?.input ?? 0;
    const contextTokens = reportedTokens > 0 ? reportedTokens : estimate.tokens;
    // Assign, don't OR: an under-threshold follow-up must disarm a sticky pending
    // left from an earlier over-threshold turn (e.g. after the provider reports
    // real usage that lands below the threshold).
    pending =
      contextTokens > compactionThresholdFor(event.source?.model) &&
      turns.length > MIN_TURNS_TO_COMPACT;
  }

  // Compaction waits for the natural pause between a tool batch finishing and
  // the follow-up infer: the infer is dropped from the action set, the compact
  // cycle runs, and the continuation message re-enters inference.
  function interceptActions(
    event: ReactorInboundEvent,
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (!pending || event.type !== "tool.done") return null;
    if (!actions.some((a) => a.type === "infer")) return null;
    pending = false;
    postCompactInfer = true;
    requestContinuation?.();
    return [
      ...actions.filter((a) => a.type !== "infer"),
      capabilities.compact(COMPACTOR_NAME, "context-threshold"),
    ];
  }

  // Interactive sessions can end a turn with a reply and then sit idle, so a
  // pending compaction would wait indefinitely for the next tool batch. When
  // the turn ends without follow-up work, ask the host for a continuation and
  // compact when it (or the operator's next message) arrives.
  function noteIdleTurn(event: ReactorInboundEvent, actions: ReactorAction[]): void {
    if (!pending || idlePending || requestContinuation === undefined) return;
    if (event.type !== "inference.done") return;
    const terminal =
      actions.some((a) => a.type === "reply" || a.type === "wait") &&
      !actions.some((a) => a.type === "infer" || a.type === "execute_tools");
    if (!terminal) return;
    idlePending = true;
    requestContinuation();
  }

  function interceptIdleContinuation(
    event: ReactorInboundEvent,
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (!idlePending || event.type !== "message.received") return null;
    idlePending = false;
    pending = false;
    const content =
      typeof event.message.content === "string" ? event.message.content : "";
    // An operator message that raced the continuation is already in history;
    // compact first, then request another continuation to answer it.
    if (content.length > 0) {
      postCompactInfer = true;
      requestContinuation?.();
    }
    return [capabilities.compact(COMPACTOR_NAME, "context-threshold")];
  }

  // A context-overflow inference error would otherwise terminate the loop
  // with an error reply. Compact and retry, bounded so a history the
  // compactor cannot shrink does not loop forever.
  function interceptOverflow(
    event: ReactorInboundEvent,
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (requestContinuation === undefined) return null;
    if (event.type !== "inference.error" || event.error.category !== "context_overflow") {
      return null;
    }
    if (overflowRecoveries >= MAX_OVERFLOW_RECOVERIES) return null;
    overflowRecoveries++;
    pending = false;
    postCompactInfer = true;
    requestContinuation();
    return [capabilities.compact(COMPACTOR_NAME, "context-overflow")];
  }

  function resumeAfterCompact(event: ReactorInboundEvent): boolean {
    if (!postCompactInfer || event.type !== "message.received") return false;
    const content =
      typeof event.message.content === "string" ? event.message.content : "";
    if (content.length > 0) return false;
    postCompactInfer = false;
    return true;
  }

  return {
    get estimatedTokens(): number {
      return estimate.tokens;
    },
    syncFromTurns,
    noteInferenceDone,
    noteIdleTurn,
    interceptActions,
    interceptIdleContinuation,
    interceptOverflow,
    resumeAfterCompact,
  };
}
