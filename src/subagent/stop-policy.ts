/**
 * Pure stop / salvage policy for fleet workers: deadlines and parent-facing
 * salvage reports. There is no turn budget — a worker runs until it produces a
 * report envelope, is cancelled, hits an opt-in wall-clock deadline, or stalls.
 */

import type { ReactorEmittedEvent } from "@intx/inference";
import { onTurnBoundary } from "../agent/reactor-events.js";
import { demoteNestedReportHeadings, formatSubAgentReport, hasReportEnvelope } from "./report.js";
import type { ThrashState } from "./thrash.js";

// Minimum gap kept between an opt-in internal deadline and the outer
// tool-execution watchdog, so there is time left for the salvage report to
// unwind and return before the outer watchdog would discard the run wholesale.
export const SUBAGENT_DEADLINE_MARGIN_MS = 30_000;

/**
 * Clamp an explicit opt-in wall-clock deadline to stay a margin below the
 * effective outer tool-execution watchdog. There is no default worker deadline —
 * operator cancel is the primary bound; callers pass deadlineMs only when they
 * want an extra wall-clock stop.
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
 * genuine pre-progress operator cancel still rethrows so the spawn_agent tool's
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

export type SubAgentStopReason = "complete" | "incomplete-report" | "incomplete-report-stop";

/**
 * Consecutive tool-less narration turns (no four-heading envelope) before
 * salvage. Cycle 1 nudges; cycle 2 (and beyond) stops as incomplete-report.
 */
export const MAX_TOOLLESS_NARRATION_CYCLES = 2;

export type ToolLessNarrationSpiral = "nudge" | "stop";

/**
 * Decide whether another tool-less narration without an envelope should nudge
 * once more or salvage. `cycles` is the 1-based count of consecutive tool-less
 * narration turns so far (including the current one).
 */
export function evaluateToolLessNarrationSpiral(cycles: number): ToolLessNarrationSpiral {
  return cycles >= MAX_TOOLLESS_NARRATION_CYCLES ? "stop" : "nudge";
}

/**
 * Pure stop decision for leaf workers. Null means keep running tools.
 *
 * "incomplete-report" is a one-shot signal telling the caller to inject a
 * wrap-up / redirect nudge and keep running. A tool-less turn (including one
 * that never called a tool at all) completes only when the assistant text has
 * a four-heading envelope (Summary, Findings, Blockers, Paths). Missing
 * envelope nudges once (`incomplete-report`) then salvages
 * (`incomplete-report-stop`) via evaluateToolLessNarrationSpiral.
 * When `requireEvidence` is set (CritiqueDirector), an empty `readCounts`
 * is not complete even with all four headings — same incomplete-report
 * nudge then salvage, so a wrap-up envelope cannot fake a real review.
 */
export function evaluateSubAgentStop(input: {
  hasToolCalls: boolean;
  /**
   * When true (CritiqueDirector leaf), a tool-using run that never
   * read or searched a file is not a successful complete — even a four-heading
   * envelope is incomplete-report so the parent does not treat a wrap-up
   * narration as a finished review.
   */
  requireEvidence?: boolean;
  /** Read/search bookkeeping for the evidence gate above. */
  thrashState?: ThrashState;
  /**
   * Final assistant text of this turn. A missing four-heading envelope
   * (Summary/Findings/Blockers/Paths) nudges once then salvages.
   */
  lastAssistantText: string;
  /**
   * 1-based count of consecutive tool-less narration turns so far (including
   * the current one). When omitted, falls back to `incompleteReportNudgeFired`
   * for older call sites (false → cycle 1, true → cycle 2).
   */
  toolLessNarrationCycles?: number;
  /**
   * @deprecated Prefer `toolLessNarrationCycles`. True after the one-shot
   * incomplete-report wrap-up nudge has been injected.
   */
  incompleteReportNudgeFired?: boolean;
}): SubAgentStopReason | null {
  const spiralCycles =
    input.toolLessNarrationCycles ?? (input.incompleteReportNudgeFired === true ? 2 : 1);
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
      (input.thrashState === undefined || input.thrashState.readCounts.size === 0)
    ) {
      return spiralStop();
    }
    return "complete";
  }
  return null;
}

