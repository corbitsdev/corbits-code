/**
 * Sub-agent director: stop policy and stall
 * recovery for quiet leaves.
 */

import {
  DefaultDirector,
  type ExtendedInferenceOptions,
} from "@intx/inference";
import type {
  ReactorInboundEvent,
  ReactorState,
  ReactorCapabilities,
  ReactorAction,
  ToolDefinition,
  ConversationTurn,
  RetryPolicy,
} from "@intx/types/runtime";
import {
  createCompactionGovernor,
  type CompactionGovernor,
} from "../agent/compaction.js";
import { onTurnBoundary } from "../agent/reactor-events.js";
import { createCorbitsRetryPolicy } from "../agent/retry-policy.js";
import {
  EMPTY_THRASH_STATE,
  nextThrashState,
  salvagePathsFromThrash,
  type ThrashState,
} from "./thrash.js";
import {
  NOOP_INTERVENTION_SINK,
  type InterventionSink,
} from "./intervention-log.js";
import {
  evaluateSubAgentStop,
  forcedStopReport,
  lastText,
  type ForcedStopReason,
} from "./stop-policy.js";
import { hasPlanFindings, hasReportEnvelope } from "./report.js";

const TOOL_FAILURE_RECOVERY_NUDGE =
  "A tool call failed. Do not repeat the same failed call unchanged. Inspect the error and current state, then change the arguments or approach. If you cannot recover, report the blocker.";

/** Tool-less mid-run narration after tools, without a report envelope. One-shot. */
const INCOMPLETE_REPORT_NUDGE =
  "Write your final report now using ## Summary, ## Findings, ## Blockers, and ## Paths. Do not narrate status. No more tools unless one lookup is required to cite a line.";

const PLAN_SUBSTANCE_NUDGE =
  "Findings is not an attachable plan. Fill files/paths, acceptance criteria, non-goals, risks, and ordered steps — each with a concrete non-placeholder line. Do not rewrite the four report headings.";

const STUB_PLAN_SALVAGE_PREFIX =
  "Stub plan Findings (missing files/paths, acceptance criteria, non-goals, risks, or ordered steps). This is not an attachable plan.\n\n";

const VERBATIM_TOOL_CALL_NUDGE =
  "You wrote tool-call markup as assistant text. Invoke the real tool call instead of printing its markup, or write your final report if no tool is needed.";

function hasVerbatimToolCallMarkup(
  content: readonly { type: string; text?: string }[],
): boolean {
  return content.some(
    (block) =>
      block.type === "text" &&
      typeof block.text === "string" &&
      /<tool_call>\s*<(?:function|tool)=[A-Za-z_][\w.-]*>/.test(block.text),
  );
}

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

function inferWithSubAgentNudge(
  capabilities: ReactorCapabilities,
  text: string,
): ReactorAction {
  const options: ExtendedInferenceOptions = {
    ephemeralTurns: [
      {
        role: "user",
        content: [{ type: "text", text }],
        timestamp: Date.now(),
      },
    ],
  };
  return capabilities.infer(options);
}

/**
 * Attach the armed nudge to an existing infer instead of building a fresh
 * one — a tool_use turn must be followed by tool_result, never a bare user
 * turn, so the nudge rides the infer that follows the pending tool calls.
 */
function withEphemeralNudge(
  options: ExtendedInferenceOptions | undefined,
  text: string,
): ExtendedInferenceOptions {
  const turn = ephemeralNudgeTurn(text);
  const existing = options?.ephemeralTurns;
  if (existing === undefined || existing.length === 0) {
    return { ...(options ?? {}), ephemeralTurns: [turn] };
  }
  return { ...(options ?? {}), ephemeralTurns: [...existing, turn] };
}

function isEmptyContinuation(event: ReactorInboundEvent): boolean {
  if (event.type !== "message.received") return false;
  const content = event.message.content;
  return typeof content === "string" && content.length === 0;
}

function isNonEmptyParentMessage(event: ReactorInboundEvent): boolean {
  if (event.type !== "message.received") return false;
  const content = event.message.content;
  return typeof content === "string" && content.length > 0;
}

