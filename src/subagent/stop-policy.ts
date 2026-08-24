/**
 * Pure stop / salvage policy for leaf sub-agents: turn budget, thrash,
 * deadlines, and parent-facing salvage reports.
 */

import type { ReactorEmittedEvent } from "@intx/inference";
import { onTurnBoundary } from "../agent/reactor-events.js";
import { detectSequencePeriod, type SequencePeriodCheck } from "../util/period-detection.js";
import { evaluateThrashStop, type ThrashConfig, type ThrashState } from "./thrash.js";
import {
  demoteNestedReportHeadings,
  formatSubAgentReport,
  hasReportEnvelope,
  parseSubAgentReport,
} from "./report.js";

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

export type SubAgentCatchOutcome =
  "salvage-repetition" | "salvage-deadline" | "salvage-cancelled" | "rethrow";

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
  content: readonly { type: string; name?: string; arguments?: unknown }[],
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

export type ToolFingerprintThrashCheck = SequencePeriodCheck;

// No legitimate orchestration pattern needs a longer repeating unit than
// this to be recognized as thrash. A local forensic scan (see
// scripts/tool-fingerprint-forensics.ts) over 328 real session traces (559
// tool-only runs) found zero cycles of any period 1-6 at all — the scan only
// checks periods up to 6 (MAX_PERIOD_SCANNED in the script), so this ceiling
// has no forensic backing above period 6, only headroom.
//
// This is a ceiling, not a guarantee: any period above it (a 7+ rotation),
// and any "phase-broken" cycle that inserts a varying element between
// otherwise-repeating windows (e.g. A,B,A,B,UNIQUE,A,B,A,B,UNIQUE,...), never
// matches here and can escape period detection indefinitely. That is exactly
// what TURNS_SINCE_USER_MESSAGE_BACKSTOP below exists to catch — a
// turns-since-last-user-message count with no pattern requirement, checked
// as a secondary/final net after period detection has had its chance to
// fire.
const TOOL_FINGERPRINT_MAX_PERIOD = 8;

// A truly identical consecutive tool call (period 1) is the one shape a
// legitimate agent can plausibly produce on purpose — rerunning a flaky
// test, polling a build. The forensic scan found zero occurrences of even
// two consecutive identical fingerprints in local trace history (a stronger
// result than CL-5611's original "zero 3+" finding), so there is no
// *measured* floor for legitimate period-1 repetition — this threshold is
// inferred headroom for that plausible-but-unobserved case, and deliberately
// set above 4: review on CL-5611 found the previous 4-repeat hard pause
// false-positived on exactly this kind of legitimate polling.
const IDENTICAL_REPEAT_MIN = 5;

// Any cycle of length 2+ (A,B,A,B,..., A,B,C,A,B,C,...) has no plausible
// legitimate justification — nobody deliberately re-issues a *different*
// tool call with identical arguments in a fixed rotation. Fire fast: three
// full cycles, per the operator's explicit "trigger fairly quickly" target
// (A,B,A,B,A,B pauses at 6 turns; A,B,C,A,B,C,A,B,C at 9), still comfortably
// above the observed healthy ceiling of zero.
const CYCLE_REPEAT_MIN = 3;

/**
 * Thrash check over a rolling history of consecutive tool-only-turn
 * fingerprints, via exact-period detection (detectSequencePeriod in
 * util/period-detection.ts). Generalizes the old consecutive-identical-only
 * check to catch any repeating cycle — A,A,A,..., A,B,A,B,..., A,B,C,A,B,C,...
 * — not just immediate repeats, which previously let an alternating A,B
 * pattern escape detection at any length. See docs/ARCHITECTURE.md for the
 * forensic basis of the thresholds.
 *
 * This is the fast path, not the only path: TOOL_FINGERPRINT_MAX_PERIOD is a
 * ceiling, so a cycle above it (or a phase-broken cycle that never settles
 * into an exact repeating tail) never fires here.
 * detectTurnsSinceUserMessageBackstop below is the final net for those cases.
 */
export function detectToolFingerprintThrash(
  history: readonly string[],
): ToolFingerprintThrashCheck {
  return detectSequencePeriod(history, {
    minPeriod: 1,
    maxPeriod: TOOL_FINGERPRINT_MAX_PERIOD,
    minRepeats: (period) => (period === 1 ? IDENTICAL_REPEAT_MIN : CYCLE_REPEAT_MIN),
    minDistinct: (period) => (period === 1 ? 1 : 2),
  });
}

