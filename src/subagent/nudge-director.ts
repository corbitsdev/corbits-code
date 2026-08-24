/**
 * Sub-agent director: stop policy and stall
 * recovery for quiet leaves.
 */

import { DefaultDirector, type ExtendedInferenceOptions } from "@intx/inference";
import type {
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
  ConversationTurn,
  InferenceOptions,
} from "@intx/types/runtime";
import { createCompactionGovernor, type CompactionGovernor } from "../agent/compaction.js";
import { onTurnBoundary } from "../agent/reactor-events.js";
import { EMPTY_THRASH_STATE, nextThrashState, type ThrashState } from "./thrash.js";
import { NOOP_INTERVENTION_SINK, type InterventionSink } from "./intervention-log.js";
import {
  evaluateSubAgentStop,
  forcedStopReport,
  lastText,
  type ForcedStopReason,
} from "./stop-policy.js";

const TOOL_FAILURE_RECOVERY_NUDGE =
  "A tool call failed. Do not repeat the same failed call unchanged. Inspect the error and current state, then change the arguments or approach. If you cannot recover, report the blocker.";

/** Tool-less mid-run narration after tools, without a report envelope. One-shot. */
const INCOMPLETE_REPORT_NUDGE =
  "Write your final report now using ## Summary, ## Findings, ## Blockers, and ## Paths. Do not narrate status. No more tools unless one lookup is required to cite a line.";

function ephemeralNudgeTurn(text: string): ConversationTurn {
  return {
    role: "user",
    content: [{ type: "text", text }],
    timestamp: Date.now(),
  };
}

const SUBAGENT_STALL_NUDGE =
  "No activity has been observed for a while. If you are waiting on a " +
  "background command, check its status now; otherwise continue working or " +
  "write your report.";

function inferWithSubAgentNudge(capabilities: ReactorCapabilities, text: string): ReactorAction {
  const options: ExtendedInferenceOptions = {
    ephemeralTurns: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }],
  };
  return capabilities.infer(options);
}

/**
 * Attach the wrap-up nudge to an existing infer action's options rather than
 * building a fresh infer — a tool_use turn must be followed by tool_result,
 * never a bare user turn, so the nudge can only ride the infer that follows
 * once the pending tool calls have actually executed.
 */
function withEphemeralNudge(
  options: InferenceOptions | undefined,
  text: string,
): ExtendedInferenceOptions {
  return { ...(options ?? {}), ephemeralTurns: [ephemeralNudgeTurn(text)] };
}

export class SubAgentDirector extends DefaultDirector {
  private readonly compaction: CompactionGovernor;
  /** When true (CritiqueDirector), empty readCounts is not a successful complete. */
  private readonly requireEvidence: boolean;
  private turnsCompleted = 0;
  private thrashState: ThrashState = EMPTY_THRASH_STATE;
  // Armed for failed-tool recovery so the
  // follow-up infer (after pending tool calls from THIS turn have executed)
  // carries the nudge. Cannot attach the nudge to this turn's own infer: the
  // model just emitted tool_use blocks, and every provider requires tool_result
  // before the next turn — a bare nudge here would send an invalid conversation.
  // Survives both proactive compact (interceptActions leaves pending armed) and
  // overflow compact (interceptOverflow re-arms from lastConsumedNudgeText if
  // the infer that consumed pending never completed).
  private pendingNudgeText: string | null = null;
  // The text applyPendingNudge last attached to a returned infer. Overflow of
  // that infer means the model never saw it, so interceptOverflow re-arms
  // pending from this when pending is still null. Cleared on a successful
  // turn boundary so a later overflow cannot resurrect a nudge the model
  // already completed.
  private lastConsumedNudgeText: string | null = null;
  // Soft incomplete-report wrap-up is one-shot per run; a second tool-less
  // narration without the envelope salvages as incomplete-report.
  private incompleteReportNudgeFired = false;

  // Stall management: a leaf that goes quiet (e.g. parked on a long-running
  // background command with nothing else to do) produces no inbound events
  // for the director to react to. The reactor has no proactive "idle" event
  // (directors are pure decide(event, ...) functions — see requestContinuation
  // above), so the run loop periodically pings this same continuation channel
  // and the director only acts on a ping if genuinely nothing happened since
  // the last one. Precedence: this check sits below the turn-boundary stop
  // checks above (evaluateSubAgentStop) — those fire from real inference.done
  // turns and always take priority; stall pings only ever fire on a
  // continuation message that inference.done/tool.done handling did not
  // already consume this cycle.
  private readonly stallTimeoutMs: number | undefined;
  private readonly now: () => number;
  private lastActivityAt: number;
  private consecutiveStalls = 0;
  private lastAssistantText = "";
  // Every stop and nudge is recorded with its measured value beside its
  // threshold, so a later threshold change can cite data instead of judgment
  // (CL-6938). Defaults to a no-op: logging is diagnostic, never required.
  private interventions: InterventionSink = NOOP_INTERVENTION_SINK;
  // Structured stop-reason side channel (CL-6946 part 2): fired synchronously
  // whenever this director force-stops, so the caller learns the reason as a
  // typed value rather than re-parsing the forcedStopReport prose it returns.
  private onForcedStop: (reason: ForcedStopReason) => void = () => {};

