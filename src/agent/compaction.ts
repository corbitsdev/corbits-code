import type {
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
} from "@intx/types/runtime";
import { compactionThresholdFor } from "../provider/context-window.js";

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
  let postCompactInfer = false;
  let overflowRecoveries = 0;

  function noteInferenceDone(
    event: Extract<ReactorInboundEvent, { type: "inference.done" }>,
    turnCount: number,
  ): void {
    overflowRecoveries = 0;
    if (requestContinuation === undefined) return;
    const contextTokens = event.usage?.input ?? 0;
    if (
      contextTokens > compactionThresholdFor(event.source?.model) &&
      turnCount > MIN_TURNS_TO_COMPACT
    ) {
      pending = true;
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

  return { noteInferenceDone, interceptActions, interceptOverflow, resumeAfterCompact };
}
