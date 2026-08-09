/**
 * Sub-agent director: stop policy, wrap-up nudge near turn budget, and stall
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
import {
  EMPTY_THRASH_STATE,
  nextThrashState,
  type ThrashState,
} from "./thrash.js";
import {
  DEFAULT_SUBAGENT_REPEAT_LIMIT,
  evaluateSubAgentStop,
  fingerprintToolCalls,
  forcedStopReport,
  lastText,
  nextToolCallStreak,
  type ToolCallStreak,
} from "./stop-policy.js";

const REPORT_FORCED_WRAP_UP_NUDGE =
  "You are close to your turn budget. Stop calling tools and write your final report now: summarize what you did, your findings, and any blockers.";

/** Implement leaves: soft re-read pressure should push toward edit or wrap-up. */
const RE_READ_NUDGE_IMPLEMENT =
  "You are re-reading the same paths without finishing. Edit a file to make progress, or stop tooling and write your final report now.";

/**
 * Explore / non-implement leaves: same soft re-read pressure, but do not force
 * edit behavior — expand findings, change approach, or report.
 */
const RE_READ_NUDGE_EXPLORE =
  "You are re-reading the same paths. Expand Findings, change approach, or write your final report — do not keep re-reading the same files.";

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
    ephemeralTurns: [
      { role: "user", content: [{ type: "text", text }], timestamp: Date.now() },
    ],
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
  private readonly maxTurns: number;
  private readonly repeatLimit: number;
  /** When true (intent=implement), tool-less finish without edits salvages as never-edited. */
  private readonly requireEdit: boolean;
  private turnsCompleted = 0;
  private everHadToolCalls = false;
  private streak: ToolCallStreak = {
    lastFingerprint: undefined,
    consecutiveIdentical: 0,
  };
  private thrashState: ThrashState = EMPTY_THRASH_STATE;
  // Set on a report-forced or re-read-nudge turn so the follow-up infer (after
  // the pending tool calls from THIS turn have executed) carries the nudge.
  // Cannot attach the nudge to this turn's own infer: the model just emitted
  // tool_use blocks, and every provider requires tool_result before the next
  // turn — a bare nudge here would send an invalid conversation.
  private pendingNudgeText: string | null = null;
  // Soft re-read-nudge is one-shot per run; thrash hard-stop still fires later
  // if the leaf ignores it and keeps re-reading.
  private reReadNudgeFired = false;

  // Stall management: a leaf that goes quiet (e.g. parked on a long-running
  // background command with nothing else to do) produces no inbound events
  // for the director to react to. The reactor has no proactive "idle" event
  // (directors are pure decide(event, ...) functions — see requestContinuation
  // above), so the run loop periodically pings this same continuation channel
  // and the director only acts on a ping if genuinely nothing happened since
  // the last one. Precedence: this check sits below no-progress / thrash /
  // turn-budget (evaluateSubAgentStop, above) — those fire from real
  // inference.done turns and always take priority; stall pings only ever
  // fire on a continuation message that inference.done/tool.done handling
  // did not already consume this cycle.
  private readonly stallTimeoutMs: number | undefined;
  private readonly now: () => number;
  private lastActivityAt: number;
  private consecutiveStalls = 0;
  private lastAssistantText = "";

  constructor(
    systemPrompt: string,
    toolDefinitions: ToolDefinition[],
    requestContinuation: (() => void) | undefined,
    maxTurns: number,
    repeatLimit: number = DEFAULT_SUBAGENT_REPEAT_LIMIT,
    stallTimeoutMs?: number,
    now: () => number = Date.now,
    requireEdit: boolean = false,
  ) {
    super(systemPrompt, toolDefinitions, {});
    this.compaction = createCompactionGovernor(requestContinuation, systemPrompt, toolDefinitions);
    this.maxTurns = maxTurns;
    this.repeatLimit = repeatLimit;
    this.stallTimeoutMs = stallTimeoutMs;
    this.now = now;
    this.lastActivityAt = now();
    this.requireEdit = requireEdit;
  }

  override async decide(
    event: ReactorInboundEvent,
    state: ReactorState,
    capabilities: ReactorCapabilities,
  ): Promise<ReactorAction | ReactorAction[]> {
    if (this.compaction.resumeAfterCompact(event)) {
      return capabilities.infer();
    }
    const idleCompact = this.compaction.interceptIdleContinuation(event, capabilities);
    if (idleCompact !== null) return idleCompact;
    const recovery = this.compaction.interceptOverflow(event, capabilities);
    if (recovery !== null) return recovery;

    const stallOutcome = this.checkStallPing(event, capabilities);
    if (stallOutcome !== null) return stallOutcome;

    // Keep the running local estimate current on every cycle (tool results and
    // rewrites included). Arming still happens inside noteInferenceDone, which
    // prefers provider usage when present.
    this.compaction.syncFromTurns(state.turns);
    if (onTurnBoundary(event)) {
      this.lastActivityAt = this.now();
      this.consecutiveStalls = 0;
      this.compaction.noteInferenceDone(event, state.turns);
      this.turnsCompleted++;
      const content = event.turn.content as ReadonlyArray<{
        type: string;
        name?: string;
        arguments?: unknown;
        text?: string;
      }>;
      this.lastAssistantText = lastText(content);
      const fingerprint = fingerprintToolCalls(content);
      this.streak = nextToolCallStreak(this.streak, fingerprint);
      const hasToolCalls = fingerprint !== null;
      if (hasToolCalls) {
        this.everHadToolCalls = true;
        this.thrashState = nextThrashState(this.thrashState, content);
      }

      const stop = evaluateSubAgentStop({
        hasToolCalls,
        everHadToolCalls: this.everHadToolCalls,
        turnsCompleted: this.turnsCompleted,
        maxTurns: this.maxTurns,
        consecutiveIdentical: this.streak.consecutiveIdentical,
        repeatLimit: this.repeatLimit,
        thrashState: this.thrashState,
        requireEdit: this.requireEdit,
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
      if (stop === "report-forced") {
        // Not a stop: let the pending tool calls execute as normal (deferring
        // to super.decide below), and arm the nudge for the infer that
        // follows once their results land. Turn-budget stays reachable —
        // this fires once, forceReportWithin turns before the cap.
        this.pendingNudgeText = REPORT_FORCED_WRAP_UP_NUDGE;
      } else if (stop === "re-read-nudge") {
        // Soft mid-run redirect (CL-5813). One-shot; hard thrash still stops
        // the leaf if re-read pressure keeps climbing after the nudge.
        if (!this.reReadNudgeFired) {
          this.reReadNudgeFired = true;
          this.pendingNudgeText = this.requireEdit
            ? RE_READ_NUDGE_IMPLEMENT
            : RE_READ_NUDGE_EXPLORE;
        }
      } else if (
        stop === "no-progress" ||
        stop === "turn-budget" ||
        stop === "never-acted" ||
        stop === "never-edited" ||
        stop === "thrash"
      ) {
        const checkpoint =
          stop === "no-progress"
            ? "subagent-no-progress"
            : stop === "never-acted"
              ? "subagent-never-acted"
              : stop === "never-edited"
                ? "subagent-never-edited"
                : stop === "thrash"
                  ? "subagent-thrash"
                  : "subagent-turn-budget";
        const terminal: ReactorAction[] = [
          capabilities.checkpoint(checkpoint),
          capabilities.reply(forcedStopReport(stop, lastText(content))),
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
    }
    const base = await super.decide(event, state, capabilities);
    const actions = this.applyPendingNudge(
      Array.isArray(base) ? base : [base],
      capabilities,
    );
    return this.compaction.interceptActions(event, actions, capabilities) ?? actions;
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
   * no-progress/turn-budget/thrash above. Returns null when this event is not
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
      return [
        capabilities.checkpoint("subagent-stall-nudge"),
        inferWithSubAgentNudge(capabilities, SUBAGENT_STALL_NUDGE),
      ];
    }
    const terminal: ReactorAction[] = [
      capabilities.checkpoint("subagent-stalled"),
      capabilities.reply(forcedStopReport("stalled", this.lastAssistantText)),
    ];
    return terminal;
  }

  /**
   * Rewrite the infer action in a fall-through actions batch to carry the
   * armed nudge, once — this only ever matches the infer that follows a
   * report-forced or re-read-nudge turn's tool results (super.decide only emits
   * infer once pendingToolResults reaches zero).
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
    const existing = actions[inferIndex] as Extract<ReactorAction, { type: "infer" }>;
    const rewritten = [...actions];
    rewritten[inferIndex] = capabilities.infer(withEphemeralNudge(existing.options, text));
    return rewritten;
  }
}