  /** Route this leaf's stop/nudge decisions to an intervention log. */
  observeInterventions(sink: InterventionSink): void {
    this.interventions = sink;
  }

  /** Route this leaf's forced-stop reason to the caller as a typed value. */
  observeForcedStop(callback: (reason: ForcedStopReason) => void): void {
    this.onForcedStop = callback;
  }

  /** Run state every intervention record carries, for judging it afterwards. */
  private interventionState(): {
    turnsCompleted: number;
    totalToolCalls: number;
    readCounts: number;
    editedPaths: number;
  } {
    return {
      turnsCompleted: this.turnsCompleted,
      totalToolCalls: this.thrashState.totalToolCalls,
      readCounts: this.thrashState.readCounts.size,
      editedPaths: this.thrashState.editedPaths.size,
    };
  }

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    requestContinuation: (() => void) | undefined,
    stallTimeoutMs?: number,
    now: () => number = Date.now,
    requireEvidence = false,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this.compaction = createCompactionGovernor(requestContinuation, systemPrompt, toolDefinitions);
    this.stallTimeoutMs = stallTimeoutMs;
    this.now = now;
    this.lastActivityAt = now();
    this.requireEvidence = requireEvidence;
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    const afterCompact = this.compaction.resumeAfterCompact(event);
    if (afterCompact !== null) {
      // Compacted history is the live occupancy until the next provider-
      // reported inference.done; paint from the estimate in the meantime.
      this.compaction.notePostCompact(state.turns ?? []);
      // Idle empty compact only needed the decide re-entry to sync the meter;
      // stay idle rather than starting an unprompted inference.
      if (afterCompact === "meter") return capabilities.wait();
      return this.applyPendingNudge([capabilities.infer()], capabilities);
    }
    const idleCompact = this.compaction.interceptIdleContinuation(event, capabilities);
    if (idleCompact !== null) return idleCompact;
    const recovery = this.compaction.interceptOverflow(event, capabilities);
    if (recovery !== null) {
      // The infer that consumed pending never completed, so the model did not
      // see the nudge. Re-arm it for resumeAfterCompact unless a newer wrap-up
      // (or other pending) is already waiting.
      if (this.pendingNudgeText === null && this.lastConsumedNudgeText !== null) {
        this.pendingNudgeText = this.lastConsumedNudgeText;
      }
      return recovery;
    }

    const stallOutcome = this.checkStallPing(event, capabilities);
    if (stallOutcome !== null) return stallOutcome;