export class SubAgentDirector extends DefaultDirector {
  private readonly compaction: CompactionGovernor;
  private readonly retryPolicy: RetryPolicy;
  private readonly _systemPrompt: string;
  private advertisedTools: ToolDefinition[];
  /** When true (CritiqueDirector), empty readCounts is not a successful complete. */
  private readonly requireEvidence: boolean;
  /** When true (planner / intent=plan), stub plan Findings is not a complete. */
  private readonly requirePlanSubstance: boolean;
  private turnsCompleted = 0;
  private thrashState: ThrashState = EMPTY_THRASH_STATE;
  // Armed for failed-tool recovery; rides the follow-up infer after this
  // turn's tool calls execute. A bare nudge turn is invalid while tool_use
  // blocks await tool_result. Survives compact: interceptActions leaves it
  // armed, interceptOverflow re-arms from lastConsumedNudgeText.
  private pendingNudgeText: string | null = null;
  // Consecutive failed-tool audits coalesced into one tool-failure-recovery
  // intervention, flushed when applyPendingNudge consumes the nudge.
  private pendingToolFailureRecoveryCount = 0;
  // Text applyPendingNudge last attached to an infer. If that infer
  // overflowed, the model never saw the nudge, so interceptOverflow re-arms
  // pending from this. Cleared on a turn boundary so a late overflow cannot
  // resurrect it.
  private lastConsumedNudgeText: string | null = null;
  // Soft incomplete-report wrap-up is one-shot per run; a second tool-less
  // narration without the envelope salvages as incomplete-report
  // (MAX_TOOLLESS_NARRATION_CYCLES = 2).
  private toolLessNarrationCycles = 0;
  // One nudge per epoch when the assistant prints tool-call markup as text
  // instead of issuing a real tool_call. Cleared by tool activity or a
  // non-empty parent follow-up.
  private verbatimToolCallNudgeFired = false;

  // After a terminal report (complete or salvage), empty idle-compact / stall
  // continuations must not reach DefaultDirector.infer, which re-opens the
  // brief. Cleared only by a non-empty parent message (resume_agent /
  // send_input).
  private reportReplied = false;

  // Live getter from run.ts over askDirectorState.pending: empty stall pings
  // and compact hops wait while the ask is parked, like ChatDirector's
  // unsolicited-empty wait. Unset in tests and non-leaf runs.
  private isAskPending: () => boolean = () => false;

  // A quiet leaf (e.g. parked on a long-running background command) emits
  // no inbound events; directors are pure decide() functions, so the run
  // loop pings this continuation channel periodically. Only a ping with no
  // real activity since the last one is silence. Sits below the
  // turn-boundary stop checks (evaluateSubAgentStop), which take priority.
  private readonly stallTimeoutMs: number | undefined;
  private readonly now: () => number;
  private lastActivityAt: number;
  // tool_call ids from the last inference.done that have not yet seen
  // tool.done; a stall ping mid-execute is not silence.
  private readonly inFlightToolCallIds = new Set<string>();
  // Time of the first stall nudge. Pings inside stallTimeoutMs of it wait
  // without restarting grace; stop only after grace elapses with no activity.
  // Cleared on tool.done / turn-boundary activity.
  private stallNudgeAt: number | undefined;
  private lastAssistantText = "";
  // Records every stop/nudge with measured values beside thresholds, so later
  // threshold changes cite data. No-op by default: logging is diagnostic.
  private interventions: InterventionSink = NOOP_INTERVENTION_SINK;
  // Fired synchronously on force-stop so the caller gets the reason as a
  // typed value instead of re-parsing forcedStopReport prose.
  private onForcedStop: (reason: ForcedStopReason) => void = () => undefined;

  /** Route this leaf's stop/nudge decisions to an intervention log. */
  observeInterventions(sink: InterventionSink): void {
    this.interventions = sink;
  }

  /** Route this leaf's forced-stop reason to the caller as a typed value. */
  observeForcedStop(callback: (reason: ForcedStopReason) => void): void {
    this.onForcedStop = callback;
  }

  /** Live ask_director park flag so empty continuations wait instead of inferring. */
  observeAskPending(isPending: () => boolean): void {
    this.isAskPending = isPending;
  }

