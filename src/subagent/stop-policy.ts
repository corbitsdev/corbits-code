/**
 * Pure stop / salvage policy for fleet workers: deadlines and parent-facing
 * salvage reports. No turn budget — a worker runs until it produces a report
 * envelope, is cancelled, hits an opt-in wall-clock deadline, or stalls.
 */

import type { ReactorEmittedEvent } from "@intx/inference";
import { onTurnBoundary } from "../agent/reactor-events.js";
import {
  demoteNestedReportHeadings,
  formatSubAgentReport,
  hasPlanFindings,
  hasReportEnvelope,
  isStubPlanFindings,
} from "./report.js";
import type { ThrashState } from "./thrash.js";

// Keep the opt-in deadline below the outer tool-execution watchdog so a
// salvage report can unwind before the watchdog discards the run wholesale.
export const SUBAGENT_DEADLINE_MARGIN_MS = 30_000;

/**
 * Clamp a wall-clock deadline to a margin below the outer tool-execution
 * watchdog. No watchdog → return the request unchanged; watchdog at or below
 * the margin → undefined (no room to salvage).
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
 * After agent.send resolves, keep a non-empty reply even if abort fired in
 * the completion window. Empty replies honor abort so the catch path salvages
 * from partial text / tools instead of inventing success over a cancelled run.
 */
export function preferCompletedSubAgentReply(
  reply: string,
): "keep-reply" | "honor-abort" {
  return reply.trim().length > 0 ? "keep-reply" : "honor-abort";
}

export type SubAgentCatchOutcome =
  | "salvage-deadline"
  | "salvage-cancelled"
  | "rethrow";

/**
 * Map a cancelled/aborted run to what the parent sees. A fired deadline
 * always salvages, even with zero output, so the parent gets a report instead
 * of a bare AbortError. A pre-progress operator cancel rethrows (spawn_agent's
 * cancel path stays a bare abort); mid-run cancel with progress salvages.
 */
export function resolveSubAgentCatchOutcome(input: {
  deadlineHit: boolean;
  hadProgress: boolean;
}): SubAgentCatchOutcome {
  if (input.deadlineHit) return "salvage-deadline";
  if (input.hadProgress) return "salvage-cancelled";
  return "rethrow";
}

export type SubAgentStopReason =
  | "complete"
  | "incomplete-report"
  | "incomplete-report-stop";

/** Consecutive tool-less narration turns (no envelope) before salvage. */
export const MAX_TOOLLESS_NARRATION_CYCLES = 2;

export type ToolLessNarrationSpiral = "nudge" | "stop";

/** Nudge once, then salvage. `cycles` is 1-based, including the current turn. */
export function evaluateToolLessNarrationSpiral(
  cycles: number,
): ToolLessNarrationSpiral {
  return cycles >= MAX_TOOLLESS_NARRATION_CYCLES ? "stop" : "nudge";
}

/**
 * Pure stop decision for leaf workers. Null means keep running tools.
 *
 * A tool-less turn completes only with a four-heading envelope (Summary,
 * Findings, Blockers, Paths); a missing envelope nudges once
 * (`incomplete-report`) then salvages (`incomplete-report-stop`). With
 * `requireEvidence` (CritiqueDirector), empty `readCounts` is not complete
 * even with all four headings — a wrap-up envelope cannot fake a review.
 * With `requirePlanSubstance` (planner / intent=plan), stub Findings are the
 * same spiral — not a finished plan.
 */
