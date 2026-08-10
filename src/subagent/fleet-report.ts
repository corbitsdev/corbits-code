/**
 * What the orchestrator says to the operator about the fleet, unprompted.
 *
 * Live lanes already paint on the fleet board. Parent prose already narrates
 * phase plans. This module only emits transcript lines for attention the board
 * cannot keep: a lane failed or stalled, and the single moment the fleet runs
 * dry. Per-lane "done — summary" walls are intentionally never printed — they
 * restate the board and the parent and turn the transcript into a second
 * status log (CL-5846).
 *
 * Pure and stateless per call — the caller keeps the returned watch and hands
 * it back on the next observation. No painting, no store access.
 */

import { agentProgress, clockLabel, DEFAULT_STALL_MS } from "../tui/agent-progress.js";
import type { SubAgentSessionStatus } from "./session-store.js";

/** The lane fields a report is written from. `SubAgentSession` satisfies it. */
export type FleetLane = {
  readonly id: string;
  readonly description: string;
  readonly status: SubAgentSessionStatus;
  readonly startedAt: number;
  readonly lastActivityAt: number;
  readonly currentToolName: string | null;
  readonly currentToolPreview: string | null;
  readonly currentToolStartedAt: number | null;
  readonly report?: string;
  readonly error?: string;
};

type LaneMark = {
  readonly status: SubAgentSessionStatus;
  /**
   * Sticky once set. A lane that flaps either side of the stall threshold
   * would otherwise re-announce itself every time it went quiet, which is the
   * wall of noise this module exists to avoid.
   */
  readonly stallReported: boolean;
};

export type FleetWatch = {
  readonly lanes: ReadonlyMap<string, LaneMark>;
  readonly running: number;
  /** False until the first observation, so a resumed fleet is not re-announced. */
  readonly seeded: boolean;
};

export function createFleetWatch(): FleetWatch {
  return { lanes: new Map(), running: 0, seeded: false };
}

/**
 * Above this many changes in one observation the individual lines stop being
 * readable and start being a scroll, so they collapse into one tally. Set by
 * what a glance can take in, not by fleet size.
 */
const COALESCE_ABOVE = 3;

/** Enough of an outcome to judge it; past this the operator opens the lane. */
const OUTCOME_CHARS = 56;

/**
 * One update is one row. A line that wraps doubles the cost of every update on
 * screen, which is how a report meant to be glanced at turns into a scroll.
 */
const MAX_UPDATE_CHARS = 76;

const PREFIX = "fleet";

/**
 * A lane going quiet is the one change that produces no event, so it has to be
 * looked for. Coarse on purpose: the stall threshold is tens of seconds, and
 * the observation is a cheap diff either way.
 */
export const FLEET_STALL_POLL_MS = 5_000;

/**
 * A parallel dispatch lands as one store change per lane, so observing each
 * one on its own turns a single decision into a line per lane. Settling first
 * is what lets the tally do its job.
 */
export const FLEET_REPORT_SETTLE_MS = 400;

/** Lanes named in a digest before it starts counting instead of listing. */
const DIGEST_NAMED_LANES = 4;

