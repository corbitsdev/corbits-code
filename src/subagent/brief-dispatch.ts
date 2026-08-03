/**
 * Parent-side re-dispatch caps for task briefs (CL-4343 + CL-5203).
 *
 * Leaf stops already salvage thrash / no-progress / turn-budget / etc. This
 * module tracks how often the *parent* re-spawns the same brief so:
 * - thrash-class salvages hard-block an identical re-dispatch for the rest of
 *   the parent chat session (sticky until the fingerprint changes)
 * - turn-budget salvage flips from "raise maxTurns" to "stop" after enough
 *   same-brief dispatches without a successful complete
 *
 * Session-scoped: one ledger per createTaskTool instance (parent chat tool).
 */

import type { TaskIntent } from "./report.js";
import { parseSubAgentReport } from "./report.js";
import {
  isDeadlineSubAgentReport,
  isNeverActedSubAgentReport,
  isNoProgressSubAgentReport,
  isRepetitionSubAgentReport,
  isThrashSubAgentReport,
  isTurnBudgetSubAgentReport,
} from "./stop-policy.js";

/** Salvage classes that must not be re-dispatched with an identical brief. */
export type HardBlockSalvage =
  | "thrash"
  | "no-progress"
  | "repetition"
  | "never-acted";

export type BriefSalvageKind =
  | HardBlockSalvage
  | "turn-budget"
  | "deadline"
  | "stalled"
  | "cancelled";

export type TaskBriefFingerprintInput = {
  prompt: string;
  agent?: string;
  intent?: TaskIntent;
  successCriteria?: readonly string[];
  doNot?: readonly string[];
};

export type BriefDispatchRecord = {
  /** How many times this fingerprint has been accepted for run (including first). */
  dispatchCount: number;
  /** Last salvage class observed for this fingerprint, if any. */
  lastSalvage?: BriefSalvageKind;
};

/**
 * After this many total dispatches of the same brief without a successful
 * complete (original + 2 re-dispatches), turn-budget salvage no longer invites
 * another re-dispatch. Successful completes reset the counter.
 */
export const TURN_BUDGET_STOP_AFTER_DISPATCHES = 3;

const HARD_BLOCK_SALVAGES = new Set<BriefSalvageKind>([
  "thrash",
  "no-progress",
  "repetition",
  "never-acted",
]);

export function isHardBlockSalvage(kind: BriefSalvageKind): kind is HardBlockSalvage {
  return HARD_BLOCK_SALVAGES.has(kind);
}

/** True when the worker returned a stall salvage report. */
export function isStalledSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.toLowerCase().includes("long silence");
}

/** True when the worker returned a cancel salvage report. */
export function isCancelledSubAgentReport(report: string): boolean {
  const parsed = parseSubAgentReport(report);
  return parsed.summary.toLowerCase().includes("cancelled");
}

/**
 * Classify a sub-agent tool result body as a salvage kind the parent ledger cares
 * about. Returns null for normal completes (or unrecognized envelopes).
 */
