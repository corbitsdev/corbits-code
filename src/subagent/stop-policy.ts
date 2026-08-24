/**
 * Pure stop / salvage policy for leaf sub-agents: turn budget, thrash,
 * deadlines, and parent-facing salvage reports.
 */

import type { ReactorEmittedEvent } from "@intx/inference";
import { onTurnBoundary } from "../agent/reactor-events.js";
import { evaluateThrashStop, type ThrashConfig, type ThrashState } from "./thrash.js";
import { demoteNestedReportHeadings, formatSubAgentReport, hasReportEnvelope } from "./report.js";

// Minimum gap kept between an opt-in internal deadline and the outer
// tool-execution watchdog, so there is time left for the salvage report to
// unwind and return before the outer watchdog would discard the run wholesale.
export const SUBAGENT_DEADLINE_MARGIN_MS = 30_000;

/**
 * Clamp an explicit opt-in wall-clock deadline to stay a margin below the
 * effective outer tool-execution watchdog. There is no default leaf deadline —
 * maxTurns + operator cancel are the primary bounds; callers pass deadlineMs
 * only when they want an extra wall-clock stop.
 *
 * When the outer watchdog is omitted (undefined), the requested deadline is
 * kept — an absent settings timeout must not clamp a 5-hour (or any) explicit
 * deadline down to a hidden default.
 *
 * Returns undefined (do not arm) when the outer watchdog is at or below the
 * salvage margin — an internal deadline would otherwise race or exceed outer
 * and leave no room to return a salvage report.
 */
export function resolveSubAgentDeadlineMs(
  requestedMs: number,
  outerWatchdogMs: number | undefined,
): number | undefined {
  const requested = Math.max(1, Math.floor(requestedMs));
  if (outerWatchdogMs === undefined) return requested;
  if (outerWatchdogMs <= SUBAGENT_DEADLINE_MARGIN_MS) return undefined;
  // Ceiling must never exceed outer − margin (and stays ≥ 1 once outer > margin).
  const ceiling = Math.max(1, outerWatchdogMs - SUBAGENT_DEADLINE_MARGIN_MS);
  return Math.min(requested, ceiling);
}

/**
 * After agent.send resolves: keep a non-empty reply even if abort fired in the
 * completion window. Empty replies still honor abort so the catch path can
 * salvage from lastPartialText / tools rather than inventing a "no textual result"
 * success over a cancelled run.
 */
export function preferCompletedSubAgentReply(reply: string): "keep-reply" | "honor-abort" {
  return reply.trim().length > 0 ? "keep-reply" : "honor-abort";
}

export type SubAgentCatchOutcome = "salvage-deadline" | "salvage-cancelled" | "rethrow";

/**
 * Decide what a cancelled/aborted sub-agent run should return to the parent.
 * An opt-in deadline firing must always produce a salvage report — even with
 * zero tool calls and zero partial text — so the parent gets a graceful report
 * instead of a bare AbortError racing the outer tool-execution watchdog. A
 * genuine pre-progress operator cancel still rethrows so the task tool's
 * cancel path stays a bare abort; mid-run cancel with progress salvages.
 */
export function resolveSubAgentCatchOutcome(input: {
  deadlineHit: boolean;
  hadProgress: boolean;
}): SubAgentCatchOutcome {
  if (input.deadlineHit) return "salvage-deadline";
  if (input.hadProgress) return "salvage-cancelled";
  return "rethrow";
}

export function subAgentTurnLimitExceeded(turnsCompleted: number, maxTurns: number): boolean {
  return turnsCompleted >= maxTurns;
}

export type SubAgentStopReason =
  "complete" | "turn-budget" | "report-forced" | "incomplete-report" | "incomplete-report-stop";

/**
 * Pure stop decision for leaf workers. Null means keep running tools.
 *
 * "report-forced" and "incomplete-report"
 * are not competing stop reasons — they are one-shot signals telling the
 * caller to inject a wrap-up / redirect nudge and keep running; turn-budget
 * remains reachable afterward. A tool-less turn (including one that never
 * called a tool at all) completes only when the assistant text has a
 * four-heading envelope (Summary, Findings, Blockers, Paths). Omitting
 * `lastAssistantText` still completes (back-compat). Missing envelope nudges
 * once (`incomplete-report`) then salvages (`incomplete-report-stop`).
 * When `requireEvidence` is set (CritiqueDirector), an empty `readCounts`
 * is not complete even with all four headings — same incomplete-report
 * nudge then salvage, so a wrap-up envelope cannot fake a real review.
 */
