/**
 * Offline attribution report over PerfSpan snapshots or PerfDump JSON.
 * Pure: no I/O, no module state, no OTEL. Exclusive buckets partition turn
 * wall so shares sum to ~1 (remainder → other); a nested exclusive child
 * (tool under subagent) counts only toward the parent bucket.
 *
 * Open turns use max completed-descendant endNs − turn.startNs as wall, so
 * mid-stall dumps stay usable; openPhases marks them as incomplete so shares
 * of completed children are not read as a full stall diagnosis.
 */

import type { PerfSpan, SpanName } from "./index.js";
import { compareSpanStart } from "./index.js";
import type { DumpSpan, PerfDump } from "./dump.js";
import { DUMP_VERSION } from "./dump.js";
import {
  childrenOf,
  classifyPerfCategory,
  spanDurationNs,
  walkDescendants,
} from "./rollup.js";

/** Exclusive wall-time buckets used for session / turn share %. */
export const ATTRIBUTION_CATEGORIES = [
  "inference",
  "tools",
  "permission.wait",
  "subagent",
  "other",
] as const;

export type AttributionCategory = (typeof ATTRIBUTION_CATEGORIES)[number];

/** Span names that form the exclusive partition (not nested diagnostics). */
const EXCLUSIVE_SPAN_NAMES: ReadonlySet<string> = new Set([
  "inference",
  "tool",
  "permission.wait",
  "subagent",
]);

/** One exclusive category and its share of a denominator wall. */
export interface CategoryShare {
  category: AttributionCategory;
  /** Total nanoseconds attributed to this category. */
  ns: number;
  /** Share of denominator wall in [0, 1]. 0 when denominator is 0. */
  share: number;
  /** Span count contributing to this category (0 for synthetic "other"). */
  count: number;
}

/**
 * TTFT vs stream split. Shares use (ttft + stream) as the denominator —
 * not inference wall (gaps / un-instrumented inference time are excluded).
 */
export interface InferenceSplit {
  ttftNs: number;
  streamNs: number;
  /** Share of (ttft + stream). 0 when both are zero. */
  ttftShare: number;
  streamShare: number;
}

/** Per-turn exclusive attribution. */
export interface TurnAttribution {
  turnId: string;
  turnNs: number;
  open: boolean;
  /**
   * Still-open phase names (and the turn when open); empty for completed
   * turns. Marks mid-stall shares as incomplete.
   */
  openPhases: SpanName[];
  categories: CategoryShare[];
  inference: InferenceSplit;
  toolCount: number;
  subagentCount: number;
  /**
   * Sum of `adapter.transport` under this turn (when instrumented).
   * Compared to inference wall for the transport prioritization decision.
   */
  transportNs: number;
  /** transportNs / inferenceNs, or 0 when inference is 0. */
  transportShareOfInference: number;
}

/** Session-level attribution report. */
export interface AttributionReport {
  session: {
    /**
     * Share denominator: sum of turn walls (open turns use the estimated
     * wall, see turnWallNs).
     */
    wallNs: number;
    /** True when any turn is still open (stall / mid-dump). */
    open: boolean;
    /** Union of per-turn openPhases; empty when every turn is completed. */
    openPhases: SpanName[];
    categories: CategoryShare[];
    inference: InferenceSplit;
    toolCount: number;
    subagentCount: number;
    turnCount: number;
    completedTurnCount: number;
    transportNs: number;
    transportShareOfInference: number;
  };
  turns: TurnAttribution[];
}

interface ExclusiveBucket {
  inferenceNs: number;
  toolNs: number;
  permissionWaitNs: number;
  subagentNs: number;
  toolCount: number;
  subagentCount: number;
  ttftNs: number;
  streamNs: number;
  transportNs: number;
}

function emptyBucket(): ExclusiveBucket {
  return {
    inferenceNs: 0,
    toolNs: 0,
    permissionWaitNs: 0,
    subagentNs: 0,
    toolCount: 0,
    subagentCount: 0,
    ttftNs: 0,
    streamNs: 0,
    transportNs: 0,
  };
}

