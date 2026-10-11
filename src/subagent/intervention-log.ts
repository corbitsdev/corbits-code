/**
 * Intervention log: one record every time the harness decides a run is stuck.
 *
 * Threshold tuning used to be judgment calls with no data. Each record
 * carries the trigger's measured value beside its threshold, the model it
 * fired on, and run state to judge later whether the run was stuck.
 *
 * Writes are best effort and never block or throw: a diagnostic must
 * never fail a run.
 */

import { appendFile } from "node:fs/promises";
import { join } from "node:path";

import { getLogger } from "@intx/log";

import { LOG_NAMESPACE_ROOT } from "../branding.js";

export const INTERVENTION_FILE = "interventions.jsonl";

/**
 * What the harness did: `stop` ends the run, `nudge` injects text and keeps
 * running, `block` refuses a parent re-dispatch. `outcome` records what a
 * completed dispatch produced (a salvage kind or a clean complete),
 * independent of any stop/nudge/block — the log's real outcome signal, so
 * a `block` record reads alongside later `outcome` records of the same
 * brief fingerprint. `conflict` records overlap between two concurrent
 * lanes; advisory only — it never blocked the dispatch.
 */
export type InterventionClass =
  | "stop"
  | "nudge"
  | "block"
  | "outcome"
  | "conflict";

/** What a completed dispatch produced, for correlating against earlier stops. */
export interface InterventionOutcome {
  /** Salvage kind classified from the report, or "clean-complete" for none. */
  kind: string;
  /** Total dispatches of this brief fingerprint so far (including this one). */
  dispatchCount: number;
}

/** The trigger's measured value beside the threshold it crossed. */
export interface InterventionMeasurement {
  /** What was counted, e.g. "consecutiveIdentical", "silenceMs", "turns". */
  metric: string;
  value: number;
  /** The threshold the value met, when the trigger has one. */
  threshold?: number;
}

export interface InterventionRecord {
  ts: string;
  /** Stable id of the intervention, e.g. "stalled", "report-forced". */
  id: string;
  class: InterventionClass;
  /** "leaf" | "orchestrator" — which side of a dispatch fired it. */
  role: string;
  provider?: string;
  model?: string;
  /** Model family the policy resolved, e.g. "grok" | "default". */
  family?: string;
  /** spawn_agent intent when the run had one. */
  intent?: string;
  measurement?: InterventionMeasurement;
  /** Present on `class: "outcome"` records only. */
  outcome?: InterventionOutcome;
  /**
   * Run state at the moment of the decision — the raw material for judging
   * it later. `editedPaths` counts paths the run had already written when
   * the trigger fired, so a stop can be weighed against what the run
   * produced.
   */
  state?: {
    turnsCompleted?: number;
    totalToolCalls?: number;
    readCounts?: number;
    editedPaths?: number;
  };
  /** Free-form specifics, kept short (a looped window, a refused fingerprint). */
  detail?: string;
  /**
   * How many consecutive same-trigger audits this record represents, when the
   * director coalesced a burst into one flush. Absent means one.
   */
  count?: number;
}

/** Fields every record from one run shares, supplied once at construction. */
export type InterventionContext = Pick<
  InterventionRecord,
  "role" | "provider" | "model" | "family" | "intent"
>;

export type InterventionSink = (
  event: Omit<
    InterventionRecord,
    "ts" | "role" | "provider" | "model" | "family" | "intent"
  > &
    // Outcome records are written parent-side, one per completed dispatch, so
    // provider/model/family vary per call. Omitting the keys (not passing
    // undefined) leaves the sink's bound context untouched for fixed-context
    // callers.
    Partial<Pick<InterventionRecord, "provider" | "model" | "family">>,
) => void;

/** Sink that drops everything — the default, so logging is never required. */
export const NOOP_INTERVENTION_SINK: InterventionSink = () => undefined;

/**
 * Append-only sink over `<dir>/interventions.jsonl`.
 *
 * Fire-and-forget: the caller is a director decision path, and a diagnostic
 * write must not add latency or fail the run. Ordering within a run is
 * preserved by chaining each append onto the previous one.
 */
export function createInterventionLog(
  dir: string,
  context: InterventionContext,
  now: () => Date = () => new Date(),
): InterventionSink {
  const path = join(dir, INTERVENTION_FILE);
  const log = getLogger(`${LOG_NAMESPACE_ROOT}:intervention-log`);
  let tail: Promise<void> = Promise.resolve();

  return (event) => {
    const record: InterventionRecord = {
      ts: now().toISOString(),
      ...context,
      ...event,
    };
    const line = `${JSON.stringify(record)}\n`;
    tail = tail.then(
      () =>
        appendFile(path, line, "utf8").catch((err: unknown) => {
          log.debug?.(`intervention log append failed: ${String(err)}`);
        }),
      () => undefined,
    );
  };
}
