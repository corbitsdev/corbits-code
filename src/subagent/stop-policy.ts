/**
 * Pure stop / salvage policy for leaf sub-agents: turn budget, no-progress,
 * thrash, deadlines, and parent-facing salvage reports.
 */

import type { ReactorEmittedEvent } from "@intx/inference";
import { onTurnBoundary } from "../agent/reactor-events.js";
import {
  evaluateThrashStop,
  type ThrashConfig,
  type ThrashState,
} from "./thrash.js";
import {
  demoteNestedReportHeadings,
  formatSubAgentReport,
  parseSubAgentReport,
} from "./report.js";

/** Consecutive identical tool-call fingerprints before a leaf is forced to stop. */
export const DEFAULT_SUBAGENT_REPEAT_LIMIT = 2;

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
 * Returns undefined (do not arm) when the outer watchdog is at or below the
 * salvage margin — an internal deadline would otherwise race or exceed outer
 * and leave no room to return a salvage report.
 */
export function resolveSubAgentDeadlineMs(
  requestedMs: number,
  outerWatchdogMs: number,
): number | undefined {
  const requested = Math.max(1, Math.floor(requestedMs));
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

export type SubAgentCatchOutcome =
  | "salvage-repetition"
  | "salvage-deadline"
  | "salvage-cancelled"
  | "rethrow";

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
  repetitionHit?: boolean;
}): SubAgentCatchOutcome {
  // Repetition wins: it is our own abort, so it can never also be a deadline
  // (the deadline timer refuses to mark an already-aborted run), and it always
  // salvages — the looped tail is exactly what the parent needs to see.
  if (input.repetitionHit === true) return "salvage-repetition";
  if (input.deadlineHit) return "salvage-deadline";
  if (input.hadProgress) return "salvage-cancelled";
  return "rethrow";
}

export function subAgentTurnLimitExceeded(turnsCompleted: number, maxTurns: number): boolean {
  return turnsCompleted >= maxTurns;
}

export function subAgentNoProgress(
  consecutiveIdentical: number,
  repeatLimit: number,
): boolean {
  return consecutiveIdentical >= repeatLimit;
}

// Stable JSON so key insertion order does not create false progress between turns.
function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableJson(obj[k])}`).join(",")}}`;
}

/** Fingerprint of a turn's tool calls, or null when the turn has none. */
export function fingerprintToolCalls(
  content: ReadonlyArray<{ type: string; name?: string; arguments?: unknown }>,
): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type !== "tool_call") continue;
    const name = typeof block.name === "string" ? block.name : "";
    let args: unknown = block.arguments ?? {};
    // Some adapters hand arguments as a JSON string; normalize so fingerprints match.
    if (typeof args === "string") {
      try {
        args = JSON.parse(args) as unknown;
      } catch {
        // Keep the raw string when it is not valid JSON.
      }
    }
    parts.push(`${name}:${stableJson(args)}`);
  }
  if (parts.length === 0) return null;
  parts.sort();
  return parts.join("|");
}

export type SubAgentStopReason =
  | "complete"
  | "turn-budget"
  | "no-progress"
  | "never-acted"
  | "never-edited"
  | "thrash"
  | "report-forced";

/**
 * Pure stop decision for leaf workers. Null means keep running tools.
 *
 * Precedence when tools are still firing:
 * no-progress (identical fingerprints) > thrash (re-read pressure) >
 * turn-budget (hard cap). "report-forced" is not a competing stop reason —
 * it is a one-shot signal, forceReportWithin turns before the cap, telling
 * the caller to inject a wrap-up nudge and keep running; turn-budget remains
 * reachable afterward. Tool-less turns always end the leaf as complete,
 * never-acted, or never-edited.
 */
