import type {
  ConversationTurn,
  LastCycleSource,
  ReactorAction,
  ReactorCapabilities,
  ReactorInboundEvent,
  ToolDefinition,
} from "@intx/types/runtime";
import {
  compactionThresholdFor,
  contextTokensFromUsage,
  hasWideResumeGap,
  isAtOrUnderCompactThreshold,
} from "../provider/context-window.js";
import {
  assistantTextIsCompactSpacerEcho,
  compactorNoOpFloor,
  isCompactSpacerEchoTurn,
} from "../session/compactor.js";
import {
  createContextEstimate,
  estimateOverheadTokens,
} from "./context-estimate.js";
import { onTurnBoundary } from "./reactor-events.js";

const COMPACTOR_NAME = "pruning-compactor";
// The compactor's no-op floor, derived from the same helper so it cannot
// drift; arming at or below it would spend a reactor cycle that shrinks
// nothing.
const MIN_TURNS_TO_COMPACT = compactorNoOpFloor();
// Bound on context-overflow retries so an unshrinkable history cannot loop
// forever; cleared when usage lands back under the watermark.
const MAX_OVERFLOW_RECOVERIES = 2;
// Consecutive threshold compacts with no under-watermark relief; tool-call
// occupancy does not reset it, or every few tool messages re-enable the loop.
const MAX_CONSECUTIVE_THRESHOLD_COMPACTS = 2;

// A compact runs in its own reactor cycle with no event after it, and worker
// loops have no operator to send the next one. The governor swaps the
// post-tool infer for a compact and requests a continuation re-entry that
// re-issues the infer; without it the loop stalls, which is worse than
// growing the context.
export type CompactionGovernor = ReturnType<typeof createCompactionGovernor>;

// Re-entry after a compact cycle, as a ReactorAction the host answers with
// buildCompactionContinuationMessage() (what the old requestContinuation
// closure delivered). Subscribers that only watch provider traffic ignore it.
export const COMPACTION_CONTINUATION_EVENT = "custom.compaction.continue";
/** Compact reason for `/compact` and `/handoff` (operator-triggered folds). */
export const OPERATOR_COMPACT_REASON = "operator-request";
const THRESHOLD_COMPACT_REASON = "context-threshold";

/** How `/compact` armed the shared pipeline. */
export type ManualCompactArming = "kick" | "armed" | "noop";

/** Options for an operator-triggered compact. */
export type ManualCompactOptions = {
  inFlight?: boolean;
  /** Live or restored turns; used to arm after resume before the first decide. */
  turns?: readonly ConversationTurn[];
};

/** How `/handoff` armed the shared fold pipeline. */
export type HandoffArming = "armed" | "noop";

type CompactRecordLike = {
  strategy?: string;
  parameters?: Record<string, unknown>;
};