export function evaluateSubAgentStop(input: {
  hasToolCalls: boolean;
  /** CritiqueDirector leaf: a tool-using run that never read a file is incomplete. */
  requireEvidence?: boolean;
  /** Planner / intent=plan: an envelope with stub Findings is not a finished plan. */
  requirePlanSubstance?: boolean;
  /** Read/search bookkeeping for the evidence gate above. */
  thrashState?: ThrashState;
  /** Final assistant text; missing envelope nudges once then salvages. */
  lastAssistantText: string;
  /** 1-based tool-less turn count; falls back to `incompleteReportNudgeFired` when omitted. */
  toolLessNarrationCycles?: number;
  /**
   * @deprecated Prefer `toolLessNarrationCycles`. True after the one-shot
   * incomplete-report wrap-up nudge has been injected.
   */
  incompleteReportNudgeFired?: boolean;
}): SubAgentStopReason | null {
  const spiralCycles =
    input.toolLessNarrationCycles ??
    (input.incompleteReportNudgeFired === true ? 2 : 1);
  const spiralStop = (): SubAgentStopReason =>
    evaluateToolLessNarrationSpiral(spiralCycles) === "stop"
      ? "incomplete-report-stop"
      : "incomplete-report";

  // A tool-less turn is complete only with a report envelope. CritiqueDirector
  // additionally requires at least one read/search (hasEvidence).
  if (!input.hasToolCalls) {
    if (!hasReportEnvelope(input.lastAssistantText)) {
      return spiralStop();
    }
    if (
      input.requireEvidence === true &&
      (input.thrashState === undefined ||
        input.thrashState.readCounts.size === 0)
    ) {
      return spiralStop();
    }
    if (
      input.requirePlanSubstance === true &&
      !hasPlanFindings(input.lastAssistantText)
    ) {
      const afterTools = (input.thrashState?.totalToolCalls ?? 0) > 0;
      if (!afterTools || isStubPlanFindings(input.lastAssistantText)) {
        return spiralStop();
      }
    }
    return "complete";
  }
  return null;
}

// A worker is not a chat partner: it runs until it stops calling tools, and
// its final text is the result handed to the dispatcher. No ask_operator (it
// uses ask_director); consequential tools still pass the parent's permission
// gate.

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
export function partialTextFromEvent(
  event: ReactorEmittedEvent,
): string | null {
  if (!onTurnBoundary(event)) return null;
  // Guard data.turn so a malformed event cannot throw in the stream sink.
  const turn = event.data?.turn;
  if (turn === undefined || !Array.isArray(turn.content)) return null;
  const text = lastText(turn.content);
  return text.length > 0 ? text : null;
}

export type ForcedStopReason =
  | "cancelled"
  | "deadline"
  | "stalled"
  | "incomplete-report"
  | "interrupted";

/** Optional detail / Paths payload for a forced-stop salvage envelope. */
export interface ForcedStopReportOptions {
  /** Path-specific specifics (cancel reason) rendered on the `Stopped:` line. */
  detail?: string;
  /** Edited/read paths for the Paths section (string or list; capped by caller). */
  paths?: string | readonly string[];
}

// Human-facing only — classify via the structured ForcedStopReason, never
// by parsing this text back out of the report.
const FORCED_STOP_SUMMARIES: Record<ForcedStopReason, string> = {
  cancelled: "Stopped: cancelled by operator before finishing.",
  deadline: "Stopped: wall-clock deadline reached before finishing.",
  stalled:
    "Stopped after a long silence with no tool activity. The parent can re-dispatch or check the background work directly.",
  "incomplete-report":
    "Stopped: worker narrated instead of writing a report envelope.",
  interrupted: "Stopped: interrupted before finishing.",
};

const FAIL_THEN_SUCCESSOR_BLOCKERS =
  "Diagnose from Findings; MAY spawn one successor with a changed brief. Do not repeat the same brief. Do not start a diagnostic wave.";

const INTERRUPT_RESUME_BLOCKERS =
  "Parent-initiated pause; the worker is still resumable. Call resume_agent (changed follow-up into retained context) or re-wait. Do not spawn_agent a successor against this still-live session. Successor only if the session is no longer resumable.";

