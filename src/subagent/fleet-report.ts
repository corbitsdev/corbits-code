/**
 * What the orchestrator says to the operator about the fleet, unprompted.
 * Only attention the activity strip cannot keep: a lane failed or cancelled,
 * and the moment the fleet runs dry. Per-lane "done" walls are never printed —
 * they restate the strip and the parent.
 *
 * Pure and stateless per call: the caller keeps the returned watch and hands
 * it back on the next observation.
 */

import {
  agentLaneIsLive,
  agentProgress,
  clockLabel,
  DEFAULT_STALL_MS,
} from "./agent-progress.js";
import type {
  AgentLifecycleStatus,
  SubAgentSessionStatus,
} from "./session-store.js";

/** The lane fields a report is written from. `SubAgentSession` satisfies it. */
export interface FleetLane {
  readonly id: string;
  readonly description: string;
  readonly status: SubAgentSessionStatus;
  /** Same projection the progress strip uses; interrupted leftovers are not live. */
  readonly lifecycleStatus?: AgentLifecycleStatus;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly currentToolName: string | null;
  readonly currentToolPreview: string | null;
  readonly currentToolStartedAt: number | null;
  readonly report?: string;
  readonly error?: string;
  /** Machine-readable forced-stop reason (see SubAgentSession.stopReason). */
  readonly stopReason?: string;
  /** Catalog agent id (SubAgentSession.agentId); the wake message names it. */
  readonly agentId?: string;
  /** Set on nested (one-hop) dispatches; such asks never wake the root. */
  readonly parentSessionId?: string;
}

interface LaneMark {
  readonly status: SubAgentSessionStatus;
  /** Sticky once set, so a lane flapping the stall threshold does not
   * re-announce itself. */
  readonly stallReported: boolean;
}

export interface FleetWatch {
  readonly lanes: ReadonlyMap<string, LaneMark>;
  readonly running: number;
  /** False until the first observation, so a resumed fleet is not re-announced. */
  readonly seeded: boolean;
}

export function createFleetWatch(): FleetWatch {
  return { lanes: new Map(), running: 0, seeded: false };
}

/** Above this many changes per observation, lines collapse into one tally. */
const COALESCE_ABOVE = 3;

/** Enough of an outcome to judge it; past this the operator opens the lane. */
const OUTCOME_CHARS = 56;

/** One update is one row; a wrapped line doubles every update's screen cost. */
const MAX_UPDATE_CHARS = 76;

/** A lane going quiet produces no event, so it must be polled. Coarse is
 * fine: the threshold is tens of seconds and each check is a cheap diff. */
export const FLEET_STALL_POLL_MS = 5_000;

/** A parallel dispatch lands as one store change per lane; settle first
 * so one decision makes one line. */
export const FLEET_REPORT_SETTLE_MS = 400;

/** Lanes named in a digest before it starts counting instead of listing. */
const DIGEST_NAMED_LANES = 4;