function spanById(spans: readonly PerfSpan[]): Map<string, PerfSpan> {
  const map = new Map<string, PerfSpan>();
  for (const span of spans) map.set(span.id, span);
  return map;
}

/**
 * True when any ancestor of `span` is an exclusive-category span — nested
 * exclusive children must not double-fill buckets (their wall is already in
 * the parent).
 */
function hasExclusiveAncestor(
  span: PerfSpan,
  byId: Map<string, PerfSpan>,
): boolean {
  let parentId = span.parentId;
  while (parentId !== undefined) {
    const parent = byId.get(parentId);
    if (parent === undefined) return false;
    if (EXCLUSIVE_SPAN_NAMES.has(parent.name)) return true;
    parentId = parent.parentId;
  }
  return false;
}

/**
 * Wall for a turn span: end−start when completed, else max completed-
 * descendant end − start.
 */
export function turnWallNs(
  turn: PerfSpan,
  byParent: Map<string, PerfSpan[]>,
): { wallNs: number; open: boolean } {
  const completed = spanDurationNs(turn);
  if (completed !== undefined) {
    return { wallNs: completed, open: false };
  }

  let maxEnd: bigint | undefined;
  walkDescendants(turn.id, byParent, (child) => {
    if (child.endNs === undefined) return;
    if (maxEnd === undefined || child.endNs > maxEnd) maxEnd = child.endNs;
  });
  if (maxEnd === undefined) {
    return { wallNs: 0, open: true };
  }
  const d = maxEnd - turn.startNs;
  return { wallNs: d <= 0n ? 0 : Number(d), open: true };
}

/**
 * Distinct open phase names under `rootId` (descendants only), sorted by
 * name.
 */
function openPhasesUnder(
  rootId: string,
  byParent: Map<string, PerfSpan[]>,
  includeRoot?: PerfSpan,
): SpanName[] {
  const found = new Set<SpanName>();
  if (includeRoot !== undefined && includeRoot.endNs === undefined) {
    found.add(includeRoot.name);
  }
  walkDescendants(rootId, byParent, (child) => {
    if (child.endNs === undefined) found.add(child.name);
  });
  if (found.size === 0) return [];
  return [...found].sort((a, b) => a.localeCompare(b));
}

/**
 * Accumulate metrics from a descendant span. Exclusive categories skip ns
 * when nested under another exclusive parent (no double-count); diagnostics
 * (ttft/stream/transport) and counts always accumulate.
 */
function accumulate(
  bucket: ExclusiveBucket,
  span: PerfSpan,
  skipExclusiveNs: boolean,
): void {
  const dur = spanDurationNs(span) ?? 0;
  switch (classifyPerfCategory(span.name)) {
    case "inference":
      if (!skipExclusiveNs) bucket.inferenceNs += dur;
      break;
    case "tool":
      if (!skipExclusiveNs) bucket.toolNs += dur;
      bucket.toolCount += 1;
      break;
    case "permissionWait":
      if (!skipExclusiveNs) bucket.permissionWaitNs += dur;
      break;
    case "subagent":
      if (!skipExclusiveNs) bucket.subagentNs += dur;
      bucket.subagentCount += 1;
      break;
    case "ttft":
      bucket.ttftNs += dur;
      break;
    case "stream":
      bucket.streamNs += dur;
      break;
    case "transport":
      bucket.transportNs += dur;
      break;
    default:
      break;
  }
}

function accumulateTree(
  rootId: string,
  byParent: Map<string, PerfSpan[]>,
  byId: Map<string, PerfSpan>,
  bucket: ExclusiveBucket,
): void {
  walkDescendants(rootId, byParent, (child) => {
    accumulate(bucket, child, hasExclusiveAncestor(child, byId));
  });
}