export function evaluateSubAgentStop(input: {
  hasToolCalls: boolean;
  /** True when any turn in this run (including the current one) issued tools. */
  everHadToolCalls: boolean;
  turnsCompleted: number;
  maxTurns: number;
  consecutiveIdentical: number;
  repeatLimit: number;
  /** When set, progressive thrash / force-report are evaluated after no-progress. */
  thrashState?: ThrashState;
  thrashConfig?: Partial<ThrashConfig>;
  /**
   * When true (intent=implement), a tool-using run that never wrote/edited a
   * file is not a successful complete — salvage as never-edited so the parent
   * does not treat a pure-explore "plan" as shipped work.
   */
  requireEdit?: boolean;
}): SubAgentStopReason | null {
  // A tool-less turn always ends the leaf. Planning-only prose is never-acted;
  // implement intent that only read/searched (no edit_file/write_file/delete_file)
  // is never-edited — both hard-block identical re-dispatch.
  if (!input.hasToolCalls) {
    if (!input.everHadToolCalls) return "never-acted";
    if (
      input.requireEdit === true &&
      (input.thrashState === undefined || input.thrashState.editedPaths.size === 0)
    ) {
      return "never-edited";
    }
    return "complete";
  }
  // No-progress is more specific than thrash or the turn budget when both could apply.
  if (subAgentNoProgress(input.consecutiveIdentical, input.repeatLimit)) return "no-progress";
  if (input.thrashState !== undefined) {
    const thrashStop = evaluateThrashStop({
      state: input.thrashState,
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

export type ToolCallStreak = {
  lastFingerprint: string | undefined;
  consecutiveIdentical: number;
};

/** Advance consecutive-identical bookkeeping for one inference.done turn. */
export function nextToolCallStreak(
  prev: ToolCallStreak,
  fingerprint: string | null,
): ToolCallStreak {
  if (fingerprint === null) {
    return { lastFingerprint: undefined, consecutiveIdentical: 0 };
  }
  if (fingerprint === prev.lastFingerprint) {
    return {
      lastFingerprint: fingerprint,
      consecutiveIdentical: prev.consecutiveIdentical + 1,
    };
  }
  return { lastFingerprint: fingerprint, consecutiveIdentical: 1 };
}

// A sub-agent is a worker, not a chat partner: it runs until it stops calling
// tools, at which point its final assistant text is the result handed back to
// the dispatcher — unless it never called tools at all, in which case the
// result is a never-acted salvage report rather than a successful implement.
// It has no submit_output or ask_operator; consequential tools still go through
// the parent's permission gate (grants, auto mode, or prompts). Hard stops also
// fire on identical tool fingerprints (no-progress), progressive re-read thrash,
// and the hard turn budget so a thrashing leaf cannot burn the full budget
// with no parent-visible report. Near the budget the leaf gets a one-shot
// wrap-up nudge (report-forced) rather than a stop, so turn-budget stays
// reachable for a leaf that is genuinely still making progress.

export function lastText(content: ReadonlyArray<{ type: string }>): string {
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

/**
 * Build the parent-facing report when a leaf is force-stopped. There is no
 * further inference, so this must already be a full envelope — not an
 * instruction asking the finished worker to summarize.
 */
export function forcedStopReport(
  reason:
    | "no-progress"
    | "turn-budget"
    | "never-acted"
    | "never-edited"
    | "cancelled"
    | "deadline"
    | "thrash"
    | "stalled"
    | "repetition",
  partialText: string,
): string {
  const summary =
    reason === "no-progress"
      ? "Stopped: repeated the same tool calls with no progress."
      : reason === "thrash"
        ? "Stopped: progressive thrash (re-read pressure without finishing)."
        : reason === "never-acted"
          ? "Stopped: completed without using any tools."
          : reason === "never-edited"
            ? "Stopped: implement intent finished without writing any files."
            : reason === "cancelled"
              ? "Stopped: cancelled by operator before finishing."
              : reason === "deadline"
                ? "Stopped: wall-clock deadline reached before finishing."
                : reason === "stalled"
                  ? "Stopped after a long silence with no tool activity. The parent can re-dispatch or check the background work directly."
                  : reason === "repetition"
                    ? "Stopped: degenerate repetition in streamed output (same window looping mid-turn)."
                    : "Turn budget reached before finishing.";
  const blockers =
    reason === "no-progress"
      ? "Identical tool-call fingerprint repeated consecutively; parent must not re-dispatch the identical brief (it will be refused) — tighten success_criteria/do_not or change approach."
      : reason === "thrash"
        ? "Re-read pressure (same path after edit, or heavy re-reads amid high tool volume); parent must not re-dispatch the identical brief (it will be refused) — re-dispatch only with a narrower scope, success_criteria, and do_not rather than more turns alone."
        : reason === "never-acted"
          ? "Leaf returned planning/prose only (zero tool calls in the run); parent must not re-dispatch the identical brief (it will be refused) — re-dispatch only with a tighter brief, or treat findings as unexecuted."
          : reason === "never-edited"
            ? "Leaf used tools but never called edit_file/write_file/delete_file under intent=implement; parent must not re-dispatch the identical brief (it will be refused) — re-dispatch with an edit-first brief, or treat findings as unexecuted."
            : reason === "cancelled"
            ? "Operator or parent cancelled the leaf mid-run; parent may re-dispatch with the partial findings below."
            : reason === "deadline"
              ? "Leaf wall-clock deadline elapsed mid-run; parent may re-dispatch with a longer deadline or a narrower scope for the remaining work."
              : reason === "stalled"
                ? "Leaf went quiet (e.g. parked on a long-running background command) past the stall timeout after an initial nudge; parent may re-dispatch to finish or check on the background work directly."
                : reason === "repetition"
                  ? "The model looped the same output window mid-stream; the tail of the loop is in Findings. Re-dispatching the identical brief will be refused and would likely loop again — change prompt/intent/success_criteria/do_not/agent, not maxTurns alone."
                  : "Leaf turn budget exhausted; parent may re-dispatch for remaining work.";
  // Demote nested report-section headings so runSubAgent's parse/format pass
  // cannot clobber this outer Summary/Blockers with an agent-shaped envelope
  // stuffed into Findings (never-acted planning envelopes; cancel after a
  // structured partial).
  const findings =
    partialText.trim().length > 0
      ? demoteNestedReportHeadings(partialText.trim())
      : "(no partial findings on the final turn)";
  return formatSubAgentReport({
    summary,
    findings,
    blockers,
    paths: "",
  });
}

/** True when the worker returned a turn-budget salvage report for the parent. */
export function isTurnBudgetSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("Turn budget reached");
}

/** True when the worker returned a never-acted salvage report for the parent. */
export function isNeverActedSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("without using any tools");
}

/** True when implement intent finished without any write/edit tools. */
export function isNeverEditedSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("without writing any files");
}

/** True when the worker returned a deadline salvage report for the parent. */
export function isDeadlineSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("deadline reached");
}

/** True when the worker returned a progressive-thrash salvage report. */
export function isThrashSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("progressive thrash");
}

