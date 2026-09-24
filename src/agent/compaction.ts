import type {
  ConversationTurn,
  LastCycleSource,
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
import {
  COMPACTOR_KEEP_RECENT_TURNS,
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
// The exact turn count `createPruningCompactor` (session/compactor.ts) is
// guaranteed to no-op on. Derived from the same keepRecentTurns both real
// registrations (session, sub-agent) use, so this floor cannot silently
// drift from what the compactor will actually do — arming at or below it
// would spend a reactor cycle that shrinks nothing.
const MIN_TURNS_TO_COMPACT = compactorNoOpFloor(COMPACTOR_KEEP_RECENT_TURNS);
const MAX_OVERFLOW_RECOVERIES = 2;
// Last-ditch bound on compact→infer→compact when the post-compact infer never
// occupies the loop. Reset on tool-call occupancy or when a post-compact
// measurement lands at or under the high watermark (that infer is not itself
// a compact). Do not reset merely because assistant text ≠ spacer. Overflow
// recoveries (above) reset on any successful inference.done instead.
const MAX_CONSECUTIVE_THRESHOLD_COMPACTS = 2;

// A compact action runs in its own reactor cycle, after which the reactor
// idles until the next inbound event. Worker loops (sub-agents, the coding
// director) have no operator to send that next message, so the governor swaps
// the post-tool infer for a compact action, requests a continuation re-entry,
// and re-issues the infer when that message arrives. Without a continuation
// channel the governor stays inert: stalling the loop would be worse than
// growing the context.
export type CompactionGovernor = ReturnType<typeof createCompactionGovernor>;

// Continuation re-entry expressed as a ReactorAction: the reactor emits this
// event on the agent stream and the host answers it with
// buildCompactionContinuationMessage(), the same message the old
// requestContinuation closure delivered. Subscribers that only care about
// provider/connector traffic must ignore this event.
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
  now: () => number = Date.now,
) {
  let pending = false;
  let idlePending = false;
  let manualPending = false;
  // Sticky operator instructions from `/compact …` or `/handoff …`. Empty
  // trailing instructions still fold with the default structured summary; a
  // non-empty argument is kept for later auto-folds and written into the
  // compact record.
  let extraInstructions: string | undefined;
  // Snapshots taken at requestHandoff so cancelManual can restore the
  // pre-pivot idle arming and a prior successful fold's guidance.
  let idlePendingAtHandoff = false;
  let extraInstructionsAtHandoff: string | undefined;
  let postCompactInfer = false;
  // Idle empty compact needs a post-compact decide cycle to adopt the shrunk
  // turns for the meter, but must not start a new inference (there is no
  // operator question to answer). Distinct from postCompactInfer.
  let postCompactMeter = false;
  let overflowRecoveries = 0;
  let consecutiveThresholdCompacts = 0;
  // Set whenever the arming decision fell back to the local estimate because
  // the provider omitted usage or reported zero, so callers rendering a meter
  // can flag the number as approximate instead of implying provider-grade
  // precision.
  let usingEstimate = false;
  let lastModel: string | undefined;
  let turnCount = 0;
  // Wall-clock of the last inference.done: the provider (re)wrote its prefix
  // cache for this session on that turn, so the provider TTL window in
  // provider/cache-ttl.ts is measured from here. Stamped on every
  // inference.done — estimated-usage providers wrote a cache entry too.
  let lastCacheWriteAt: number | undefined;
  // Wall-clock of the last issued compact of any kind. A fresh fold rewrites
  // the session prefix, so the TTL recompress must not fire again inside the
  // same window even when its own cache write has not been observed yet (the
  // summary call bypasses this governor).
  let lastCompactAt: number | undefined;
  // Tool calls issued by the last inference.done and not yet settled. A TTL
  // recompress must never fold while a batch is outstanding — the stall ping
  // that triggers it can arrive mid-work, and folding under it would rewrite
  // turns the pending results still belong to. Assigned (not incremented) on
  // every inference.done so the serial loop self-heals a miscount.
  let outstandingToolCalls = 0;
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
  const estimate = createContextEstimate(
    estimateOverheadTokens(systemPrompt, toolDefinitions),
  );

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
      return (
        contextTokens >=
        tokensAtLastCompact + compactionResumeDeltaFor(lastModel)
      );
    }
    return true;
  }

  function noteCompactIssued(): void {
    awaitingPostCompactMeasurement = true;
    lastCompactAt = now();
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

  // Continuation re-entry for a compact-bearing return. The legacy subagent
  // path still holds a host closure and drives its stall-ping loop through
  // it; the chat path holds none and gets an emit action the host answers
  // with a deliver instead.
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
    // Fail-closed only. ChatDirector owns spacer-echo completeness (nudge, then
    // loop-protection / workflow / open-task rails). This just refuses to treat
    // that incomplete wait or reply as an idle-compact pause.
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
    overflowRecoveries = 0;
    if (event.turn.content.some((block) => block.type === "tool_call")) {
      consecutiveThresholdCompacts = 0;
    }
    syncFromTurns(turns);
    lastModel = event.source?.model;
    lastCacheWriteAt = now();
    // The terminal reply ends the previous tool batch (its results are
    // already in the turns) and opens the batch the reply just issued. A TTL
    // recompress must never fold while a batch is outstanding — the stall
    // ping that triggers it can arrive mid-work, and folding under it would
    // rewrite turns the pending results still belong to. Assigned, not
    // incremented, so the serial loop self-heals a miscount.
    outstandingToolCalls = event.turn.content.filter(
      (block) => block.type === "tool_call",
    ).length;
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
      consecutiveThresholdCompacts = 0;
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
    if (outstandingToolCalls > 0) outstandingToolCalls -= 1;
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

  // Interactive sessions can end a turn with a reply and then sit idle, so a
  // pending compaction would wait indefinitely for the next tool batch. When
  // the turn ends without follow-up work, request a continuation re-entry and
  // compact when it (or the operator's next message) arrives.
  //
  // Single-delivery contract: the closure channel and the boolean return are
  // mutually exclusive, matching continuationActions below. When a legacy
  // closure is installed (the sub-agent path) it fires here and this returns
  // false, so a caller that also honors the return cannot double-deliver.
  // When no closure is installed (the chat path) nothing fires and the return
  // reports whether this call newly armed the idle continuation — the caller
  // must then append compactionContinuationAction to its returned actions.
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
      // The reactor delivers no event after compact, so always request a
      // continuation to re-enter decide against the shrunk turns:
      // - raced operator content → re-infer to answer it
      // - empty synthetic continuation → meter-only sync (no infer)
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
    // Unarmed idle re-entry past the provider TTL: same fold, same
    // keep-recent tail, same cap — but a "cache-ttl-recompress" reason so the
    // fold is attributable. No arming: every live re-entry re-checks the
    // window, so a sub-agent stall ping or operator message is the trigger.
    // In-flight `/compact` (manualPending without idlePending) waits on
    // interceptActions; do not steal that hop with a TTL fold.
    if (manualPending) return null;
    // Cache expiry is a prompt transform, not a fold. Compacting here rewrites
    // turns.jsonl and drops the history the transform is supposed to leave
    // stored. The Anthropic prompt transform stubs tool bodies on the request
    // when this stamp is expired.
    return null;
  }

  // A context-overflow inference error would otherwise terminate the loop
  // with an error reply. Compact and retry, bounded so a history the
  // compactor cannot shrink does not loop forever.
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

  // After a successful compact, the provider-reported usage from before the
  // shrink is stale. Re-sync from the compacted turns and treat the local
  // estimate as authoritative until the next real inference.done.
  function notePostCompact(turns: readonly ConversationTurn[]): void {
    syncFromTurns(turns);
    usingEstimate = true;
    // A fold rewrites the turns: results already applied vanish from the
    // live set, and post-compact stall pings (empty continuations) carry no
    // tool traffic. Reset so a stale count cannot pin the TTL window shut.
    outstandingToolCalls = 0;
  }

  // True while the governor expects the host to answer a continuation emit.
  // The post-compact resume flags are consume-on-hit, so an empty
  // message.received that finds neither set is unsolicited — forged or a
  // replayed duplicate — and answering it would burn a billable inference.
  function hasOutstandingContinuation(): boolean {
    return postCompactInfer || postCompactMeter;
  }

  // `/compact` bypasses the occupancy governor. Same pair-safe compact pipeline
  // as auto-compact: in-flight turns wait for interceptActions / noteIdleTurn;
  // idle sessions arm an empty continuation so the host can kick decide().
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

  // A new process has no in-memory cache write. Seed the stored stamp, the
  // identity that wrote it, and the stored turns so the next message.received
  // can fold before its infer. Turn count is the stored set: the inbound
  // message is appended after this, and the floor is measured without it.
  function restoreCacheWrite(args: {
    at: number;
    source: LastCycleSource;
    turns: readonly ConversationTurn[];
  }): void {
    syncFromTurns(args.turns);
    lastCacheWriteAt = args.at;
    lastModel = args.source.model;
  }

  // `/handoff` folds through the same operator pipeline as above, then starts
  // the next turn immediately: unlike an idle auto-compact (empty synthetic
  // continuation → meter, no infer), the caller delivers the pivot message
  // itself, so the idle arrival slot is always armed and there is no kick
  // case. Busy sessions queue the pivot behind the in-flight batch through
  // the serial send path; whichever boundary fires first — a tool pause
  // (compact-then-continue) or the pivot arrival (fold, then infer) — runs
  // the single operator fold, because firing clears the arming.
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

  // Disarm after a pivot send that never delivered: without this the next
  // operator message would fold unexpectedly. Already-fired or never-armed
  // cancels are no-ops so they cannot restore snapshots over sticky extras or
  // re-arm a spent idle fold. Threshold `pending` is independent of the failed
  // pivot and must still fire at the next tool pause. Restore idlePending and
  // extraInstructions from the requestHandoff snapshots so a cancelled pivot
  // neither invents an idle fold nor wipes a prior successful fold's guidance.
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
    // True once the provider has omitted or zeroed usage on the current
    // turn, so a status-bar meter reading this can mark itself approximate
    // rather than silently understating a real number.
    get usingEstimate(): boolean {
      return usingEstimate;
    },
    get extraInstructions(): string | undefined {
      return extraInstructions;
    },
    get compactTurnCount(): number {
      return turnCount;
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