function inferenceSplit(ttftNs: number, streamNs: number): InferenceSplit {
  const split = ttftNs + streamNs;
  return {
    ttftNs,
    streamNs,
    ttftShare: split === 0 ? 0 : ttftNs / split,
    streamShare: split === 0 ? 0 : streamNs / split,
  };
}

function shareOf(ns: number, wallNs: number): number {
  return wallNs === 0 ? 0 : ns / wallNs;
}

/**
 * Build exclusive category shares; `other` absorbs gaps and un-instrumented
 * wall so shares sum to 1. When attributed exceeds wall (parallel overlap),
 * other is 0 and shares may sum > 1.
 */
function categorySharesFromBucket(
  bucket: ExclusiveBucket,
  wallNs: number,
  inferenceCount: number,
  permissionWaitCount: number,
): CategoryShare[] {
  const attributed =
    bucket.inferenceNs +
    bucket.toolNs +
    bucket.permissionWaitNs +
    bucket.subagentNs;
  const otherNs = wallNs > 0 ? Math.max(0, wallNs - attributed) : 0;

  return [
    {
      category: "inference",
      ns: bucket.inferenceNs,
      share: shareOf(bucket.inferenceNs, wallNs),
      count: inferenceCount,
    },
    {
      category: "tools",
      ns: bucket.toolNs,
      share: shareOf(bucket.toolNs, wallNs),
      count: bucket.toolCount,
    },
    {
      category: "permission.wait",
      ns: bucket.permissionWaitNs,
      share: shareOf(bucket.permissionWaitNs, wallNs),
      count: permissionWaitCount,
    },
    {
      category: "subagent",
      ns: bucket.subagentNs,
      share: shareOf(bucket.subagentNs, wallNs),
      count: bucket.subagentCount,
    },
    {
      category: "other",
      ns: otherNs,
      share: shareOf(otherNs, wallNs),
      count: 0,
    },
  ];
}

/**
 * Count top-level exclusive spans under root (not nested under another
 * exclusive parent).
 */
function countTopExclusiveUnder(
  rootId: string,
  byParent: Map<string, PerfSpan[]>,
  byId: Map<string, PerfSpan>,
  name: SpanName,
): number {
  let n = 0;
  walkDescendants(rootId, byParent, (s) => {
    if (s.name !== name) return;
    if (hasExclusiveAncestor(s, byId)) return;
    n += 1;
  });
  return n;
}

/**
 * Attribute a PerfSpan snapshot into exclusive phase shares per turn and
 * session. Exclusive children never double-count (they land in the parent
 * bucket); diagnostics roll up separately. Open turns use the estimated wall
 * and report openPhases.
 */
