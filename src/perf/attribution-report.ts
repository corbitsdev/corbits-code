/**
 * Offline attribution report over PerfSpan snapshots or PerfDump JSON.
 *
 * Pure functions: no I/O, no module state, no OTEL. Categories partition turn
 * wall time into exclusive buckets so shares sum to ~1 (remainder → other).
 *
 * Open (still-running) turns use an estimated wall: max completed-descendant
 * endNs − turn.startNs. That keeps mid-stall dumps usable for share %.
 */

import type { PerfSpan, SpanName } from "./index.js";
import type { DumpSpan, PerfDump } from "./dump.js";
import { DUMP_VERSION } from "./dump.js";
import { spanDurationNs } from "./rollup.js";

/** Exclusive wall-time buckets used for session / turn share %. */
export const ATTRIBUTION_CATEGORIES = [
  "inference",
  "tools",
  "permission.wait",
  "subagent",
  "other",
] as const;

export type AttributionCategory = (typeof ATTRIBUTION_CATEGORIES)[number];

/** One exclusive category and its share of a denominator wall. */
export type CategoryShare = {
  category: AttributionCategory;
  /** Total nanoseconds attributed to this category. */
  ns: number;
  /** Share of denominator wall in [0, 1]. 0 when denominator is 0. */
  share: number;
  /** Span count contributing to this category (0 for synthetic "other"). */
  count: number;
};

/** TTFT vs stream split inside inference wall (not exclusive of each other vs parent). */
export type InferenceSplit = {
  ttftNs: number;
  streamNs: number;
  /** Share of (ttft + stream). 0 when both are zero. */
  ttftShare: number;
  streamShare: number;
};

/** Per-turn exclusive attribution. */
export type TurnAttribution = {
  turnId: string;
  turnNs: number;
  open: boolean;
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
};