function extraInstructionsFromCompactRecord(
  record: CompactRecordLike,
): string | undefined {
  if (record.strategy !== COMPACTOR_NAME) return undefined;
  const extra = record.parameters?.extraInstructions;
  if (typeof extra !== "string") return undefined;
  const trimmed = extra.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/** Newest-commit-first: first pruning-compactor extraInstructions wins. */
export function stickyExtraInstructionsFromRecords(
  records: readonly CompactRecordLike[],
): string | undefined {
  for (const record of records) {
    const extra = extraInstructionsFromCompactRecord(record);
    if (extra !== undefined) return extra;
  }
  return undefined;
}

export function compactFloorNoopNotice(instructions: string): string {
  return instructions.trim().length > 0
    ? "Nothing to compact yet. Instructions were not saved."
    : "Nothing to compact yet.";
}

/** Operator-facing notice after a fold whose post-compact occupancy is still over threshold. */
export function foldNonConvergedNotice(): string {
  return "Context fold did not reduce occupancy below the compact threshold. Further automatic folds are paused until usage drops.";
}

/** Run-record `provider:model` (or slash form) as a LastCycleSource. */
export function lastCycleSourceFromRunModel(
  model: string | undefined,
): LastCycleSource | undefined {
  if (model === undefined || model.length === 0) return undefined;
  const colon = model.indexOf(":");
  if (colon > 0) {
    const provider = model.slice(0, colon);
    const rest = model.slice(colon + 1);
    return {
      sourceId: model,
      provider,
      model: rest.length > 0 ? rest : model,
    };
  }
  const slash = model.indexOf("/");
  if (slash > 0) {
    return { sourceId: model, provider: model.slice(0, slash), model };
  }
  return { sourceId: model, provider: model, model };
}

/** Build the continuation re-entry action for a compacted governor cycle. */
export function compactionContinuationAction(
  capabilities: ReactorCapabilities,
): ReactorAction {
  return capabilities.emit(COMPACTION_CONTINUATION_EVENT, {});
}

export function createCompactionGovernor(
  requestContinuation?: () => void,
  systemPrompt = "",
  toolDefinitions: readonly ToolDefinition[] = [],
  _now: () => number = Date.now,
) {
  let pending = false;
  let idlePending = false;
  let manualPending = false;
  // Sticky operator instructions from `/compact …` or `/handoff …`: empty
  // trailing still folds with the default summary, non-empty is kept for
  // auto-folds and the compact record.
  let extraInstructions: string | undefined;
  // Snapshots taken at requestHandoff so cancelManual can restore the
  // pre-pivot idle arming and a prior successful fold's guidance.
  let idlePendingAtHandoff = false;
  let extraInstructionsAtHandoff: string | undefined;
  let postCompactInfer = false;
  // Idle empty compact re-enters decide only to adopt the shrunk turns for
  // the meter, never to infer. Distinct from postCompactInfer.
  let postCompactMeter = false;
  let overflowRecoveries = 0;
  let consecutiveThresholdCompacts = 0;
  // True when the arming decision fell back to the local estimate (usage
  // omitted or zero), so a meter can flag the number as approximate.
  let usingEstimate = false;
  let lastModel: string | undefined;
  let turnCount = 0;
  // Growth latch: snapshot the first inference.done after a compact and only
  // re-arm on a wide resume gap past it. Every compact sets it;
  // under-threshold folds keep it.
  let tokensAtLastCompact: number | undefined;
  let awaitingPostCompactMeasurement = false;
  // Still-over fold: the growth latch holds (small growth does not re-arm)
  // but the consecutive cap is spent immediately, so the fold reports
  // non-convergence instead of saw-toothing on the wide-gap re-arm.
  let foldNonConverged = false;

  // Running local estimate of the turns plus fixed prompt/tool overhead.
  // Fills the gap when the provider omits usage; provider usage is preferred
  // so a coarse local count cannot thrash a trustworthy signal.
  const estimate = createContextEstimate(
    estimateOverheadTokens(systemPrompt, toolDefinitions),
  );

  // Re-sync after turn appends, tool results, and compaction rewrites;
  // callers pass the full list so no incremental bookkeeping.
  function syncFromTurns(turns: readonly ConversationTurn[]): number {
    turnCount = turns.length;
    return estimate.syncFromTurns(turns);
  }

  function isOverThreshold(contextTokens: number): boolean {
    if (turnCount <= MIN_TURNS_TO_COMPACT) return false;
    const high = compactionThresholdFor(lastModel);
    if (contextTokens <= high) return false;
    if (tokensAtLastCompact !== undefined) {
      return hasWideResumeGap(tokensAtLastCompact, contextTokens, lastModel);
    }
    return true;
  }

  function noteCompactIssued(): void {
    awaitingPostCompactMeasurement = true;
  }

  function atThresholdCompactCap(): boolean {
    return consecutiveThresholdCompacts >= MAX_CONSECUTIVE_THRESHOLD_COMPACTS;
  }

  function issueThresholdCompact(): void {
    consecutiveThresholdCompacts++;
    noteCompactIssued();
  }

  function compactReason(operator: boolean): string {
    return operator ? OPERATOR_COMPACT_REASON : THRESHOLD_COMPACT_REASON;
  }

  function clearManualArming(): void {
    manualPending = false;
    idlePending = false;
    pending = false;
  }

  // Re-entry after a compact. The legacy subagent path holds the host closure
  // and drives its stall-ping loop through it; the chat path gets an emit
  // action the host answers with a deliver.
  function continuationActions(
    capabilities: ReactorCapabilities,
  ): ReactorAction[] {
    if (requestContinuation !== undefined) {
      requestContinuation();
      return [];
    }
    return [compactionContinuationAction(capabilities)];
  }

  function isSpacerEchoTerminal(
    event: ReactorInboundEvent,
    actions: ReactorAction[],
  ): boolean {
    // Fail-closed only: ChatDirector owns spacer-echo completeness; this just
    // refuses to treat an incomplete wait or reply as an idle-compact pause.
    if (event.type === "inference.done" && isCompactSpacerEchoTurn(event.turn))
      return true;
    return actions.some(
      (a) => a.type === "reply" && assistantTextIsCompactSpacerEcho(a.content),
    );
  }

  function noteInferenceDone(
    event: Extract<ReactorInboundEvent, { type: "inference.done" }>,
    turns: readonly ConversationTurn[],
  ): void {
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
      if (!isAtOrUnderCompactThreshold(contextTokens, lastModel)) {
        foldNonConverged = true;
        consecutiveThresholdCompacts = MAX_CONSECUTIVE_THRESHOLD_COMPACTS;
      }
    }
    // Fold evidence: usage back at or under the threshold restores both rails
    // (consecutive compacts, overflow recoveries) and clears foldNonConverged;
    // the growth latch stays. Nothing else resets the rails, or
    // compact→infer→compact would loop forever.
    if (isAtOrUnderCompactThreshold(contextTokens, lastModel)) {
      consecutiveThresholdCompacts = 0;
      overflowRecoveries = 0;
      foldNonConverged = false;
    }
    // Assign, don't OR: an under-threshold follow-up must disarm a sticky
    // pending left from an earlier over-threshold turn.
    pending = isOverThreshold(contextTokens);
  }

  // Compact at the natural pause between a tool batch and its follow-up
  // infer: drop the infer, run the compact, and re-enter inference via the
  // continuation. `pending` is the last inference.done snapshot —
  // authoritative with real provider usage; with omitted usage it came from
  // the estimate, so re-derive against the live estimate instead of trusting
  // a `pending` stale by one tool batch.
  function interceptActions(
    event: ReactorInboundEvent,
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (event.type !== "tool.done") return null;
    const operator = manualPending;
    if (
      !operator &&
      !pending &&
      !(usingEstimate && isOverThreshold(estimate.tokens))
    )
      return null;
    if (!actions.some((a) => a.type === "infer")) return null;
    if (!operator && atThresholdCompactCap()) return null;
    clearManualArming();
    postCompactInfer = true;
    if (operator) noteCompactIssued();
    else issueThresholdCompact();
    return [
      ...actions.filter((a) => a.type !== "infer"),
      capabilities.compact(COMPACTOR_NAME, compactReason(operator)),
      ...continuationActions(capabilities),
    ];
  }

  // An interactive turn can end with a reply and sit idle; a pending compact
  // would then wait for a tool batch forever. When the turn ends without
  // follow-up work, arm a continuation re-entry and compact when it (or the
  // next operator message) arrives.
  //
  // Single-delivery: the closure channel and the boolean return are mutually
  // exclusive, matching continuationActions. With a legacy closure it fires
  // here and returns false (a caller honoring the return cannot
  // double-deliver); without one the return says whether this call newly
  // armed the idle continuation and the caller appends the emit action.
  function noteIdleTurn(
    event: ReactorInboundEvent,
    actions: ReactorAction[],
  ): boolean {
    if (idlePending) return false;
    const operator = manualPending;
    if (!operator && !pending) return false;
    if (!operator && atThresholdCompactCap()) return false;
    if (!onTurnBoundary(event)) return false;
    if (isSpacerEchoTerminal(event, actions)) return false;
    const terminal =
      actions.some((a) => a.type === "reply" || a.type === "wait") &&
      !actions.some((a) => a.type === "infer" || a.type === "execute_tools");
    if (!terminal) return false;
    idlePending = true;
    if (requestContinuation !== undefined) {
      requestContinuation();
      return false;
    }
    return true;
  }

  function inboundText(event: ReactorInboundEvent): string {
    if (event.type !== "message.received") return "";
    return typeof event.message.content === "string"
      ? event.message.content
      : "";
  }

  // Idle empty compact needs a meter-only re-entry; a raced operator message
  // needs a follow-up infer. Shared by the threshold idle path and TTL fold.
  function issueIdleFold(
    content: string,
    capabilities: ReactorCapabilities,
    reason: string,
  ): ReactorAction[] {
    if (content.length > 0) postCompactInfer = true;
    else postCompactMeter = true;
    issueThresholdCompact();
    return [
      capabilities.compact(COMPACTOR_NAME, reason),
      ...continuationActions(capabilities),
    ];
  }

  function interceptIdleContinuation(
    event: ReactorInboundEvent,
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (event.type !== "message.received") return null;
    if (idlePending) {
      const operator = manualPending;
      if (!operator && atThresholdCompactCap()) {
        idlePending = false;
        return null;
      }
      clearManualArming();
      const content = inboundText(event);
      // No event arrives after compact, so always request a continuation to
      // re-enter decide: raced operator content re-infers, empty synthetic
      // continuation only syncs the meter.
      if (operator) {
        if (content.length > 0) postCompactInfer = true;
        else postCompactMeter = true;
        noteCompactIssued();
        return [
          capabilities.compact(COMPACTOR_NAME, OPERATOR_COMPACT_REASON),
          ...continuationActions(capabilities),
        ];
      }
      return issueIdleFold(content, capabilities, THRESHOLD_COMPACT_REASON);
    }
    // Cache expiry is a prompt transform, not a fold: compacting on an
    // unarmed re-entry would drop history the transform leaves stored (it
    // stubs tool bodies on the outgoing request instead).
    return null;
  }

  // A context-overflow error would terminate the loop; compact and retry,
  // bounded so an unshrinkable history does not loop forever.
  function interceptOverflow(
    event: ReactorInboundEvent,
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (
      event.type !== "inference.error" ||
      event.error.category !== "context_overflow"
    ) {
      return null;
    }
    if (overflowRecoveries >= MAX_OVERFLOW_RECOVERIES) return null;
    overflowRecoveries++;
    // Overflow compact spends any operator arming so a queued handoff
    // pivot cannot fold again after this recovery. Sticky extras stay.
    clearManualArming();
    postCompactInfer = true;
    noteCompactIssued();
    return [
      capabilities.compact(COMPACTOR_NAME, "context-overflow"),
      ...continuationActions(capabilities),
    ];
  }

  // After compact, a content-less continuation re-enters decide. "infer" means
  // resume the interrupted loop; "meter" means adopt the shrunk turns for the
  // Ctx display and stay idle (idle empty compact has nothing to answer).
  function resumeAfterCompact(
    event: ReactorInboundEvent,
  ): "infer" | "meter" | null {
    if (event.type !== "message.received") return null;
    if (inboundText(event).length > 0) return null;
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

  // Pre-shrink provider usage is stale; re-sync from the compacted turns and
  // treat the local estimate as authoritative until the next inference.done.
  function notePostCompact(turns: readonly ConversationTurn[]): void {
    syncFromTurns(turns);
    usingEstimate = true;
  }

  // True while the host owes a continuation answer. The resume flags are
  // consume-on-hit, so an empty message that finds neither set is unsolicited
  // (forged or replayed) — answering it would burn a billable inference.
  function hasOutstandingContinuation(): boolean {
    return postCompactInfer || postCompactMeter;
  }

  // `/compact` bypasses the occupancy governor but shares the fold pipeline:
  // in-flight turns wait for the tool pause; idle sessions arm an empty
  // continuation so the host can kick decide().
  function requestManual(
    instructions: string,
    options?: ManualCompactOptions,
  ): ManualCompactArming {
    if (options?.turns !== undefined) syncFromTurns(options.turns);
    if (turnCount <= MIN_TURNS_TO_COMPACT) return "noop";
    const trimmed = instructions.trim();
    if (trimmed.length > 0) extraInstructions = trimmed;
    // A compact is already in flight (apply-to-meter or post-compact infer).
    // Keep sticky instructions but do not kick a second fold.
    if (hasOutstandingContinuation()) return "armed";
    manualPending = true;
    if (options?.inFlight === true) return "armed";
    if (idlePending) return "armed";
    idlePending = true;
    if (requestContinuation !== undefined) {
      requestContinuation();
      return "armed";
    }
    return "kick";
  }

  function restoreExtraInstructions(value: string | undefined): void {
    const trimmed = value?.trim();
    if (trimmed === undefined || trimmed.length === 0) return;
    extraInstructions = trimmed;
  }

  // A new process has no in-memory turn count. Seed the stored turns so
  // threshold and manual compact see the resumed history.
  function restoreCacheWrite(args: {
    at: number;
    source: LastCycleSource;
    turns: readonly ConversationTurn[];
  }): void {
    void args.at;
    syncFromTurns(args.turns);
    lastModel = args.source.model;
  }

  // `/handoff` folds through the same pipeline, then starts the next turn
  // immediately: the caller delivers the pivot itself, so the idle slot is
  // always armed and there is no kick case. The pivot queues behind an
  // in-flight batch; whichever boundary fires first runs the single operator
  // fold, since firing clears the arming.
  function requestHandoff(instructions: string): HandoffArming {
    if (turnCount <= MIN_TURNS_TO_COMPACT) return "noop";
    // Snapshot only the committed pre-pivot state. A second request while still
    // armed replaces the pending extras; cancel must not restore the first
    // uncommitted pivot.
    if (!manualPending) {
      idlePendingAtHandoff = idlePending;
      extraInstructionsAtHandoff = extraInstructions;
    }
    const trimmed = instructions.trim();
    extraInstructions = trimmed.length > 0 ? trimmed : undefined;
    manualPending = true;
    idlePending = true;
    if (requestContinuation !== undefined) {
      requestContinuation();
    }
    return "armed";
  }

  // Disarm after a pivot that never delivered; already-fired or never-armed
  // cancels no-op. Threshold `pending` is independent of the pivot and must
  // still fire at the next tool pause. Restore idlePending and
  // extraInstructions from the snapshots so a cancelled pivot neither invents
  // an idle fold nor wipes a prior fold's guidance.
  function cancelManual(): void {
    if (!manualPending) return;
    const thresholdPending = pending;
    clearManualArming();
    pending = thresholdPending;
    idlePending = idlePendingAtHandoff;
    extraInstructions = extraInstructionsAtHandoff;
  }

  return {
    get estimatedTokens(): number {
      return estimate.tokens;
    },
    // Lets a status-bar meter mark itself approximate instead of
    // understating a real number.
    get usingEstimate(): boolean {
      return usingEstimate;
    },
    get extraInstructions(): string | undefined {
      return extraInstructions;
    },
    get compactTurnCount(): number {
      return turnCount;
    },
    get foldNonConverged(): boolean {
      return foldNonConverged;
    },
    requestManual,
    restoreExtraInstructions,
    restoreCacheWrite,
    requestHandoff,
    cancelManual,
    syncFromTurns,
    noteInferenceDone,
    notePostCompact,
    noteIdleTurn,
    interceptActions,
    interceptIdleContinuation,
    interceptOverflow,
    resumeAfterCompact,
    hasOutstandingContinuation,
  };
}