/** True when the worker returned a streamed-repetition salvage report. */
export function isRepetitionSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("degenerate repetition");
}

const TURN_BUDGET_PARENT_HINT =
  "[Sub-agent hit its turn budget before finishing. Continue from Findings rather than redoing completed work; re-dispatch with continuation context and a higher maxTurns if more work is warranted.]";

/** After enough same-brief dispatches, stop inviting another maxTurns bump (CL-4343). */
export const TURN_BUDGET_STOP_PARENT_HINT =
  "[Sub-agent hit its turn budget again on the same brief (re-dispatch cap). Stop raising maxTurns on this fingerprint — restate the task, change approach (intent / success_criteria / do_not / prompt / agent), or finish from Findings. Further identical dispatches are still admitted but will not invite more maxTurns bumps.]";

const NEVER_ACTED_PARENT_HINT =
  "[Sub-agent finished without using any tools (planning/prose only). Treat findings as unexecuted; re-dispatch with a tighter brief if the work still needs doing. An identical brief will be refused.]";

const NEVER_EDITED_PARENT_HINT =
  "[Sub-agent finished implement intent without writing any files (read/search only). Treat findings as unexecuted; re-dispatch with an edit-first brief. An identical brief will be refused.]";

const DEADLINE_PARENT_HINT =
  "[Sub-agent hit an explicit wall-clock deadline before finishing. Continue from Findings rather than redoing completed work; re-dispatch with continuation context and a longer deadline only if more wall-clock time is warranted.]";