export function evaluateSubAgentStop(input: {
  hasToolCalls: boolean;
  turnsCompleted: number;
  maxTurns: number;
  /** When set, the near-budget force-report nudge is evaluated after tool-budget checks. */
  thrashState?: ThrashState;
  thrashConfig?: Partial<ThrashConfig>;
  /**
   * When true (CritiqueDirector leaf), a tool-using run that never
   * read or searched a file is not a successful complete — even a four-heading
   * envelope is incomplete-report so the parent does not treat a wrap-up
   * narration as a finished review.
   */
  requireEvidence?: boolean;
  /**
   * Final assistant text of this turn. When omitted, a tool-less turn after
   * tools still completes (back-compat for existing unit tests). When provided,
   * a missing four-heading envelope (Summary/Findings/Blockers/Paths) nudges
   * once then salvages.
   */
  lastAssistantText?: string;
  /** True after the one-shot incomplete-report wrap-up nudge has been injected. */
  incompleteReportNudgeFired?: boolean;
}): SubAgentStopReason | null {
  // A tool-less turn is complete only with a report envelope (or when
  // lastAssistantText is omitted). CritiqueDirector additionally requires at
  // least one read/search in thrashState.readCounts.
  if (!input.hasToolCalls) {
    if (input.lastAssistantText !== undefined && !hasReportEnvelope(input.lastAssistantText)) {
      return input.incompleteReportNudgeFired === true
        ? "incomplete-report-stop"
        : "incomplete-report";
    }
    if (
      input.requireEvidence === true &&
      (input.thrashState === undefined || input.thrashState.readCounts.size === 0)
    ) {
      return input.incompleteReportNudgeFired === true
        ? "incomplete-report-stop"
        : "incomplete-report";
    }
    return "complete";
  }
  if (input.thrashState !== undefined) {
    const thrashStop = evaluateThrashStop({
      hasToolCalls: true,
      turnsCompleted: input.turnsCompleted,
      maxTurns: input.maxTurns,
      ...(input.thrashConfig !== undefined ? { config: input.thrashConfig } : {}),
    });
    if (thrashStop !== null) return thrashStop;
  }

  if (subAgentTurnLimitExceeded(input.turnsCompleted, input.maxTurns)) return "turn-budget";
  return null;
}

// A sub-agent is a worker, not a chat partner: it runs until it stops calling
// tools, at which point its final assistant text is the result handed back to
// the dispatcher. It has no submit_output or ask_operator; consequential
// tools still go through the parent's permission gate (grants, auto mode, or
// prompts). The hard turn budget stops a leaf that would otherwise burn the
// full budget with no parent-visible report. Near the budget the leaf gets a
// one-shot wrap-up nudge (report-forced) rather than a stop, so turn-budget
// stays reachable for a leaf that is genuinely still making progress.