export function attributionFromSpans(
  spans: readonly PerfSpan[],
): AttributionReport {
  const byParent = childrenOf(spans);
  const byId = spanById(spans);
  const turnSpans = spans
    .filter((s) => s.name === "turn")
    .slice()
    .sort(compareSpanStart);

  const turns: TurnAttribution[] = turnSpans.map((turn) => {
    const bucket = emptyBucket();
    accumulateTree(turn.id, byParent, byId, bucket);

    const { wallNs: turnNs, open } = turnWallNs(turn, byParent);
    const openPhases = open ? openPhasesUnder(turn.id, byParent, turn) : [];
    const inferenceCount = countTopExclusiveUnder(
      turn.id,
      byParent,
      byId,
      "inference",
    );
    const permissionWaitCount = countTopExclusiveUnder(
      turn.id,
      byParent,
      byId,
      "permission.wait",
    );

    return {
      turnId: turn.id,
      turnNs,
      open,
      openPhases,
      categories: categorySharesFromBucket(
        bucket,
        turnNs,
        inferenceCount,
        permissionWaitCount,
      ),
      inference: inferenceSplit(bucket.ttftNs, bucket.streamNs),
      toolCount: bucket.toolCount,
      subagentCount: bucket.subagentCount,
      transportNs: bucket.transportNs,
      transportShareOfInference:
        bucket.inferenceNs === 0 ? 0 : bucket.transportNs / bucket.inferenceNs,
    };
  });

  // Session wall includes open-turn estimates so stall-dump shares keep
  // summing to ~1; open children contribute 0 ns.
  const sessionBucket = emptyBucket();
  let wallNs = 0;
  let completedTurnCount = 0;
  let inferenceCount = 0;
  let permissionWaitCount = 0;
  const sessionOpenPhases = new Set<SpanName>();

  for (const turn of turnSpans) {
    const { wallNs: turnNs, open } = turnWallNs(turn, byParent);
    wallNs += turnNs;
    if (!open) {
      completedTurnCount += 1;
    } else {
      for (const p of openPhasesUnder(turn.id, byParent, turn)) {
        sessionOpenPhases.add(p);
      }
    }
    accumulateTree(turn.id, byParent, byId, sessionBucket);
    inferenceCount += countTopExclusiveUnder(
      turn.id,
      byParent,
      byId,
      "inference",
    );
    permissionWaitCount += countTopExclusiveUnder(
      turn.id,
      byParent,
      byId,
      "permission.wait",
    );
  }

  // No turn roots (orphan snapshot): flat exclusive sums, attributed total
  // as wall.
  if (turnSpans.length === 0) {
    for (const span of spans) {
      accumulate(sessionBucket, span, hasExclusiveAncestor(span, byId));
      if (span.name === "inference" && !hasExclusiveAncestor(span, byId)) {
        inferenceCount += 1;
      }
      if (
        span.name === "permission.wait" &&
        !hasExclusiveAncestor(span, byId)
      ) {
        permissionWaitCount += 1;
      }
      if (span.endNs === undefined) sessionOpenPhases.add(span.name);
    }
    wallNs =
      sessionBucket.inferenceNs +
      sessionBucket.toolNs +
      sessionBucket.permissionWaitNs +
      sessionBucket.subagentNs;
  }

  const openPhases = [...sessionOpenPhases].sort((a, b) => a.localeCompare(b));

  return {
    session: {
      wallNs,
      open: openPhases.length > 0 || completedTurnCount < turnSpans.length,
      openPhases,
      categories: categorySharesFromBucket(
        sessionBucket,
        wallNs,
        inferenceCount,
        permissionWaitCount,
      ),
      inference: inferenceSplit(sessionBucket.ttftNs, sessionBucket.streamNs),
      toolCount: sessionBucket.toolCount,
      subagentCount: sessionBucket.subagentCount,
      turnCount: turnSpans.length,
      completedTurnCount,
      transportNs: sessionBucket.transportNs,
      transportShareOfInference:
        sessionBucket.inferenceNs === 0
          ? 0
          : sessionBucket.transportNs / sessionBucket.inferenceNs,
    },
    turns,
  };
}

/** Convert a dump span (string ns) back to an in-memory PerfSpan. */
export function deserializeDumpSpan(span: DumpSpan): PerfSpan {
  const out: PerfSpan = {
    id: span.id,
    name: span.name,
    startNs: BigInt(span.startNs),
  };
  if (span.parentId !== undefined) out.parentId = span.parentId;
  if (span.endNs !== undefined) out.endNs = BigInt(span.endNs);
  if (span.tags !== undefined) out.tags = span.tags;
  return out;
}

/**
 * Parse a JSON value as PerfDump and return live spans.
 * Accepts either a full dump document or a bare `{ spans: DumpSpan[] }` / array.
 */
export function spansFromDumpJson(raw: unknown): PerfSpan[] {
  if (Array.isArray(raw)) {
    return raw.map((s) => deserializeDumpSpan(s as DumpSpan));
  }
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj.spans)) {
      return (obj.spans as DumpSpan[]).map(deserializeDumpSpan);
    }
  }
  throw new Error(
    "attribution report: expected a PerfDump object with .spans, or a DumpSpan[] array",
  );
}