/** Session-level attribution report. */
export type AttributionReport = {
  session: {
    /**
     * Denominator for shares: sum of turn walls (completed turns use end−start;
     * open turns use estimated wall from max completed-descendant end).
     */
    wallNs: number;
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
};

type ExclusiveBucket = {
  inferenceNs: number;
  toolNs: number;
  permissionWaitNs: number;
  subagentNs: number;
  toolCount: number;
  subagentCount: number;
  ttftNs: number;
  streamNs: number;
  transportNs: number;
};

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

function childrenOf(spans: readonly PerfSpan[]): Map<string, PerfSpan[]> {
  const byParent = new Map<string, PerfSpan[]>();
  for (const span of spans) {
    if (span.parentId === undefined) continue;
    const list = byParent.get(span.parentId);
    if (list === undefined) {
      byParent.set(span.parentId, [span]);
    } else {
      list.push(span);
    }
  }
  return byParent;
}

function walkDescendants(
  rootId: string,
  byParent: Map<string, PerfSpan[]>,
  visit: (span: PerfSpan) => void,
): void {
  const stack = byParent.get(rootId);
  if (stack === undefined) return;
  const work: PerfSpan[] = stack.slice();
  while (work.length > 0) {
    const span = work.pop()!;
    visit(span);
    const kids = byParent.get(span.id);
    if (kids !== undefined) {
      for (const k of kids) work.push(k);
    }
  }
}

/**
 * Wall for a turn span. Completed → end−start. Open → max completed-descendant
 * end − turn.start (stall-dump estimate so shares stay meaningful mid-turn).
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

/** Accumulate exclusive + nested metrics from a descendant span. */
function accumulate(bucket: ExclusiveBucket, span: PerfSpan): void {
  const dur = spanDurationNs(span) ?? 0;
  switch (span.name as SpanName) {
    case "inference":
      bucket.inferenceNs += dur;
      break;
    case "tool":
      bucket.toolNs += dur;
      bucket.toolCount += 1;
      break;
    case "permission.wait":
      bucket.permissionWaitNs += dur;
      break;
    case "subagent":
      bucket.subagentNs += dur;
      bucket.subagentCount += 1;
      break;
    case "inference.ttft":
      bucket.ttftNs += dur;
      break;
    case "inference.stream":
      bucket.streamNs += dur;
      break;
    case "adapter.transport":
      bucket.transportNs += dur;
      break;
    default:
      break;
  }
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
 * Build exclusive category shares. `other` absorbs gaps and un-instrumented wall
 * (scheduling, TUI, etc.) so shares sum to 1 when wallNs > 0 and attributed ≤ wall.
 *
 * When attributed exceeds wall (rare parallel overlap), other is 0 and category
 * shares still use wall as denominator (sum may exceed 1 — caller can detect).
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

function countNameUnder(
  rootId: string,
  byParent: Map<string, PerfSpan[]>,
  name: SpanName,
): number {
  let n = 0;
  walkDescendants(rootId, byParent, (s) => {
    if (s.name === name) n += 1;
  });
  return n;
}

/**
 * Attribute a PerfSpan snapshot into exclusive phase shares per turn and session.
 *
 * Exclusive categories (do not nest-double-count):
 *   inference | tools | permission.wait | subagent | other
 *
 * Nested diagnostics (not exclusive):
 *   inference.ttft / inference.stream shares of inference wall
 *   adapter.transport share of inference (transport prioritization signal)
 *
 * Open turns: wall estimated from max completed-descendant end so mid-stall
 * dumps still produce usable share percentages.
 */
export function attributionFromSpans(spans: readonly PerfSpan[]): AttributionReport {
  const byParent = childrenOf(spans);
  const turnSpans = spans
    .filter((s) => s.name === "turn")
    .slice()
    .sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));

  const turns: TurnAttribution[] = turnSpans.map((turn) => {
    const bucket = emptyBucket();
    walkDescendants(turn.id, byParent, (child) => accumulate(bucket, child));

    const { wallNs: turnNs, open } = turnWallNs(turn, byParent);
    const inferenceCount = countNameUnder(turn.id, byParent, "inference");
    const permissionWaitCount = countNameUnder(turn.id, byParent, "permission.wait");

    return {
      turnId: turn.id,
      turnNs,
      open,
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

  // Session wall includes open-turn estimates so stall dumps keep shares ~1.
  // Category ns include all turn descendants (open children contribute 0 duration).
  const sessionBucket = emptyBucket();
  let wallNs = 0;
  let completedTurnCount = 0;
  let inferenceCount = 0;
  let permissionWaitCount = 0;

  for (const turn of turnSpans) {
    const { wallNs: turnNs, open } = turnWallNs(turn, byParent);
    wallNs += turnNs;
    if (!open) completedTurnCount += 1;
    walkDescendants(turn.id, byParent, (child) => {
      accumulate(sessionBucket, child);
      if (child.name === "inference") inferenceCount += 1;
      if (child.name === "permission.wait") permissionWaitCount += 1;
    });
  }

  // No turn roots (partial / orphan snapshot): fall back to flat exclusive sums
  // and use attributed total as the wall denominator.
  if (turnSpans.length === 0) {
    for (const span of spans) {
      accumulate(sessionBucket, span);
      if (span.name === "inference") inferenceCount += 1;
      if (span.name === "permission.wait") permissionWaitCount += 1;
    }
    wallNs =
      sessionBucket.inferenceNs +
      sessionBucket.toolNs +
      sessionBucket.permissionWaitNs +
      sessionBucket.subagentNs;
  }

  return {
    session: {
      wallNs,
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
  if (raw !== null && typeof raw === "object") {
    const obj = raw as Partial<PerfDump>;
    if (obj.version !== undefined && obj.version !== DUMP_VERSION) {
      // Still attempt — schema may be forward-compatible on spans[].
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
  const count =
    c.count > 0 && c.category !== "other" ? `  n=${c.count}` : "";
  return `  ${c.category.padEnd(18)} ${pct(c.share).padStart(6)}  ${ms(c.ns)}${count}`;
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
  lines.push("");
  lines.push("Exclusive phase shares (of session wall):");
  for (const c of s.categories) {
    lines.push(categoryLine(c));
  }
  lines.push("");
  lines.push(
    `Inference split: ttft=${pct(s.inference.ttftShare)} (${ms(s.inference.ttftNs)})  stream=${pct(s.inference.streamShare)} (${ms(s.inference.streamNs)})`,
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
      for (const c of t.categories) {
        lines.push(`    ${c.category.padEnd(16)} ${pct(c.share).padStart(6)}  ${ms(c.ns)}`);
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