  /** Replace the advertised wire set after tool_search / promote-on-execute. */
  updateToolDefinitions(toolDefinitions: ToolDefinition[]): void {
    this.advertisedTools = toolDefinitions;
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
    requirePlanSubstance = false,
    retryPolicy: RetryPolicy = createCorbitsRetryPolicy(),
    toolDisciplineRules?: string,
  ) {
    // Composed before super() like ChatDirectorImpl: the base director sends
    // its own copy, so anything appended after super() never reaches the wire.
    const composedPrompt =
      toolDisciplineRules !== undefined && toolDisciplineRules.length > 0
        ? `${systemPrompt}\n\n${toolDisciplineRules}`
        : systemPrompt;
    super(composedPrompt, toolDefinitions, {});
    this._systemPrompt = composedPrompt;
    this.advertisedTools = toolDefinitions;
    this.compaction = createCompactionGovernor(
      requestContinuation,
      composedPrompt,
      toolDefinitions,
      now,
    );
    this.stallTimeoutMs = stallTimeoutMs;
    this.now = now;
    this.lastActivityAt = now();
    this.requireEvidence = requireEvidence;
    this.requirePlanSubstance = requirePlanSubstance;
    this.retryPolicy = retryPolicy;
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    const infer = capabilities.infer.bind(capabilities);
    capabilities = {
      ...capabilities,
      infer: (options) =>
        infer({
          ...(options ?? {}),
          retryPolicy: options?.retryPolicy ?? this.retryPolicy,
          systemPrompt: options?.systemPrompt ?? this._systemPrompt,
          tools: this.advertisedTools,
        }),
    };
    // A real parent follow-up re-opens the brief; empty continuations do not.
    if (isNonEmptyParentMessage(event)) {
      this.reportReplied = false;
      this.verbatimToolCallNudgeFired = false;
    }

    // A parked ask waits on the parent, not silence: wait before compact
    // resume / stall-nudge so a long park cannot burn a billable infer or
    // consume an outstanding compact continue.
    if (isEmptyContinuation(event) && this.isAskPending()) {
      this.lastActivityAt = this.now();
      this.stallNudgeAt = undefined;
      return capabilities.wait();
    }

    const afterCompact = this.compaction.resumeAfterCompact(event);
    if (afterCompact !== null) {
      // Compacted history is live occupancy until the next inference.done;
      // paint from the estimate in the meantime.
      this.compaction.notePostCompact(state.turns ?? []);
      // An idle empty compact only needed decide re-entry to sync the meter;
      // stay idle rather than starting an unprompted inference. Same after a
      // post-compact resume once this leaf already replied.
      if (afterCompact === "meter" || this.reportReplied)
        return capabilities.wait();
      return this.applyPendingNudge([capabilities.infer()], capabilities);
    }
    const idleCompact = this.compaction.interceptIdleContinuation(
      event,
      capabilities,
    );
    if (idleCompact !== null) return idleCompact;
    const recovery = this.compaction.interceptOverflow(event, capabilities);
    if (recovery !== null) {
      // The consuming infer never completed, so the model never saw the nudge.
      // Re-arm for resumeAfterCompact unless newer pending is waiting.
      if (
        this.pendingNudgeText === null &&
        this.lastConsumedNudgeText !== null
      ) {
        this.pendingNudgeText = this.lastConsumedNudgeText;
      }
      return recovery;
    }

    // After a terminal reply, empty idle-compact / stall pings must not reach
    // DefaultDirector, which always infers on message.received.
    if (this.reportReplied && isEmptyContinuation(event)) {
      return capabilities.wait();
    }

    const stallOutcome = this.checkStallPing(event, capabilities);
    if (stallOutcome !== null) return stallOutcome;
    // Inside the stall window, or with no timeout, an empty continuation is
    // not a model turn. Leave the silence clock alone so real silence can
    // still nudge.
    if (isEmptyContinuation(event)) return capabilities.wait();

    // Keep the local estimate current every cycle (tool results and rewrites
    // included); arming stays in noteInferenceDone, which prefers provider usage.
    this.compaction.syncFromTurns(state.turns);
    if (onTurnBoundary(event)) {
      this.lastConsumedNudgeText = null;
      this.lastActivityAt = this.now();
      this.stallNudgeAt = undefined;
      this.compaction.noteInferenceDone(event, state.turns);
      this.turnsCompleted++;
      const content = event.turn.content as readonly {
        type: string;
        id?: string;
        name?: string;
        arguments?: unknown;
        text?: string;
      }[];
      this.lastAssistantText = lastText(content);
      const hasToolCalls = content.some((block) => block.type === "tool_call");
      if (hasToolCalls) {
        this.toolLessNarrationCycles = 0;
        this.verbatimToolCallNudgeFired = false;
        this.thrashState = nextThrashState(this.thrashState, content);
        for (const block of content) {
          if (block.type === "tool_call" && typeof block.id === "string") {
            this.inFlightToolCallIds.add(block.id);
          }
        }
      }

      // A terminal report must not re-enter the tool-less spiral: consecutive
      // inference.done turns would otherwise re-fire incomplete-report-stop.
      if (this.reportReplied && !hasToolCalls) {
        return capabilities.wait();
      }

      const stop = evaluateSubAgentStop({
        hasToolCalls,
        thrashState: this.thrashState,
        requireEvidence: this.requireEvidence,
        requirePlanSubstance: this.requirePlanSubstance,
        lastAssistantText: this.lastAssistantText,
        toolLessNarrationCycles: this.toolLessNarrationCycles + 1,
      });

      if (stop === "complete") {
        this.reportReplied = true;
        this.flushToolFailureRecoveryAudit();
        const terminal: ReactorAction[] = [
          capabilities.checkpoint("subagent-complete"),
          capabilities.reply(lastText(content)),
        ];
        this.compaction.noteIdleTurn(event, terminal);
        const compacted = this.compaction.interceptActions(
          event,
          terminal,
          capabilities,
        );
        if (compacted !== null) return compacted;
        return terminal;
      }

      // Below the stop policy: a finished report that merely quotes markup
      // still completes; a markup turn with no envelope gets the corrective
      // nudge instead of the generic wrap-up one.
      if (
        !hasToolCalls &&
        !this.verbatimToolCallNudgeFired &&
        hasVerbatimToolCallMarkup(content)
      ) {
        this.verbatimToolCallNudgeFired = true;
        this.interventions({
          id: "verbatim-tool-call",
          class: "nudge",
          state: this.interventionState(),
          detail: "assistant emitted explicit tool-call markup as text",
        });
        return [
          capabilities.checkpoint("subagent-verbatim-tool-call-nudge"),
          inferWithSubAgentNudge(capabilities, VERBATIM_TOOL_CALL_NUDGE),
        ];
      }
      if (stop === "incomplete-report") {
        // Tool-less turn after tools with no envelope; DefaultDirector would
        // complete it, so handle it here.
        this.toolLessNarrationCycles += 1;
        const stubPlan =
          this.requirePlanSubstance &&
          hasReportEnvelope(this.lastAssistantText) &&
          !hasPlanFindings(this.lastAssistantText);
        this.interventions({
          id: "incomplete-report",
          class: "nudge",
          state: this.interventionState(),
          detail: stubPlan
            ? "tool-less turn with stub plan Findings"
            : "tool-less turn after tools with no report envelope",
        });
        return [
          capabilities.checkpoint("subagent-incomplete-report-nudge"),
          inferWithSubAgentNudge(
            capabilities,
            stubPlan ? PLAN_SUBSTANCE_NUDGE : INCOMPLETE_REPORT_NUDGE,
          ),
        ];
      }
      if (stop === "incomplete-report-stop") {
        this.toolLessNarrationCycles += 1;
        const stubPlan =
          this.requirePlanSubstance &&
          hasReportEnvelope(this.lastAssistantText) &&
          !hasPlanFindings(this.lastAssistantText);
        this.interventions({
          id: "incomplete-report-stop",
          class: "stop",
          state: this.interventionState(),
          detail: stubPlan
            ? "stub plan Findings after the wrap-up nudge"
            : "no report envelope after the wrap-up nudge",
        });
        this.onForcedStop("incomplete-report");
        this.reportReplied = true;
        this.flushToolFailureRecoveryAudit();
        const salvageText = stubPlan
          ? `${STUB_PLAN_SALVAGE_PREFIX}${this.lastAssistantText}`
          : this.lastAssistantText;
        const terminal: ReactorAction[] = [
          capabilities.checkpoint("subagent-incomplete-report"),
          capabilities.reply(
            forcedStopReport("incomplete-report", salvageText, {
              paths: salvagePathsFromThrash(this.thrashState),
            }),
          ),
        ];
        this.compaction.noteIdleTurn(event, terminal);
        const compacted = this.compaction.interceptActions(
          event,
          terminal,
          capabilities,
        );
        if (compacted !== null) return compacted;
        return terminal;
      }
    }
    if (event.type === "tool.done" || event.type === "resume.tool_result") {
      this.lastActivityAt = this.now();
      this.stallNudgeAt = undefined;
      this.inFlightToolCallIds.delete(event.result.callId);
      if (event.result.isError === true) {
        // Failed-tool recovery: arm the nudge, count the audit. applyPendingNudge
        // flushes one coalesced record.
        this.pendingNudgeText = TOOL_FAILURE_RECOVERY_NUDGE;
        this.pendingToolFailureRecoveryCount += 1;
      }
    }
    const base = await super.decide(event, state, capabilities);
    const baseActions = Array.isArray(base) ? base : [base];
    const compacted = this.compaction.interceptActions(
      event,
      baseActions,
      capabilities,
    );
    if (compacted !== null) return compacted;
    return this.applyPendingNudge(baseActions, capabilities);
  }

