/**
 * Parent-side re-dispatch caps for task briefs (CL-4343 + CL-5203).
 *
 * Leaf stops already salvage no-progress / turn-budget / etc. This
 * module tracks how often the *parent* re-spawns the same brief so:
 * - hard-block-class salvages refuse an identical re-dispatch for the rest of
 *   the parent chat session (sticky until the fingerprint changes)
 * - turn-budget salvage flips from "raise maxTurns" to "stop" after enough
 *   same-brief dispatches without a successful complete
 *
 * Session-scoped: one ledger per createTaskTool instance (parent chat tool).
 */

import type { TaskIntent } from "./report.js";
import type { ForcedStopReason } from "./stop-policy.js";

/** Salvage classes that must not be re-dispatched with an identical brief. */
export type HardBlockSalvage =
  "no-ship" | "no-progress" | "repetition" | "never-acted" | "never-edited";

// Every forced-stop reason a leaf can report maps 1:1 onto a salvage kind
// the parent ledger cares about.
export type BriefSalvageKind = ForcedStopReason;

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
  /** Last salvage class observed for this fingerprint, if any. */
  lastSalvage?: BriefSalvageKind;
}

/**
 * After this many total dispatches of the same brief without a successful
 * complete (original + 2 re-dispatches), turn-budget salvage no longer invites
 * another re-dispatch. Successful completes reset the counter.
 */
export const TURN_BUDGET_STOP_AFTER_DISPATCHES = 3;

const HARD_BLOCK_SALVAGES = new Set<BriefSalvageKind>([
  "no-ship",
  "no-progress",
  "repetition",
  "never-acted",
  "never-edited",
]);

export function isHardBlockSalvage(kind: BriefSalvageKind): kind is HardBlockSalvage {
  return HARD_BLOCK_SALVAGES.has(kind);
}

/**
 * Classify a completed dispatch as a salvage kind the parent ledger cares
 * about, from the structured stop reason the run reported directly — never
 * by matching the report body's prose. `wasCancelled` (observed independently,
 * e.g. via the parent's own abort signal) takes precedence since a parent
 * cancel can race a run that never got to report its own reason.
 */
export function classifyBriefSalvage(input: {
  stopReason?: ForcedStopReason;
  wasCancelled: boolean;
}): BriefSalvageKind | null {
  if (input.wasCancelled) return "cancelled";
  return input.stopReason ?? null;
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
  /**
   * Pre-run gate. Returns ok with the 1-based dispatch count that will be used,
   * or a reject message for the parent tool result.
   */
  admit: (
    fingerprint: string,
  ) => { ok: true; dispatchCount: number } | { ok: false; message: string };
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
        // CL-6710: a successful complete clears the sticky hard-block too.
        // Two concurrent identical-brief dispatches can both admit; if one
        // salvages and the other succeeds, the success proves the brief is
        // re-dispatchable, so it must not leave the sibling's hard-block
        // standing for the rest of the session.
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