// A worker is not a chat partner: it runs until it stops calling
// tools, at which point its final assistant text is the result handed back to
// the dispatcher. It has no ask_operator (it uses ask_director); consequential
// tools still go through the parent's permission gate (grants, auto mode, or
// prompts). Unbounded runs terminate only on a model-produced report envelope
// or an operator/deadline/stall interrupt — there is no turn cap.

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

export type ForcedStopReason = "cancelled" | "deadline" | "stalled" | "incomplete-report";

/** Optional detail / Paths payload for a forced-stop salvage envelope. */
export interface ForcedStopReportOptions {
  /** Path-specific specifics (cancel reason) rendered on the `Stopped:` line. */
  detail?: string;
  /** Edited/read paths for the Paths section (string or list; capped by caller). */
  paths?: string | readonly string[];
}

// Exact Summary text rendered for each forced-stop reason. Human-facing only —
// forcedStopReport is the sole reader; the parent classifies outcomes from the
// structured ForcedStopReason value itself (see run.ts/agent-fleet.ts), never by
// parsing this text back out of the report.
const FORCED_STOP_SUMMARIES: Record<ForcedStopReason, string> = {
  cancelled: "Stopped: cancelled by operator before finishing.",
  deadline: "Stopped: wall-clock deadline reached before finishing.",
  stalled:
    "Stopped after a long silence with no tool activity. The parent can re-dispatch or check the background work directly.",
  "incomplete-report": "Stopped: worker narrated instead of writing a report envelope.",
};

function normalizeSalvagePaths(paths: ForcedStopReportOptions["paths"]): string {
  if (paths === undefined) return "";
  if (typeof paths === "string") return paths.trim();
  return paths
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .join("\n");
}

/**
 * Build the parent-facing report when a leaf is force-stopped. There is no
 * further inference, so this must already be a full envelope — not an
 * instruction asking the finished worker to summarize. Options carry the
 * cancel `detail` (Stopped line) and salvage `paths` (Paths section). Findings
 * keep demoted partial prose, or a files-touched stub when only paths remain.
 */
export function forcedStopReport(
  reason: ForcedStopReason,
  partialText: string,
  options: ForcedStopReportOptions = {},
): string {
  const detail = options.detail;
  const pathText = normalizeSalvagePaths(options.paths);
  const summary = FORCED_STOP_SUMMARIES[reason];
  const blockers =
    reason === "cancelled"
      ? "Operator or parent cancelled the worker mid-run; synthesize the partial findings below, report Blockers, and wait for the operator."
      : reason === "deadline"
        ? "Worker wall-clock deadline elapsed mid-run; parent may re-dispatch with a longer deadline or a narrower scope for the remaining work."
        : reason === "stalled"
          ? "Worker went quiet (e.g. parked on a long-running background command) past the stall timeout after an initial nudge; parent may re-dispatch to finish or check on the background work directly."
          : "Worker ended a tool-using run with a tool-less turn that had no four-heading report envelope (Summary/Findings/Blockers/Paths) after a wrap-up nudge. Findings below are the narration, not a structured report.";
  // Demote nested report-section headings so runSubAgent's parse/format pass
  // cannot clobber this outer Summary/Blockers with an agent-shaped envelope
  // stuffed into Findings (cancel after a structured partial).
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
    stopped: detail !== undefined && detail.length > 0 ? `${reason} — ${detail}` : reason,
  });
}

const DEADLINE_PARENT_HINT =
  "[Sub-agent hit an explicit wall-clock deadline before finishing. Continue from Findings rather than redoing completed work; re-dispatch with continuation context and a longer deadline only if more wall-clock time is warranted.]";

const CANCELLED_PARENT_HINT =
  "[Sub-agent was cancelled before finishing. Synthesize Findings and Paths rather than redoing completed work; wait for the operator instead of auto-starting another specialist.]";

/** Options for parent-hint stacking (session re-dispatch ledger state). */
export interface SubAgentParentHintOptions {
  /**
   * 1-based count of how many times this brief fingerprint has been admitted
   * this session (including the run that produced `report`).
   */
  dispatchCount?: number;
}

/**
 * Prepend the parent-facing salvage hint for `reason`, chosen from the
 * structured ForcedStopReason the run reported directly — never by parsing
 * `report`'s prose. Reasons with no dedicated hint (stalled, incomplete-report,
 * or a normal complete) pass `report` through unchanged.
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
    default:
      return report;
  }
}
