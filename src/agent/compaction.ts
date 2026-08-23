import type {
  ConversationTurn,
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ToolDefinition,
} from "@intx/types/runtime";
import {
  compactionResumeDeltaFor,
  compactionThresholdFor,
  contextTokensFromUsage,
} from "../provider/context-window.js";
import { COMPACTOR_KEEP_RECENT_TURNS, compactorNoOpFloor } from "../session/compactor.js";
import { createContextEstimate, estimateOverheadTokens } from "./context-estimate.js";
import { onTurnBoundary } from "./reactor-events.js";

const COMPACTOR_NAME = "pruning-compactor";
// The exact turn count `createPruningCompactor` (session/compactor.ts) is
// guaranteed to no-op on. Derived from the same keepRecentTurns both real
// registrations (session, sub-agent) use, so this floor cannot silently
// drift from what the compactor will actually do — arming at or below it
// would spend a reactor cycle that shrinks nothing.
const MIN_TURNS_TO_COMPACT = compactorNoOpFloor(COMPACTOR_KEEP_RECENT_TURNS);
const MAX_OVERFLOW_RECOVERIES = 2;

// A compact action runs in its own reactor cycle, after which the reactor
// idles until the next inbound event. Worker loops (sub-agents, the coding
// director) have no operator to send that next message, so the governor swaps
// the post-tool infer for a compact action, asks the host to deliver an empty
// continuation message, and re-issues the infer when that message arrives.
// Without a continuation channel the governor stays inert: stalling the loop
// would be worse than growing the context.
export type CompactionGovernor = ReturnType<typeof createCompactionGovernor>;