function forcedStopBlockers(reason: ForcedStopReason): string {
  switch (reason) {
    case "cancelled":
      return "Operator or parent cancelled the worker mid-run; synthesize the partial findings below, report Blockers, and wait for the operator.";
    case "deadline":
      return "Worker wall-clock deadline elapsed mid-run; parent may re-dispatch with a longer deadline or a narrower scope for the remaining work.";
    case "stalled":
      return "Worker went quiet (e.g. parked on a long-running background command) past the stall timeout after an initial nudge; parent may re-dispatch to finish this lane or check on the background work directly. Do not start a diagnostic wave.";
    case "interrupted":
      return INTERRUPT_RESUME_BLOCKERS;
    case "incomplete-report":
      return FAIL_THEN_SUCCESSOR_BLOCKERS;
  }
}

function normalizeSalvagePaths(
  paths: ForcedStopReportOptions["paths"],
): string {
  if (paths === undefined) return "";
  if (typeof paths === "string") return paths.trim();
  return paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join("\n");
}

/**
 * Build the parent-facing report when a leaf is force-stopped. No further
 * inference happens, so this must already be a full envelope, not an
 * instruction to summarize. Options carry the cancel `detail` (Stopped line)
 * and salvage `paths` (Paths section).
 */
export function forcedStopReport(
  reason: ForcedStopReason,
  partialText: string,
  options: ForcedStopReportOptions = {},
): string {
  const detail = options.detail;
  const pathText = normalizeSalvagePaths(options.paths);
  const summary = FORCED_STOP_SUMMARIES[reason];
  const blockers = forcedStopBlockers(reason);
  // Demote nested headings so runSubAgent's parse/format pass cannot clobber
  // this outer Summary/Blockers with an agent-shaped envelope in Findings
  // (cancel after a structured partial).
  const trimmed = partialText.trim();
  const findings =
    trimmed.length > 0
      ? demoteNestedReportHeadings(trimmed)
      : pathText.length > 0
        ? `Files touched before stop:\n${pathText}`
        : "(no partial findings on the final turn)";
  return formatSubAgentReport({
    summary,
    findings,
    blockers,
    paths: pathText,
    stopped:
      detail !== undefined && detail.length > 0
        ? `${reason} — ${detail}`
        : reason,
  });
}

const DEADLINE_PARENT_HINT =
  "[Sub-agent hit an explicit wall-clock deadline before finishing. Continue from Findings rather than redoing completed work; re-dispatch with continuation context and a longer deadline only if more wall-clock time is warranted.]";

const CANCELLED_PARENT_HINT =
  "[Sub-agent was cancelled before finishing. Synthesize Findings and Paths rather than redoing completed work; wait for the operator instead of auto-starting another specialist.]";

const FAIL_THEN_SUCCESSOR_PARENT_HINT = `[Sub-agent stopped before finishing. ${FAIL_THEN_SUCCESSOR_BLOCKERS}]`;

const INTERRUPT_RESUME_PARENT_HINT = `[Sub-agent was interrupted before finishing. ${INTERRUPT_RESUME_BLOCKERS}]`;

/** Options for parent-hint stacking (session re-dispatch ledger state). */
export interface SubAgentParentHintOptions {
  /** 1-based count of how many times this brief fingerprint has been admitted this session. */
  dispatchCount?: number;
}

/**
 * Prepend the parent-facing salvage hint for `reason`, chosen from the
 * structured ForcedStopReason the run reported — never by parsing `report`'s
 * prose. Stalled salvage and a normal complete pass `report` unchanged.
 */
export function appendSubAgentParentHints(
  report: string,
  reason: ForcedStopReason | undefined,
  _options: SubAgentParentHintOptions = {},
): string {
  switch (reason) {
    case "deadline":
      return `${DEADLINE_PARENT_HINT}\n\n${report}`;
    case "cancelled":
      return `${CANCELLED_PARENT_HINT}\n\n${report}`;
    case "interrupted":
      return `${INTERRUPT_RESUME_PARENT_HINT}\n\n${report}`;
    case "incomplete-report":
      return `${FAIL_THEN_SUCCESSOR_PARENT_HINT}\n\n${report}`;
    default:
      return report;
  }
}