  /**
   * Handle the periodic stall-check ping: an empty-content continuation on
   * the same channel compaction uses to re-enter an idle reactor, started
   * when stallTimeoutMs is configured. In-flight tool calls reset the
   * silence clock and wait instead of nudging.
   *
   * First silence past the timeout: one continuation nudge, record
   * stallNudgeAt. Pings inside the grace wait; stop only after grace
   * with still no activity. Returns null when not yet silence or stall
   * timing is unconfigured, so decide waits without stamping the silence
   * clock.
   */
  private checkStallPing(
    event: ReactorInboundEvent,
    capabilities: ReactorCapabilities,
  ): ReactorAction[] | null {
    if (this.stallTimeoutMs === undefined) return null;
    if (event.type !== "message.received") return null;
    const content = event.message.content;
    if (typeof content !== "string" || content.length > 0) return null;
    if (this.inFlightToolCallIds.size > 0) {
      this.lastActivityAt = this.now();
      this.stallNudgeAt = undefined;
      return [capabilities.wait()];
    }
    const elapsed = this.now() - this.lastActivityAt;
    if (elapsed < this.stallTimeoutMs) return null;

    if (this.stallNudgeAt === undefined) {
      this.stallNudgeAt = this.now();
      this.interventions({
        id: "stall-nudge",
        class: "nudge",
        measurement: {
          metric: "silenceMs",
          value: elapsed,
          threshold: this.stallTimeoutMs,
        },
        state: this.interventionState(),
      });
      return [
        capabilities.checkpoint("subagent-stall-nudge"),
        inferWithSubAgentNudge(capabilities, SUBAGENT_STALL_NUDGE),
      ];
    }

    const sinceNudge = this.now() - this.stallNudgeAt;
    if (sinceNudge < this.stallTimeoutMs) {
      // Post-nudge grace: wait without faking activity or restarting it.
      return [capabilities.wait()];
    }

    this.interventions({
      id: "stalled",
      class: "stop",
      measurement: {
        metric: "silenceMs",
        value: elapsed,
        threshold: this.stallTimeoutMs,
      },
      state: this.interventionState(),
      detail: `no activity for ${Math.round(elapsed / 1000)}s after stall nudge`,
    });
    this.onForcedStop("stalled");
    this.reportReplied = true;
    this.flushToolFailureRecoveryAudit();
    const terminal: ReactorAction[] = [
      capabilities.checkpoint("subagent-stalled"),
      capabilities.reply(
        forcedStopReport("stalled", this.lastAssistantText, {
          detail: `no activity for ${Math.round(elapsed / 1000)}s after stall nudge`,
          paths: salvagePathsFromThrash(this.thrashState),
        }),
      ),
    ];
    return terminal;
  }

  /**
   * Write the coalesced tool-failure-recovery audit when the burst ends —
   * the armed nudge lands on an infer, or the run goes terminal with the
   * nudge undelivered. Without the terminal flush a burst never followed
   * by an infer would vanish from the audit trail.
   */
  private flushToolFailureRecoveryAudit(): void {
    if (this.pendingToolFailureRecoveryCount === 0) return;
    const count = this.pendingToolFailureRecoveryCount;
    this.pendingToolFailureRecoveryCount = 0;
    this.interventions({
      id: "tool-failure-recovery",
      class: "nudge",
      ...(count > 1 ? { count } : {}),
      state: this.interventionState(),
    });
  }

  /**
   * Attach the armed nudge to the infer in a fall-through actions batch —
   * the infer after report-forced or failed-tool recovery, once pending
   * tool results reach zero.
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
    this.flushToolFailureRecoveryAudit();
    const existing = actions[inferIndex] as Extract<
      ReactorAction,
      { type: "infer" }
    >;
    const rewritten = [...actions];
    rewritten[inferIndex] = capabilities.infer(
      withEphemeralNudge(existing.options, text),
    );
    return rewritten;
  }
}