export function createCompactionGovernor(
  requestContinuation?: () => void,
  systemPrompt = "",
  toolDefinitions: readonly ToolDefinition[] = [],
) {
  let pending = false;
  let idlePending = false;
  let postCompactInfer = false;
  // Idle empty compact needs a post-compact decide cycle to adopt the shrunk
  // turns for the meter, but must not start a new inference (there is no
  // operator question to answer). Distinct from postCompactInfer.
  let postCompactMeter = false;
  let overflowRecoveries = 0;
  // Set whenever the arming decision fell back to the local estimate because
  // the provider omitted usage or reported zero, so callers rendering a meter
  // can flag the number as approximate instead of implying provider-grade
  // precision.
  let usingEstimate = false;
  // Model of the last inference.done turn, kept for live re-checks between
  // inference cycles (see interceptActions) where the event carries no model.
  let lastModel: string | undefined;
  let turnCount = 0;
  // Growth hysteresis after a compact that remained over the high watermark:
  // snapshot the post-compact infer's usage, then do not re-arm until usage
  // grows by resumeDelta. Cleared once usage drops back to or under high.
  // Overflow recovery ignores this and arms regardless.
  let tokensAtLastCompact: number | undefined;
  let awaitingPostCompactMeasurement = false;

  // Running local estimate of the turns we send, plus the fixed system-prompt
  // and tool-schema overhead every request carries. Providers that omit usage
  // or report zero leave the proactive path blind; the estimate fills that
  // gap. When the provider reports real usage we prefer it so a coarse local
  // count cannot thrash against a trustworthy signal.
  const estimate = createContextEstimate(estimateOverheadTokens(systemPrompt, toolDefinitions));

  // Re-sync after turn appends, tool results, and compaction rewrites. Callers
  // pass the full turn list so the estimate stays accurate without incremental
  // add/subtract bookkeeping.
  function syncFromTurns(turns: readonly ConversationTurn[]): number {
    turnCount = turns.length;
    return estimate.syncFromTurns(turns);
  }

  function isOverThreshold(contextTokens: number): boolean {
    if (turnCount <= MIN_TURNS_TO_COMPACT) return false;
    const high = compactionThresholdFor(lastModel);
    if (contextTokens <= high) return false;
    if (tokensAtLastCompact !== undefined) {
      return contextTokens >= tokensAtLastCompact + compactionResumeDeltaFor(lastModel);
    }
    return true;
  }

  function noteCompactIssued(): void {
    awaitingPostCompactMeasurement = true;
  }

  function noteInferenceDone(
    event: Extract<ReactorInboundEvent, { type: "inference.done" }>,
    turns: readonly ConversationTurn[],
  ): void {
    overflowRecoveries = 0;
    if (requestContinuation === undefined) return;
    syncFromTurns(turns);
    lastModel = event.source?.model;
    const reportedTokens = contextTokensFromUsage(event.usage);
    usingEstimate = reportedTokens <= 0;
    const contextTokens = usingEstimate ? estimate.tokens : reportedTokens;
    // Snapshot on the first inference.done after a compact (the post-compact
    // infer), not at intercept time — intercept has no fresh usage.
    if (awaitingPostCompactMeasurement) {
      tokensAtLastCompact = contextTokens;
      awaitingPostCompactMeasurement = false;
    }
    if (contextTokens <= compactionThresholdFor(lastModel)) {
      tokensAtLastCompact = undefined;
    }
    // Assign, don't OR: an under-threshold follow-up must disarm a sticky
    // pending left from an earlier over-threshold turn (e.g. after the
    // provider reports real usage that lands below the threshold).
    pending = isOverThreshold(contextTokens);
  }

  // Compaction waits for the natural pause between a tool batch finishing and
  // the follow-up infer: the infer is dropped from the action set, the compact
  // cycle runs, and the continuation message re-enters inference.
  //
  // `pending` reflects the snapshot as of the last inference.done, which
  // predates any tool result produced by that turn's own tool batch. When the
  // provider is reporting real usage, that snapshot is authoritative and
  // `pending` alone is trusted (there is no fresher provider number to check
  // against until the next inference.done). But when usage was omitted or
  // zero, `pending` was itself derived from the local estimate — in that case
  // a large tool result can push the estimate over threshold before the next
  // inference.done ever runs, so this re-derives the same arming rule against
  // the live estimate (already re-synced this cycle by the director) instead
  // of trusting a `pending` that can be stale by exactly one tool batch.
  function interceptActions(
    event: ReactorInboundEvent,
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (event.type !== "tool.done") return null;
    if (!pending && !(usingEstimate && isOverThreshold(estimate.tokens))) return null;
    if (!actions.some((a) => a.type === "infer")) return null;
    pending = false;
    postCompactInfer = true;
    noteCompactIssued();
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
    if (!onTurnBoundary(event)) return;
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
    const content = typeof event.message.content === "string" ? event.message.content : "";
    // The reactor delivers no event after compact, so always request a
    // continuation to re-enter decide against the shrunk turns:
    // - raced operator content → re-infer to answer it
    // - empty synthetic continuation → meter-only sync (no infer)
    if (content.length > 0) {
      postCompactInfer = true;
    } else {
      postCompactMeter = true;
    }
    noteCompactIssued();
    requestContinuation?.();
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
    noteCompactIssued();
    requestContinuation();
    return [capabilities.compact(COMPACTOR_NAME, "context-overflow")];
  }

  // After compact, a content-less continuation re-enters decide. "infer" means
  // resume the interrupted loop; "meter" means adopt the shrunk turns for the
  // Ctx display and stay idle (idle empty compact has nothing to answer).
  function resumeAfterCompact(event: ReactorInboundEvent): "infer" | "meter" | null {
    if (event.type !== "message.received") return null;
    const content = typeof event.message.content === "string" ? event.message.content : "";
    if (content.length > 0) return null;
    if (postCompactInfer) {
      postCompactInfer = false;
      return "infer";
    }
    if (postCompactMeter) {
      postCompactMeter = false;
      return "meter";
    }
    return null;
  }

  // After a successful compact, the provider-reported usage from before the
  // shrink is stale. Re-sync from the compacted turns and treat the local
  // estimate as authoritative until the next real inference.done.
  function notePostCompact(turns: readonly ConversationTurn[]): void {
    syncFromTurns(turns);
    usingEstimate = true;
  }

  return {
    get estimatedTokens(): number {
      return estimate.tokens;
    },
    // True once the provider has omitted or zeroed usage on the current
    // turn, so a status-bar meter reading this can mark itself approximate
    // rather than silently understating a real number.
    get usingEstimate(): boolean {
      return usingEstimate;
    },
    syncFromTurns,
    noteInferenceDone,
    notePostCompact,
    noteIdleTurn,
    interceptActions,
    interceptIdleContinuation,
    interceptOverflow,
    resumeAfterCompact,
  };
}