const THRASH_PARENT_HINT =
  "[Sub-agent stopped for progressive thrash (re-read pressure). Do not re-dispatch the identical brief (it will be refused) — change scope, success_criteria, and do_not; continue from Findings.]";

const REPETITION_PARENT_HINT =
  "[Sub-agent aborted after its streamed output degenerated into a loop. Do not re-dispatch the identical brief — it will be refused and would likely loop again; change prompt, intent, success_criteria, do_not, and/or agent (maxTurns alone does not change the fingerprint).]";

const NO_PROGRESS_PARENT_HINT =
  "[Sub-agent stopped for no-progress (identical tool-call fingerprint). Do not re-dispatch the identical brief (it will be refused) — tighten success_criteria and do_not, or change approach.]";

/** Options for parent-hint stacking (session re-dispatch ledger state). */
export type SubAgentParentHintOptions = {
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
};

export function appendTurnBudgetParentHint(
  report: string,
  options: SubAgentParentHintOptions = {},
): string {
  if (!isTurnBudgetSubAgentReport(report)) return report;
  const stopAfter = options.turnBudgetStopAfterDispatches ?? 3;
  const count = options.dispatchCount ?? 1;
  const hint =
    count >= stopAfter ? TURN_BUDGET_STOP_PARENT_HINT : TURN_BUDGET_PARENT_HINT;
  return `${hint}\n\n${report}`;
}

export function appendNeverActedParentHint(report: string): string {
  if (!isNeverActedSubAgentReport(report)) return report;
  return `${NEVER_ACTED_PARENT_HINT}\n\n${report}`;
}

export function appendNeverEditedParentHint(report: string): string {
  if (!isNeverEditedSubAgentReport(report)) return report;
  return `${NEVER_EDITED_PARENT_HINT}\n\n${report}`;
}

export function appendDeadlineParentHint(report: string): string {
  if (!isDeadlineSubAgentReport(report)) return report;
  return `${DEADLINE_PARENT_HINT}\n\n${report}`;
}

export function appendThrashParentHint(report: string): string {
  if (!isThrashSubAgentReport(report)) return report;
  return `${THRASH_PARENT_HINT}\n\n${report}`;
}

export function appendRepetitionParentHint(report: string): string {
  if (!isRepetitionSubAgentReport(report)) return report;
  return `${REPETITION_PARENT_HINT}\n\n${report}`;
}

/** True when the worker returned a no-progress salvage report. */
export function isNoProgressSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.includes("no progress");
}

export function appendNoProgressParentHint(report: string): string {
  if (!isNoProgressSubAgentReport(report)) return report;
  return `${NO_PROGRESS_PARENT_HINT}\n\n${report}`;
}

/** Stack parent-visible salvage hints for thrash / budget / never-acted / deadline / repetition / no-progress. */
export function appendSubAgentParentHints(
  report: string,
  options: SubAgentParentHintOptions = {},
): string {
  return appendDeadlineParentHint(
    appendNeverEditedParentHint(
      appendNeverActedParentHint(
        appendTurnBudgetParentHint(
          appendNoProgressParentHint(
            appendThrashParentHint(appendRepetitionParentHint(report)),
          ),
          options,
        ),
      ),
    ),
  );
}