function firstLine(text: string | undefined): string {
  if (text === undefined) return "";
  for (const raw of text.split("\n")) {
    // A heading says nothing actionable; the first prose line under it does.
    if (/^\s*#/.test(raw)) continue;
    const line = raw.replace(/^[>*\-\s]+/, "").trim();
    if (line.length > 0) return line;
  }
  return "";
}

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1).trimEnd()}…`;
}

function isStalled(lane: FleetLane, nowMs: number, stallMs: number): boolean {
  // Ask `agentProgress` for the one stalled definition so this report and
  // the panel agree.
  return agentProgress(lane, nowMs, stallMs)?.stalled === true;
}

/**
 * Lanes still live — the count the idle-with-fleet hold reads.
 * Same rule as the progress strip (`agentLaneIsLive`): interrupted leftovers
 * keep TUI status "running" but are not occupancy.
 */
export function liveFleetCount(lanes: readonly FleetLane[]): number {
  return lanes.filter((lane) => agentLaneIsLive(lane)).length;
}

/**
 * One parked ask_director question. Replies target the unique `sessionId`;
 * `agentId` is only the descriptive catalog identity shared by workers.
 */
export interface PendingAskWake {
  readonly sessionId: string;
  readonly agentId: string;
  readonly description: string;
  readonly question: string;
  readonly questionId: string;
}

/** Nested orchestrators own their children's questions; only root workers wake the TUI. */
export function pendingAskSnapshot(
  lanes: readonly FleetLane[],
  peekAsk: (
    sessionId: string,
  ) => { question: string; questionId: string } | undefined,
): readonly PendingAskWake[] {
  const asks: PendingAskWake[] = [];
  for (const lane of lanes) {
    if (lane.parentSessionId !== undefined || lane.status !== "running")
      continue;
    const ask = peekAsk(lane.id);
    if (ask === undefined) continue;
    asks.push({
      sessionId: lane.id,
      agentId: lane.agentId ?? lane.id,
      description: lane.description,
      question: ask.question,
      questionId: ask.questionId,
    });
  }
  return asks;
}

export const ASK_DIRECTOR_WAKE_PREFIX = "ask_director wake";

/**
 * The wake turn text: the worker's question reaching the parent, not the
 * operator being asked. The parent answers via send_input itself.
 */
export function pendingAskWakeText(
  wake: PendingAskWake,
  options?: { resurface?: number },
): string {
  const lines = [
    `${ASK_DIRECTOR_WAKE_PREFIX} — worker ${wake.agentId} (${wake.description}) parked question ${wake.questionId} while this session was not collecting:`,
    "",
    wake.question,
    "",
  ];
  // A re-surfaced question: the earlier wake was aborted without an answer.
  // Say so, or the second identical wake reads as a duplicate.
  if (options?.resurface !== undefined && options.resurface > 0) {
    lines.push(
      `Re-surface ${options.resurface}: the earlier wake turn stalled and was aborted without an answer — reconcile against the live question before replying.`,
      "",
    );
  }
  lines.push(
    `The worker — not the operator — raised this. Answer it with send_input (soft) using target ${wake.sessionId}; do not relay to the operator unless it genuinely needs them.`,
  );
  return lines.join("\n");
}

type Change =
  | { readonly kind: "dispatched"; readonly line: string }
  | { readonly kind: "done"; readonly line: string }
  | { readonly kind: "failed"; readonly line: string }
  | { readonly kind: "cancelled"; readonly line: string }
  | { readonly kind: "stalled"; readonly line: string };

export interface FleetReportOptions {
  readonly stallMs?: number;
}

export interface FleetObservation {
  readonly watch: FleetWatch;
  /** Ready-to-print lines, already coalesced. Usually empty. */
  readonly updates: readonly string[];
}

export function observeFleet(
  previous: FleetWatch,
  lanes: readonly FleetLane[],
  nowMs: number,
  options: FleetReportOptions = {},
): FleetObservation {
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const marks = new Map<string, LaneMark>();
  const changes: Change[] = [];
  let running = 0;

  for (const lane of lanes) {
    if (agentLaneIsLive(lane)) running += 1;
    const before = previous.lanes.get(lane.id);
    const stalled =
      agentLaneIsLive(lane) &&
      (before?.stallReported === true || isStalled(lane, nowMs, stallMs));
    marks.set(lane.id, { status: lane.status, stallReported: stalled });

    if (!previous.seeded) continue;

    if (before === undefined) {
      if (lane.status === "running") {
        changes.push({
          kind: "dispatched",
          line: `dispatched ${lane.description}`,
        });
      }
      continue;
    }

    if (before.status !== lane.status) {
      if (lane.status === "done") {
        // A forced stop lands as "done" with a stopReason — attention,
        // not success.
        if (lane.stopReason !== undefined) {
          changes.push({
            kind: "failed",
            line: `${lane.description} stopped — ${clip(lane.stopReason, OUTCOME_CHARS)}`,
          });
        } else {
          changes.push({ kind: "done", line: `${lane.description} done` });
        }
      } else if (lane.status === "failed") {
        changes.push({
          kind: "failed",
          line: `${lane.description} failed — ${clip(firstLine(lane.error) || "no error reported", OUTCOME_CHARS)}`,
        });
      } else if (lane.status === "cancelled") {
        changes.push({
          kind: "cancelled",
          line: `${lane.description} stopped — ${clip(lane.stopReason ?? "cancelled", OUTCOME_CHARS)}`,
        });
      }
      continue;
    }

    // Quiet lanes are not emitted — the agents-panel rollup carries the
    // count. stallReported stays tracked so the strip does not flap.
  }

  const watch: FleetWatch = { lanes: marks, running, seeded: true };
  const wentDry = running === 0 && previous.running > 0;

  // Transcript only: fail/cancel/stall while work runs, or one dry-fleet
  // tally. Never per-lane "done" walls.
  if (wentDry) {
    const summary = idleSummary(lanes);
    return {
      watch,
      updates: summary.length === 0 ? [] : [clip(summary, MAX_UPDATE_CHARS)],
    };
  }

  const attention = changes.filter(
    (c) =>
      c.kind === "failed" || c.kind === "cancelled" || c.kind === "stalled",
  );
  if (attention.length === 0) {
    return { watch, updates: [] };
  }

  const lines: string[] =
    attention.length > COALESCE_ABOVE
      ? [tally(attention)]
      : attention.map((c) => c.line);

  return {
    watch,
    updates: lines.map((line) => clip(line, MAX_UPDATE_CHARS)),
  };
}

function tally(changes: readonly Change[]): string {
  const count = (kind: Change["kind"]): number =>
    changes.filter((c) => c.kind === kind).length;
  // stalled changes are not operator-facing; tally outcomes only
  void count("stalled");
  return formatOutcomeParts(
    {
      done: count("done"),
      failed: count("failed"),
      cancelled: count("cancelled"),
    },
    { includeZeroDone: false },
  ).join(", ");
}

interface OutcomeCounts {
  done: number;
  failed: number;
  cancelled: number;
}

function outcomeCounts(lanes: readonly FleetLane[]): OutcomeCounts {
  let done = 0;
  let failed = 0;
  let cancelled = 0;
  for (const lane of lanes) {
    // Live/running lanes are not finished outcomes; cancelled workers stay
    // TUI-running too, so skip on live/running, not interrupted alone.
    if (agentLaneIsLive(lane) || lane.status === "running") continue;
    switch (lane.status) {
      case "done":
        done += 1;
        break;
      case "failed":
        failed += 1;
        break;
      case "cancelled":
        cancelled += 1;
        break;
    }
  }
  return { done, failed, cancelled };
}

function formatOutcomeParts(
  counts: OutcomeCounts,
  opts: { includeZeroDone: boolean },
): string[] {
  const parts: string[] = [];
  if (opts.includeZeroDone || counts.done > 0)
    parts.push(`${counts.done} done`);
  if (counts.failed > 0) parts.push(`${counts.failed} failed`);
  if (counts.cancelled > 0) parts.push(`${counts.cancelled} cancelled`);
  return parts;
}

function idleSummary(lanes: readonly FleetLane[]): string {
  const counts = outcomeCounts(lanes);
  return formatOutcomeParts(counts, {
    includeZeroDone: counts.failed > 0 || counts.cancelled > 0,
  }).join(", ");
}

/** The "where are we" answer on demand — the unprompted picture in one row. */
export function fleetDigest(
  lanes: readonly FleetLane[],
  nowMs: number,
  options: FleetReportOptions = {},
): string {
  const stallMs = options.stallMs ?? DEFAULT_STALL_MS;
  const running = lanes.filter((l) => agentLaneIsLive(l));
  const parts: string[] = [];
  if (running.length > 0) {
    const named = running
      .slice(0, DIGEST_NAMED_LANES)
      .map((lane) => {
        void isStalled;
        void stallMs;
        return `${lane.description} ${clockLabel(nowMs - lane.startedAt)}`;
      })
      .join(", ");
    const extra = running.length - Math.min(running.length, DIGEST_NAMED_LANES);
    parts.push(
      `${running.length} running (${named}${extra > 0 ? `, +${extra} more` : ""})`,
    );
  }
  parts.push(
    ...formatOutcomeParts(outcomeCounts(lanes), { includeZeroDone: false }),
  );
  return parts.join(" · ");
}
