/**
 * Parent-side re-dispatch tracking for task briefs (CL-4343 + CL-5203).
 *
 * Leaf stops already salvage turn-budget / deadline / etc. This module
 * tracks how often the *parent* re-spawns the same brief so turn-budget
 * salvage flips from "raise maxTurns" to "stop" after enough same-brief
 * dispatches without a successful complete. No salvage class refuses
 * re-dispatch (CL-6994) — every dispatch is admitted.
 *
 * Session-scoped: one ledger per createTaskTool instance (parent chat tool).
 */

import type { TaskIntent } from "./report.js";
import {
  isDeadlineSubAgentReport,
  isForcedStopSubAgentReport,
  isRepetitionSubAgentReport,
  isTurnBudgetSubAgentReport,
} from "./stop-policy.js";

export type BriefSalvageKind =
  "turn-budget" | "deadline" | "stalled" | "cancelled" | "incomplete-report" | "repetition";

export interface TaskBriefFingerprintInput {
  prompt: string;
  agent?: string;
  intent?: TaskIntent;
  successCriteria?: readonly string[];
  doNot?: readonly string[];
}

export interface BriefDispatchRecord {
  /** How many times this fingerprint has been accepted for run (including first). */
  dispatchCount: number;
}

/**
 * After this many total dispatches of the same brief without a successful
 * complete (original + 2 re-dispatches), turn-budget salvage no longer invites
 * another re-dispatch. Successful completes reset the counter.
 */
export const TURN_BUDGET_STOP_AFTER_DISPATCHES = 3;

/** True when the worker returned a stall salvage report. */
export function isStalledSubAgentReport(report: string): boolean {
  return isForcedStopSubAgentReport(report, "stalled");
}

/** True when the worker returned a cancel salvage report. */
export function isCancelledSubAgentReport(report: string): boolean {
  return isForcedStopSubAgentReport(report, "cancelled");
}

/** True when the worker returned an incomplete-report salvage (narration, no envelope). */
export function isIncompleteReportSubAgentReport(report: string): boolean {
  return isForcedStopSubAgentReport(report, "incomplete-report");
}

/**
 * Classify a sub-agent tool result body as a salvage kind the parent ledger cares
 * about. Returns null for normal completes (or unrecognized envelopes).
 */
export function classifyBriefSalvage(report: string): BriefSalvageKind | null {
  // Order: more specific salvage phrases first.
  if (isRepetitionSubAgentReport(report)) return "repetition";
  if (isTurnBudgetSubAgentReport(report)) return "turn-budget";
  if (isDeadlineSubAgentReport(report)) return "deadline";
  if (isStalledSubAgentReport(report)) return "stalled";
  if (isCancelledSubAgentReport(report)) return "cancelled";
  if (isIncompleteReportSubAgentReport(report)) return "incomplete-report";
  return null;
}

/**
 * Stable fingerprint for a task brief. Covers the typed spawn contract fields
 * that define the job (prompt + agent + intent + success_criteria + do_not).
 * Description, context, goals, report_focus, maxTurns, and tier are intentionally
 * omitted so cosmetic label / budget tweaks cannot bypass the cap.
 */
export function fingerprintTaskBrief(input: TaskBriefFingerprintInput): string {
  const parts = [
    "v1",
    normalizeText(input.prompt),
    normalizeText(input.agent ?? ""),
    input.intent ?? "",
    serializeList(input.successCriteria),
    serializeList(input.doNot),
  ];
  return parts.join("\n");
}

function normalizeText(s: string): string {
  return s.trim().replace(/\s+/g, " ");
}

function serializeList(items: readonly string[] | undefined): string {
  if (items === undefined || items.length === 0) return "";
  return items.map((item) => normalizeText(item)).join("\0");
}

export interface BriefDispatchLedger {
  get: (fingerprint: string) => BriefDispatchRecord | undefined;
  /** Pre-run gate. Always admits; returns the 1-based dispatch count that will be used. */
  admit: (fingerprint: string) => { ok: true; dispatchCount: number };
  /** Record the outcome of an admitted run (salvage kind or null on success). */
  recordOutcome: (fingerprint: string, salvage: BriefSalvageKind | null) => void;
  /**
   * Undo a prior admit when the run never produced a salvage or success body
   * (throw / auth fail). Prevents burning turn-budget retry budget on crashes.
   */
  release: (fingerprint: string) => void;
}

export function createBriefDispatchLedger(): BriefDispatchLedger {
  const byFingerprint = new Map<string, BriefDispatchRecord>();

  return {
    get(fingerprint) {
      return byFingerprint.get(fingerprint);
    },

    admit(fingerprint) {
      const existing = byFingerprint.get(fingerprint);
      const nextCount = (existing?.dispatchCount ?? 0) + 1;
      byFingerprint.set(fingerprint, { dispatchCount: nextCount });
      return { ok: true, dispatchCount: nextCount };
    },

    recordOutcome(fingerprint, salvage) {
      // A successful complete resets the same-brief retry budget. Any other
      // salvage leaves dispatchCount as admit() already recorded it.
      if (salvage === null) {
        byFingerprint.set(fingerprint, { dispatchCount: 0 });
      }
    },

    release(fingerprint) {
      const existing = byFingerprint.get(fingerprint);
      if (existing === undefined) return;
      if (existing.dispatchCount <= 1) {
        byFingerprint.delete(fingerprint);
        return;
      }
      byFingerprint.set(fingerprint, { dispatchCount: existing.dispatchCount - 1 });
    },
  };
}

/**
 * Whether turn-budget parent hint should recommend stopping rather than
 * re-dispatching with a higher maxTurns.
 */
export function shouldStopTurnBudgetRedispatch(dispatchCount: number): boolean {
  return dispatchCount >= TURN_BUDGET_STOP_AFTER_DISPATCHES;
}