    // Keep the running local estimate current on every cycle (tool results and
    // rewrites included). Arming still happens inside noteInferenceDone, which
    // prefers provider usage when present.
    this.compaction.syncFromTurns(state.turns);
    if (onTurnBoundary(event)) {
      this.lastConsumedNudgeText = null;
      this.lastActivityAt = this.now();
      this.consecutiveStalls = 0;
      this.compaction.noteInferenceDone(event, state.turns);
      this.turnsCompleted++;
      const content = event.turn.content as readonly {
        type: string;
        name?: string;
        arguments?: unknown;
        text?: string;
      }[];
      this.lastAssistantText = lastText(content);
      const hasToolCalls = content.some((block) => block.type === "tool_call");
      if (hasToolCalls) {
        this.thrashState = nextThrashState(this.thrashState, content);
      }

      const stop = evaluateSubAgentStop({
        hasToolCalls,
        thrashState: this.thrashState,
        requireEvidence: this.requireEvidence,
        lastAssistantText: this.lastAssistantText,
        incompleteReportNudgeFired: this.incompleteReportNudgeFired,
      });

      if (stop === "complete") {
        const terminal: ReactorAction[] = [
          capabilities.checkpoint("subagent-complete"),
          capabilities.reply(lastText(content)),
        ];
        this.compaction.noteIdleTurn(event, terminal);
        const compacted = this.compaction.interceptActions(event, terminal, capabilities);
        if (compacted !== null) return compacted;
        return terminal;
      }
      if (stop === "incomplete-report") {
        // Tool-less turn after tools, no report envelope. Must not fall through
        // to super.decide — DefaultDirector completes any tool-less turn.
        this.incompleteReportNudgeFired = true;
        this.interventions({
          id: "incomplete-report",
          class: "nudge",
          state: this.interventionState(),
          detail: "tool-less turn after tools with no report envelope",
        });
        return [
          capabilities.checkpoint("subagent-incomplete-report-nudge"),
          inferWithSubAgentNudge(capabilities, INCOMPLETE_REPORT_NUDGE),
        ];
      }
      if (stop === "incomplete-report-stop") {
        this.interventions({
          id: "incomplete-report-stop",
          class: "stop",
          state: this.interventionState(),
          detail: "no report envelope after the wrap-up nudge",
        });
        this.onForcedStop("incomplete-report");
        const terminal: ReactorAction[] = [
          capabilities.checkpoint("subagent-incomplete-report"),
          capabilities.reply(forcedStopReport("incomplete-report", this.lastAssistantText)),
        ];
        this.compaction.noteIdleTurn(event, terminal);
        const compacted = this.compaction.interceptActions(event, terminal, capabilities);
        if (compacted !== null) return compacted;
        return terminal;
      }
    }
    if (event.type === "tool.done") {
      this.lastActivityAt = this.now();
      this.consecutiveStalls = 0;
      if (event.result.isError === true) {
        // Failed-tool recovery guidance.
        this.pendingNudgeText = TOOL_FAILURE_RECOVERY_NUDGE;
        this.interventions({
          id: "tool-failure-recovery",
          class: "nudge",
          state: this.interventionState(),
        });
      }
    }
    const base = await super.decide(event, state, capabilities);
    const baseActions = Array.isArray(base) ? base : [base];
    const compacted = this.compaction.interceptActions(event, baseActions, capabilities);
    if (compacted !== null) return compacted;
    return this.applyPendingNudge(baseActions, capabilities);
  }

  /**
   * Reacts to the periodic stall-check ping (an empty-content continuation,
   * same channel compaction uses to re-enter an idle reactor) started by the
   * run loop when stallTimeoutMs is configured. Only ever sees this event
   * when the reactor is genuinely between cycles — a ping delivered while a
   * tool call is still executing simply queues until that cycle finishes, so
   * "no pending harness-tracked work" falls out of when this method can run
   * at all rather than needing separate bookkeeping.
   *
   * First stall past the timeout: one continuation nudge, asking the leaf to
   * report status or keep going. A second consecutive stall (no activity
   * since the nudge) escalates to the existing salvage path, same shape as
   * the turn-boundary checks above. Returns null when this event is not
   * a stall check the director should act on (let it fall through as an
   * ordinary continuation).
   */
  private checkStallPing(
    event: ReactorInboundEvent,
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (this.stallTimeoutMs === undefined) return null;
    if (event.type !== "message.received") return null;
    const content = event.message.content;
    if (typeof content !== "string" || content.length > 0) return null;
    const elapsed = this.now() - this.lastActivityAt;
    if (elapsed < this.stallTimeoutMs) return null;

    this.consecutiveStalls++;
    if (this.consecutiveStalls === 1) {
      this.interventions({
        id: "stall-nudge",
        class: "nudge",
        measurement: { metric: "silenceMs", value: elapsed, threshold: this.stallTimeoutMs },
        state: this.interventionState(),
      });
      return [
        capabilities.checkpoint("subagent-stall-nudge"),
        inferWithSubAgentNudge(capabilities, SUBAGENT_STALL_NUDGE),
      ];
    }
    this.interventions({
      id: "stalled",
      class: "stop",
      measurement: { metric: "silenceMs", value: elapsed, threshold: this.stallTimeoutMs },
      state: this.interventionState(),
      detail: `no activity for ${Math.round(elapsed / 1000)}s after stall nudge`,
    });
    this.onForcedStop("stalled");
    const terminal: ReactorAction[] = [
      capabilities.checkpoint("subagent-stalled"),
      capabilities.reply(
        forcedStopReport(
          "stalled",
          this.lastAssistantText,
          `no activity for ${Math.round(elapsed / 1000)}s after stall nudge`,
        ),
      ),
    ];
    return terminal;
  }

  /**
   * Rewrite the infer action in a fall-through actions batch to carry the
   * armed nudge, once — this matches the infer after report-forced or
   * failed-tool recovery once pending tool results reach zero.
   */
  private applyPendingNudge(
    actions: ReactorAction[],
    capabilities: ReactorCapabilities,
  ): ReactorAction[] {
    if (this.pendingNudgeText === null) return actions;
    const inferIndex = actions.findIndex((action) => action.type === "infer");
    if (inferIndex === -1) return actions;
    const text = this.pendingNudgeText;
    this.pendingNudgeText = null;
    this.lastConsumedNudgeText = text;
    const existing = actions[inferIndex] as Extract<ReactorAction, { type: "infer" }>;
    const rewritten = [...actions];
    rewritten[inferIndex] = capabilities.infer(withEphemeralNudge(existing.options, text));
    return rewritten;
  }
}