/** Attribute a parsed PerfDump (or dump-like JSON) offline. */
export function attributionFromDump(raw: unknown): AttributionReport {
  if (raw !== null && typeof raw === "object" && !Array.isArray(raw)) {
    const obj = raw as Partial<PerfDump>;
    if (obj.version !== undefined && obj.version !== DUMP_VERSION) {
      throw new Error(
        `attribution report: unsupported dump version ${String(obj.version)} (expected ${DUMP_VERSION})`,
      );
    }
  }
  return attributionFromSpans(spansFromDumpJson(raw));
}

function pct(share: number): string {
  return `${(share * 100).toFixed(1)}%`;
}

function ms(ns: number): string {
  if (ns === 0) return "0ms";
  const m = ns / 1e6;
  if (m < 0.001) return `${ns}ns`;
  if (m < 1) return `${m.toFixed(3)}ms`;
  if (m < 1000) return `${m.toFixed(1)}ms`;
  return `${(m / 1000).toFixed(2)}s`;
}

function categoryLine(c: CategoryShare): string {
  const count = c.count > 0 && c.category !== "other" ? `  n=${c.count}` : "";
  return `  ${c.category.padEnd(18)} ${pct(c.share).padStart(6)}  ${ms(c.ns)}${count}`;
}

function formatOpenPhases(phases: readonly SpanName[]): string {
  return phases.length === 0 ? "(none)" : phases.join(", ");
}

/** Human-readable multi-line report for CLI / docs. */
export function formatAttributionReport(report: AttributionReport): string {
  const lines: string[] = [];
  const s = report.session;

  lines.push("PerfTrace attribution report");
  lines.push("───────────────────────────");
  lines.push(
    `Session wall: ${ms(s.wallNs)}  turns=${s.turnCount} (completed=${s.completedTurnCount})`,
  );
  if (s.open) {
    lines.push(
      `Open (incomplete): still-running phases: ${formatOpenPhases(s.openPhases)}`,
    );
    lines.push(
      "  Exclusive shares below use completed descendants only — not a full stall diagnosis.",
    );
  }
  lines.push("");
  lines.push(
    s.open
      ? "Exclusive phase shares (of estimated session wall; incomplete while open):"
      : "Exclusive phase shares (of session wall):",
  );
  for (const c of s.categories) {
    lines.push(categoryLine(c));
  }
  lines.push("");
  lines.push(
    `Inference split (of ttft+stream): ttft=${pct(s.inference.ttftShare)} (${ms(s.inference.ttftNs)})  stream=${pct(s.inference.streamShare)} (${ms(s.inference.streamNs)})`,
  );
  if (s.transportNs > 0 || s.transportShareOfInference > 0) {
    lines.push(
      `Transport: ${ms(s.transportNs)}  (${pct(s.transportShareOfInference)} of inference)`,
    );
  }
  lines.push(`Tools: n=${s.toolCount}  Subagents: n=${s.subagentCount}`);

  if (report.turns.length > 0) {
    lines.push("");
    lines.push("Per-turn:");
    for (const t of report.turns) {
      const openTag = t.open ? " [open]" : "";
      lines.push(
        `  turn ${t.turnId}${openTag}  wall=${ms(t.turnNs)}  tools=${t.toolCount}  subagents=${t.subagentCount}`,
      );
      if (t.open) {
        lines.push(
          `    open phases: ${formatOpenPhases(t.openPhases)}  (shares incomplete)`,
        );
      }
      for (const c of t.categories) {
        lines.push(
          `    ${c.category.padEnd(16)} ${pct(c.share).padStart(6)}  ${ms(c.ns)}`,
        );
      }
    }
  }

  return lines.join("\n");
}

/** Lookup a category share row (throws if missing — categories are always complete). */
export function categoryShare(
  categories: readonly CategoryShare[],
  category: AttributionCategory,
): CategoryShare {
  const row = categories.find((c) => c.category === category);
  if (row === undefined) {
    throw new Error(`attribution report: missing category ${category}`);
  }
  return row;
}