export function classifyBriefSalvage(report: string): BriefSalvageKind | null {
  // Order: more specific salvage phrases first.
  if (isThrashSubAgentReport(report)) return "thrash";
  if (isRepetitionSubAgentReport(report)) return "repetition";
  if (isNeverActedSubAgentReport(report)) return "never-acted";
  if (isNoProgressSubAgentReport(report)) return "no-progress";
  if (isTurnBudgetSubAgentReport(report)) return "turn-budget";
  if (isDeadlineSubAgentReport(report)) return "deadline";
  if (isStalledSubAgentReport(report)) return "stalled";
  if (isCancelledSubAgentReport(report)) return "cancelled";
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

export type BriefDispatchLedger = {
  get: (fingerprint: string) => BriefDispatchRecord | undefined;
  /**
   * Pre-run gate. Returns ok with the 1-based dispatch count that will be used,
   * or a reject message for the parent tool result.
   */
  admit: (fingerprint: string) =>
    | { ok: true; dispatchCount: number }
    | { ok: false; message: string };
  /** Record the outcome of an admitted run (salvage kind or null on success). */
  recordOutcome: (fingerprint: string, salvage: BriefSalvageKind | null) => void;
  /**
   * Undo a prior admit when the run never produced a salvage or success body
   * (throw / auth fail). Prevents burning turn-budget retry budget on crashes.
   */
  release: (fingerprint: string) => void;
};

export function createBriefDispatchLedger(): BriefDispatchLedger {
  const byFingerprint = new Map<string, BriefDispatchRecord>();

  return {
    get(fingerprint) {
      return byFingerprint.get(fingerprint);
    },

    admit(fingerprint) {
      const existing = byFingerprint.get(fingerprint);
      if (existing?.lastSalvage !== undefined && isHardBlockSalvage(existing.lastSalvage)) {
        return {
          ok: false,
          message: hardBlockMessage(existing.lastSalvage, existing.dispatchCount),
        };
      }
      const nextCount = (existing?.dispatchCount ?? 0) + 1;
      byFingerprint.set(fingerprint, {
        dispatchCount: nextCount,
        ...(existing?.lastSalvage !== undefined ? { lastSalvage: existing.lastSalvage } : {}),
      });
      return { ok: true, dispatchCount: nextCount };
    },

    recordOutcome(fingerprint, salvage) {
      const existing = byFingerprint.get(fingerprint);
      if (existing === undefined) {
        // admit() always runs first in production; keep defensive for unit tests.
        byFingerprint.set(fingerprint, {
          dispatchCount: salvage === null ? 0 : 1,
          ...(salvage !== null ? { lastSalvage: salvage } : {}),
        });
        return;
      }
      if (salvage === null) {
        // Successful complete resets the same-brief retry budget. Hard-block
        // lastSalvage is sticky for the session and must not be cleared by a
        // concurrent twin that finishes after thrash was already recorded.
        if (existing.lastSalvage !== undefined && isHardBlockSalvage(existing.lastSalvage)) {
          byFingerprint.set(fingerprint, {
            dispatchCount: existing.dispatchCount,
            lastSalvage: existing.lastSalvage,
          });
          return;
        }
        byFingerprint.set(fingerprint, { dispatchCount: 0 });
        return;
      }
      byFingerprint.set(fingerprint, {
        dispatchCount: existing.dispatchCount,
        lastSalvage: salvage,
      });
    },

    release(fingerprint) {
      const existing = byFingerprint.get(fingerprint);
      if (existing === undefined) return;
      if (existing.dispatchCount <= 1) {
        if (existing.lastSalvage !== undefined) {
          byFingerprint.set(fingerprint, {
            dispatchCount: 0,
            lastSalvage: existing.lastSalvage,
          });
        } else {
          byFingerprint.delete(fingerprint);
        }
        return;
      }
      byFingerprint.set(fingerprint, {
        dispatchCount: existing.dispatchCount - 1,
        ...(existing.lastSalvage !== undefined ? { lastSalvage: existing.lastSalvage } : {}),
      });
    },
  };
}

function hardBlockMessage(salvage: HardBlockSalvage, priorDispatches: number): string {
  return (
    `Error: refused re-dispatch of an identical task brief after a ${salvage} salvage ` +
    `(already dispatched ${priorDispatches} time${priorDispatches === 1 ? "" : "s"}). ` +
    `Change the brief (prompt, agent, intent, success_criteria, and/or do_not) before retrying — ` +
    `raising maxTurns alone will not unlock this fingerprint. ` +
    `To force a re-run of the same work, alter at least one of those fields so the fingerprint changes.`
  );
}

/**
 * Whether turn-budget parent hint should recommend stopping rather than
 * re-dispatching with a higher maxTurns.
 */
export function shouldStopTurnBudgetRedispatch(dispatchCount: number): boolean {
  return dispatchCount >= TURN_BUDGET_STOP_AFTER_DISPATCHES;
}