// Secondary/final-net check: how long it has been since the operator last
// sent a genuine message, independent of whether the intervening turns form
// a detectable pattern or contain narration. Period detection (above) is the
// fast path and stays primary — it fires well before this on any cycle it
// can see (A,B at 6 turns, A,B,C at 9). This backstop exists for what period
// detection structurally cannot see: any period above
// TOOL_FINGERPRINT_MAX_PERIOD (e.g. a 9-element rotation), "phase-broken"
// cycles that insert a varying element between repeats (e.g.
// A,B,A,B,UNIQUE,A,B,A,B,UNIQUE,...) that never settle into an exact
// repeating tail at any period, and — the round-4 fix — a model that inserts
// one narrated word every N tool-only turns purely to keep resetting a
// narration-sensitive counter. Model-emitted text does not reset this
// counter; only a genuine user/operator message does (see director.ts). That
// is deliberate: this answers "how long since the operator last saw a real
// checkpoint," not "is the model narrating." (CL-5893: a successful leaf
// task completion also resets it, bounded by MAX_LEAF_PROGRESS_BACKSTOP_RESETS
// below — see director.ts.)
//
// Because narration no longer resets it, reaching this threshold does not
// hard-pause on its own — it only fires a nudge asking for a progress
// summary. Only if the nudge goes unheeded for a further full interval (see
// director.ts's turnsSinceUserMessage escalation) does the session hard
// pause, on the theory that ignoring a direct request is a real no-progress
// signal, whereas mere silence during a long autonomous stretch is not.
//
// Threshold justification: 100 is a judgment call, not a measured value.
// turns-since-last-genuine-operator-message has never been separately
// measured. An earlier claim that it had been was fabricated and is
// retracted — do not restate it, and do not invent a replacement
// justification in its place.
//
// The nearest real measurement is scripts/tool-fingerprint-forensics.ts,
// which measures a related but different quantity — consecutive
// tool-only-turn streaks, reset by narration — p50 3, p90 8, p99 16, max 28
// across 328 local sessions with a tool-only run. It does not directly apply
// here (narration does not reset this counter, so the distributions are not
// comparable), but it is the only forensic data point on hand, and 100 sits
// well above every percentile of it, which is the informal basis for
// treating 100 as generous headroom.
//
// src/subagent/intervention-log.ts now records every stop and nudge with its
// measured value beside the threshold it crossed. If this number is ever
// wrong, that log — not another guess — is how to find out.
export const TURNS_SINCE_USER_MESSAGE_BACKSTOP = 100;

// CL-5893: cap on how many times a successful leaf task completion may
// re-arm the backstop interval before a genuine operator message is
// required. Without a cap, a loop of trivial always-succeeding leaf tasks
// would reset the backstop forever and never force an operator checkpoint.
// At 5 resets (~500 turns of headroom before this bound, vs. the plain
// 100-turn threshold) a runaway trivial-success loop still nudges then
// pauses, while genuine fleet-heavy work gets meaningfully more room than
// the unbounded reset before this cap existed.
export const MAX_LEAF_PROGRESS_BACKSTOP_RESETS = 5;

/** True once turns-since-last-user-message reaches the backstop threshold. */
export function detectTurnsSinceUserMessageBackstop(turnsSinceUserMessage: number): boolean {
  return turnsSinceUserMessage >= TURNS_SINCE_USER_MESSAGE_BACKSTOP;
}

// Bounds the rolling fingerprint buffer director.ts keeps for the thrash
// check above. Detection only ever looks at the tail, so history older than
// the longest possible confirming window (max period * max repeats-needed)
// carries no signal — capping keeps a very long productive tool-only streak
// (e.g. 200+ turns) from growing the buffer or the per-turn scan unbounded.
export const TOOL_FINGERPRINT_HISTORY_CAP = TOOL_FINGERPRINT_MAX_PERIOD * IDENTICAL_REPEAT_MIN;

export type SubAgentStopReason =
  "complete" | "turn-budget" | "report-forced" | "incomplete-report" | "incomplete-report-stop";

/**
 * Pure stop decision for leaf workers. Null means keep running tools.
 *
 * "report-forced" and "incomplete-report" are not competing stop reasons —
 * they are one-shot signals telling the caller to inject a wrap-up / redirect
 * nudge and keep running; turn-budget remains reachable afterward. A
 * tool-less turn (including one that never called a tool at all) completes
 * only when the assistant text has a four-heading envelope (Summary,
 * Findings, Blockers, Paths). Omitting `lastAssistantText` still completes
 * (back-compat). Missing envelope nudges once (`incomplete-report`) then
 * salvages (`incomplete-report-stop`). When `requireEvidence` is set
 * (CritiqueDirector), an empty `readCounts` is not complete even with all
 * four headings — same incomplete-report nudge then salvage, so a wrap-up
 * envelope cannot fake a real review.
 */