export function lastText(content: readonly { type: string }[]): string {
  for (let i = content.length - 1; i >= 0; i--) {
    const block = content[i] as { type: string; text?: string };
    if (block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

/** Best-effort partial assistant text from a stream event (inference.done). */
export function partialTextFromEvent(event: ReactorEmittedEvent): string | null {
  if (!onTurnBoundary(event)) return null;
  // Stream events nest the turn under data (same shape as hooks/renderer).
  // Guard data.turn so a malformed event cannot throw in the stream sink.
  const turn = event.data?.turn;
  if (turn === undefined || !Array.isArray(turn.content)) return null;
  const text = lastText(turn.content);
  return text.length > 0 ? text : null;
}

export type ForcedStopReason =
  "turn-budget" | "cancelled" | "deadline" | "stalled" | "incomplete-report";

// Exact Summary text rendered for each forced-stop reason. Human-facing only —
// forcedStopReport is the sole reader; the parent classifies outcomes from the
// structured ForcedStopReason value itself (see run.ts/task-tool.ts), never by
// parsing this text back out of the report.
const FORCED_STOP_SUMMARIES: Record<ForcedStopReason, string> = {
  cancelled: "Stopped: cancelled by operator before finishing.",
  deadline: "Stopped: wall-clock deadline reached before finishing.",
  stalled:
    "Stopped after a long silence with no tool activity. The parent can re-dispatch or check the background work directly.",
  "incomplete-report": "Stopped: worker narrated instead of writing a report envelope.",
  "turn-budget": "Turn budget reached before finishing.",
};

/**
 * Build the parent-facing report when a leaf is force-stopped. There is no
 * further inference, so this must already be a full envelope — not an
 * instruction asking the finished worker to summarize. `detail` is the
 * path-specific specifics (turn counts, cancel reason) rendered verbatim on
 * the report's `Stopped:` line so the parent and the TUI see the cause, not
 * just that the worker stopped.
 */
export function forcedStopReport(
  reason: ForcedStopReason,
  partialText: string,
  detail?: string,
): string {
  const summary = FORCED_STOP_SUMMARIES[reason];
  const blockers =
    reason === "cancelled"
      ? "Operator or parent cancelled the worker mid-run; parent may re-dispatch with the partial findings below."
      : reason === "deadline"
        ? "Worker wall-clock deadline elapsed mid-run; parent may re-dispatch with a longer deadline or a narrower scope for the remaining work."
        : reason === "stalled"
          ? "Worker went quiet (e.g. parked on a long-running background command) past the stall timeout after an initial nudge; parent may re-dispatch to finish or check on the background work directly."
          : reason === "incomplete-report"
            ? "Worker ended a tool-using run with a tool-less turn that had no four-heading report envelope (Summary/Findings/Blockers/Paths) after a wrap-up nudge. Findings below are the narration, not a structured report."
            : "Worker turn budget exhausted; parent may re-dispatch for remaining work.";
  // Demote nested report-section headings so runSubAgent's parse/format pass
  // cannot clobber this outer Summary/Blockers with an agent-shaped envelope
  // stuffed into Findings (cancel after a structured partial).
  const findings =
    partialText.trim().length > 0
      ? demoteNestedReportHeadings(partialText.trim())
      : "(no partial findings on the final turn)";
  return formatSubAgentReport({
    summary,
    findings,
    blockers,
    paths: "",
    stopped: detail !== undefined && detail.length > 0 ? `${reason} — ${detail}` : reason,
  });
}

const TURN_BUDGET_PARENT_HINT =
  "[Sub-agent hit its turn budget before finishing. Continue from Findings rather than redoing completed work; re-dispatch with continuation context and a higher maxTurns if more work is warranted.]";

/** After enough same-brief dispatches, stop inviting another maxTurns bump (CL-4343). */
export const TURN_BUDGET_STOP_PARENT_HINT =
  "[Sub-agent hit its turn budget again on the same brief (re-dispatch cap). Stop raising maxTurns on this fingerprint — restate the task, change approach (intent / success_criteria / do_not / prompt / agent), or finish from Findings. Further identical dispatches are still admitted but will not invite more maxTurns bumps.]";

const DEADLINE_PARENT_HINT =
  "[Sub-agent hit an explicit wall-clock deadline before finishing. Continue from Findings rather than redoing completed work; re-dispatch with continuation context and a longer deadline only if more wall-clock time is warranted.]";

/** Options for parent-hint stacking (session re-dispatch ledger state). */
export interface SubAgentParentHintOptions {
  /**
   * 1-based count of how many times this brief fingerprint has been admitted
   * this session (including the run that produced `report`). Used to flip the
   * turn-budget hint after repeated same-brief retries.
   */
  dispatchCount?: number;
  /**
   * After this many total same-brief dispatches, turn-budget salvage recommends
   * stopping rather than raising maxTurns. Defaults to 3 (original + 2 retries).
   */
  turnBudgetStopAfterDispatches?: number;
}

/**
 * Prepend the parent-facing salvage hint for `reason`, chosen from the
 * structured ForcedStopReason the run reported directly — never by parsing
 * `report`'s prose. Reasons with no dedicated hint (cancelled, stalled,
 * incomplete-report, or a normal complete) pass `report` through unchanged.
 */
export function appendSubAgentParentHints(
  report: string,
  reason: ForcedStopReason | undefined,
  options: SubAgentParentHintOptions = {},
): string {
  switch (reason) {
    case "turn-budget": {
      const stopAfter = options.turnBudgetStopAfterDispatches ?? 3;
      const count = options.dispatchCount ?? 1;
      const hint = count >= stopAfter ? TURN_BUDGET_STOP_PARENT_HINT : TURN_BUDGET_PARENT_HINT;
      return `${hint}\n\n${report}`;
    }
    case "deadline":
      return `${DEADLINE_PARENT_HINT}\n\n${report}`;
    default:
      return report;
  }
}