function firstLine(text: string | undefined): string {
  if (text === undefined) return "";
  for (const raw of text.split("\n")) {
    // A report that opens with "## Summary" says nothing an operator can act
    // on; the first line of prose under it is the outcome they wanted.
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
  // One definition of a stalled lane lives in `agentProgress`; asking it is
  // what keeps this report and the agents panel from disagreeing on screen.
  return agentProgress(lane, nowMs, stallMs)?.stalled === true;
}

type Change =
  | { readonly kind: "dispatched"; readonly line: string }
  | { readonly kind: "done"; readonly line: string }
  | { readonly kind: "failed"; readonly line: string }
  | { readonly kind: "stalled"; readonly line: string };

export type FleetObservation = {
  readonly watch: FleetWatch;
  /** Ready-to-print lines, already coalesced. Usually empty. */
  readonly updates: readonly string[];
};

export function observeFleet(
  previous: FleetWatch,
  lanes: readonly FleetLane[],
  nowMs: number,
  stallMs: number = DEFAULT_STALL_MS,
): FleetObservation {
  const marks = new Map<string, LaneMark>();
  const changes: Change[] = [];
  let running = 0;

  for (const lane of lanes) {
    if (lane.status === "running") running += 1;
    const before = previous.lanes.get(lane.id);
    const stalled =
      lane.status === "running" &&
      (before?.stallReported === true || isStalled(lane, nowMs, stallMs));
    marks.set(lane.id, { status: lane.status, stallReported: stalled });

    if (!previous.seeded) continue;

    if (before === undefined) {
      if (lane.status === "running") {
        changes.push({ kind: "dispatched", line: `dispatched ${lane.description}` });
      }
      continue;
    }

    if (before.status !== lane.status) {
      if (lane.status === "done") {
        changes.push({ kind: "done", line: `${lane.description} done` });
      } else if (lane.status === "failed") {
        changes.push({
          kind: "failed",
          line: `${lane.description} failed — ${clip(firstLine(lane.error) || "no error reported", OUTCOME_CHARS)}`,
        });
      } else if (lane.status === "cancelled") {
        changes.push({ kind: "failed", line: `${lane.description} cancelled` });
      }
      continue;
    }

    if (lane.status === "running" && stalled && before.stallReported !== true) {
      changes.push({
        kind: "stalled",
        line: `${lane.description} stalled — quiet for ${clockLabel(nowMs - lane.lastActivityAt)}`,
      });
    }
  }

  const watch: FleetWatch = { lanes: marks, running, seeded: true };
  const wentDry = running === 0 && previous.running > 0;

  // Board owns live lanes. Parent prose owns success narratives. Transcript
  // only: fail/stall while work is still running, or one dry-fleet tally.
  // Never per-lane "done — summary" walls (CL-5846).
  if (wentDry) {
    return {
      watch,
      updates: [
        clip(`${PREFIX} · ${idleSummary(lanes)} — nothing running`, MAX_UPDATE_CHARS),
      ],
    };
  }

  const attention = changes.filter((c) => c.kind === "failed" || c.kind === "stalled");
  if (attention.length === 0) {
    return { watch, updates: [] };
  }

  const lines: string[] =
    attention.length > COALESCE_ABOVE
      ? [tally(attention)]
      : attention.map((c) => c.line);

  return {
    watch,
    updates: lines.map((line) => clip(`${PREFIX} · ${line}`, MAX_UPDATE_CHARS)),
  };
}

function tally(changes: readonly Change[]): string {
  const count = (kind: Change["kind"]): number =>
    changes.filter((c) => c.kind === kind).length;
  const parts: string[] = [];
  const done = count("done");
  const failed = count("failed");
  const stalled = count("stalled");
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (stalled > 0) parts.push(`${stalled} stalled`);
  return parts.join(", ");
}

function idleSummary(lanes: readonly FleetLane[]): string {
  const done = lanes.filter((l) => l.status === "done").length;
  const failed = lanes.filter((l) => l.status === "failed" || l.status === "cancelled").length;
  const parts = [`${done} done`];
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(", ");
}

/**
 * The answer to "where are we" on demand — the same picture the unprompted
 * lines build up to, in one row, so asking never costs an interrupt.
 */
export function fleetDigest(
  lanes: readonly FleetLane[],
  nowMs: number,
  stallMs: number = DEFAULT_STALL_MS,
): string {
  if (lanes.length === 0) return `${PREFIX} · no lanes dispatched`;
  const running = lanes.filter((l) => l.status === "running");
  const done = lanes.filter((l) => l.status === "done").length;
  const failed = lanes.filter((l) => l.status === "failed").length;
  const cancelled = lanes.filter((l) => l.status === "cancelled").length;

  const parts: string[] = [];
  if (running.length === 0) {
    parts.push("nothing running");
  } else {
    const named = running
      .slice(0, DIGEST_NAMED_LANES)
      .map((lane) => {
        const quiet = isStalled(lane, nowMs, stallMs) ? " stalled" : "";
        return `${lane.description} ${clockLabel(nowMs - lane.startedAt)}${quiet}`;
      })
      .join(", ");
    const extra = running.length - Math.min(running.length, DIGEST_NAMED_LANES);
    parts.push(
      `${running.length} running (${named}${extra > 0 ? `, +${extra} more` : ""})`,
    );
  }
  if (done > 0) parts.push(`${done} done`);
  if (failed > 0) parts.push(`${failed} failed`);
  if (cancelled > 0) parts.push(`${cancelled} cancelled`);
  return `${PREFIX} · ${parts.join(" · ")}`;
}
