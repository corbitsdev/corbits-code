import type {
  ConversationTurn,
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
} from "@intx/types/runtime";
import { compactionThresholdFor } from "../provider/context-window.js";
import { hasAgeableImageOutsideWindow } from "../session/compactor.js";

const PRUNING_COMPACTOR_NAME = "pruning-compactor";
const IMAGE_AGING_COMPACTOR_NAME = "image-aging-compactor";
const MIN_TURNS_TO_COMPACT = 6;
const MAX_OVERFLOW_RECOVERIES = 2;

// Shared with the pruning-compactor and image-aging-compactor registrations
// (in the TUI runner and the sub-agent host), so "the recent window" means the
// same thing whether a turn is aged as a pruning anchor, by the standalone
// image-aging compactor, or by this governor's own default.
export const COMPACTION_KEEP_RECENT_TURNS = 6;

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
  keepRecentTurns: number = COMPACTION_KEEP_RECENT_TURNS,
) {
  let pendingCompactor: string | null = null;
  let pendingReason = "";
  let idlePending = false;
  let postCompactInfer = false;
  let overflowRecoveries = 0;

  function noteInferenceDone(
    event: Extract<ReactorInboundEvent, { type: "inference.done" }>,
    turns: readonly ConversationTurn[],
  ): void {
    overflowRecoveries = 0;
    if (requestContinuation === undefined) return;
    const turnCount = turns.length;
    const contextTokens = event.usage?.input ?? 0;
    if (
      contextTokens > compactionThresholdFor(event.source?.model) &&
      turnCount > MIN_TURNS_TO_COMPACT
    ) {
      pendingCompactor = PRUNING_COMPACTOR_NAME;
      pendingReason = "context-threshold";
      return;
    }
    // The pruning compactor also ages images, but only among the anchors it
    // pulls forward once the size threshold above fires. A pasted image in a
    // turn that never becomes an anchor -- because compaction never fires --
    // would otherwise be resent in full for the rest of the session. Arm a
    // dedicated, non-destructive compaction pass for that case so aging does
    // not depend on the conversation ever crossing the size threshold.
    if (pendingCompactor === null && hasAgeableImageOutsideWindow(turns, keepRecentTurns)) {
      pendingCompactor = IMAGE_AGING_COMPACTOR_NAME;
      pendingReason = "image-aging";
    }
  }

  // Compaction waits for the natural pause between a tool batch finishing and
  // the follow-up infer: the infer is dropped from the action set, the compact
  // cycle runs, and the continuation message re-enters inference.
  function interceptActions(
    event: ReactorInboundEvent,
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (pendingCompactor === null || event.type !== "tool.done") return null;
    if (!actions.some((a) => a.type === "infer")) return null;
    const compactor = pendingCompactor;
    const reason = pendingReason;
    pendingCompactor = null;
    postCompactInfer = true;
    requestContinuation?.();
    return [
      ...actions.filter((a) => a.type !== "infer"),
      capabilities.compact(compactor, reason),
    ];
  }

  // Interactive sessions can end a turn with a reply and then sit idle, so a
  // pending compaction would wait indefinitely for the next tool batch. When
  // the turn ends without follow-up work, ask the host for a continuation and
  // compact when it (or the operator's next message) arrives.
  function noteIdleTurn(event: ReactorInboundEvent, actions: ReactorAction[]): void {
    if (pendingCompactor === null || idlePending || requestContinuation === undefined) return;
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
    const compactor = pendingCompactor;
    const reason = pendingReason;
    pendingCompactor = null;
    if (compactor === null) return null;
    const content =
      typeof event.message.content === "string" ? event.message.content : "";
    // An operator message that raced the continuation is already in history;
    // compact first, then request another continuation to answer it.
    if (content.length > 0) {
      postCompactInfer = true;
      requestContinuation?.();
    }
    return [capabilities.compact(compactor, reason)];
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
    pendingCompactor = null;
    postCompactInfer = true;
    requestContinuation();
    return [capabilities.compact(PRUNING_COMPACTOR_NAME, "context-overflow")];
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
    noteInferenceDone,
    noteIdleTurn,
    interceptActions,
    interceptIdleContinuation,
    interceptOverflow,
    resumeAfterCompact,
  };
}
