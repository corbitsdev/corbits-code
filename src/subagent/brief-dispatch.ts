/**
 * Parent-side re-dispatch bookkeeping for task briefs (CL-4343 + CL-5203).
 *
 * This module tracks how often the *parent* re-spawns the same brief so
 * salvage outcomes can be classified per-fingerprint (successful completes
 * reset the counter).
 *
 * Session-scoped: one ledger per createTaskTool instance (parent chat tool).
 */

import type { TaskIntent } from "./report.js";
import type { ForcedStopReason } from "./stop-policy.js";

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
 * Description, context, goals, report_focus, and tier are intentionally
 * omitted so cosmetic label tweaks cannot bypass the cap.
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
  /** Pre-run gate. Always admits, returning the 1-based dispatch count that will be used. */
  admit: (fingerprint: string) => { dispatchCount: number };
  /** Record the outcome of an admitted run (salvage kind or null on success). */
  recordOutcome: (fingerprint: string, salvage: BriefSalvageKind | null) => void;
  /**
   * Undo a prior admit when the run never produced a salvage or success body
   * (throw / auth fail). Prevents burning re-dispatch bookkeeping on crashes.
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
      return { dispatchCount: nextCount };
    },

    recordOutcome(fingerprint, salvage) {
      if (salvage === null) {
        // A successful complete resets the same-brief retry budget.
        byFingerprint.set(fingerprint, { dispatchCount: 0 });
        return;
      }
      const existing = byFingerprint.get(fingerprint);
      byFingerprint.set(fingerprint, { dispatchCount: existing?.dispatchCount ?? 1 });
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