export function evaluateSubAgentStop(input: {
  hasToolCalls: boolean;
  turnsCompleted: number;
  maxTurns: number;
  /** When set, the near-budget force-report nudge is evaluated. */
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
  // least one read/search in thrashState.readCounts. Neither zero tool calls
  // nor tool calls that left no net edit are treated as a failure here.
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
// prompts). The hard turn budget still fires so a looping leaf cannot burn
// the full budget with no parent-visible report. Near the budget the leaf
// gets a one-shot wrap-up nudge (report-forced) rather than a stop, so
// turn-budget stays reachable for a leaf that is genuinely still making
// progress.

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
  "turn-budget" | "cancelled" | "deadline" | "stalled" | "repetition" | "incomplete-report";

// Exact Summary text for each forced-stop reason. This is the single source
// of truth for both forcedStopReport (the producer) and the isXxxSubAgentReport
// classifiers (the consumers) — CL-6704: classifying on a free-text substring
// like "no progress" or "cancelled" hard-blocks a SUCCESSFUL report whose
// Summary happens to contain that phrase. Matching the exact string a forced
// stop actually produces closes that false-positive path without a report
// schema change (a typed marker would need one; see CL-6786, out of scope).
const FORCED_STOP_SUMMARIES: Record<ForcedStopReason, string> = {
  cancelled: "Stopped: cancelled by operator before finishing.",
  deadline: "Stopped: wall-clock deadline reached before finishing.",
  stalled:
    "Stopped after a long silence with no tool activity. The parent can re-dispatch or check the background work directly.",
  repetition: "Stopped: degenerate repetition in streamed output (same window looping mid-turn).",
  "incomplete-report": "Stopped: worker narrated instead of writing a report envelope.",
  "turn-budget": "Turn budget reached before finishing.",
};

/**
 * Build the parent-facing report when a leaf is force-stopped. There is no
 * further inference, so this must already be a full envelope — not an
 * instruction asking the finished worker to summarize. `detail` is the
 * path-specific specifics (looped window × count, turn counts, cancel reason)
 * rendered verbatim on the report's `Stopped:` line so the parent and the TUI
 * see the cause, not just that the worker stopped.
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
          : reason === "repetition"
            ? "The model looped the same output window mid-stream; the tail of the loop is in Findings. Re-dispatch with a changed prompt/intent/success_criteria/do_not/agent if it would likely loop again — maxTurns alone will not help."
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

/**
 * True when a report's Summary is exactly the forced-stop text for `reason`
 * (CL-6704: exact match, not a free-text substring — a successful report
 * whose Summary happens to mention the same words must not classify as a
 * forced stop).
 */
export function isForcedStopSubAgentReport(report: string, reason: ForcedStopReason): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary === FORCED_STOP_SUMMARIES[reason];
}

/** True when the worker returned a turn-budget salvage report for the parent. */
export function isTurnBudgetSubAgentReport(report: string): boolean {
  return isForcedStopSubAgentReport(report, "turn-budget");
}

/** True when the worker returned a deadline salvage report for the parent. */
export function isDeadlineSubAgentReport(report: string): boolean {
  return isForcedStopSubAgentReport(report, "deadline");
}

/** True when the worker returned a streamed-repetition salvage report. */
export function isRepetitionSubAgentReport(report: string): boolean {
  return isForcedStopSubAgentReport(report, "repetition");
}

const TURN_BUDGET_PARENT_HINT =
  "[Sub-agent hit its turn budget before finishing. Continue from Findings rather than redoing completed work; re-dispatch with continuation context and a higher maxTurns if more work is warranted.]";

/** After enough same-brief dispatches, stop inviting another maxTurns bump (CL-4343). */
export const TURN_BUDGET_STOP_PARENT_HINT =
  "[Sub-agent hit its turn budget again on the same brief (re-dispatch cap). Stop raising maxTurns on this fingerprint — restate the task, change approach (intent / success_criteria / do_not / prompt / agent), or finish from Findings. Further identical dispatches are still admitted but will not invite more maxTurns bumps.]";

const DEADLINE_PARENT_HINT =
  "[Sub-agent hit an explicit wall-clock deadline before finishing. Continue from Findings rather than redoing completed work; re-dispatch with continuation context and a longer deadline only if more wall-clock time is warranted.]";

const REPETITION_PARENT_HINT =
  "[Sub-agent aborted after its streamed output degenerated into a loop. Re-dispatching unchanged would likely loop again; change prompt, intent, success_criteria, do_not, and/or agent (maxTurns alone does not fix it).]";

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

export function appendTurnBudgetParentHint(
  report: string,
  options: SubAgentParentHintOptions = {},
): string {
  if (!isTurnBudgetSubAgentReport(report)) return report;
  const stopAfter = options.turnBudgetStopAfterDispatches ?? 3;
  const count = options.dispatchCount ?? 1;
  const hint = count >= stopAfter ? TURN_BUDGET_STOP_PARENT_HINT : TURN_BUDGET_PARENT_HINT;
  return `${hint}\n\n${report}`;
}

export function appendDeadlineParentHint(report: string): string {
  if (!isDeadlineSubAgentReport(report)) return report;
  return `${DEADLINE_PARENT_HINT}\n\n${report}`;
}

export function appendRepetitionParentHint(report: string): string {
  if (!isRepetitionSubAgentReport(report)) return report;
  return `${REPETITION_PARENT_HINT}\n\n${report}`;
}

/** Stack parent-visible salvage hints for turn-budget / deadline / repetition. */
export function appendSubAgentParentHints(
  report: string,
  options: SubAgentParentHintOptions = {},
): string {
  return appendDeadlineParentHint(
    appendTurnBudgetParentHint(appendRepetitionParentHint(report), options),
  );
}
