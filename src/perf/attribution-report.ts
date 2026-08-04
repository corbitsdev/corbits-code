/**
 * Offline attribution report over PerfSpan snapshots or PerfDump JSON.
 *
 * Pure functions: no I/O, no module state, no OTEL. Categories partition turn
 * wall time into exclusive buckets so shares sum to ~1 (remainder → other).
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
    /** Denominator for shares: sum of completed turn walls (open turns excluded). */
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
 * (scheduling, TUI, etc.) so shares sum to 1 when wallNs > 0.
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

    const turnDur = spanDurationNs(turn);
    const turnNs = turnDur ?? 0;
    const open = turnDur === undefined;
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

  // Session: sum completed turns only for wall denominator so open turns do not
  // inflate "other". Category ns still include open-turn children (partial data).
  const sessionBucket = emptyBucket();
  let wallNs = 0;
  let completedTurnCount = 0;
  let inferenceCount = 0;
  let permissionWaitCount = 0;

  for (const turn of turnSpans) {
    const turnDur = spanDurationNs(turn);
    if (turnDur !== undefined) {
      wallNs += turnDur;
      completedTurnCount += 1;
    }
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
  return `  ${c.category.padEnd(18)} ${pct(c.share).padStart(7)}  ${ms(c.ns).padStart(10)}${count}`;
}

/**
 * Human-readable multi-line report. Safe for terminals; no color codes.
 */
export function formatAttributionReport(report: AttributionReport): string {
  const lines: string[] = [];
  const s = report.session;

  lines.push("PerfTrace attribution report");
  lines.push("============================");
  lines.push(
    `Session wall (completed turns): ${ms(s.wallNs)}  turns=${s.turnCount} completed=${s.completedTurnCount}`,
  );
  lines.push("");
  lines.push("Exclusive phase shares (of session wall)");
  for (const c of s.categories) {
    lines.push(categoryLine(c));
  }
  lines.push("");
  lines.push("Inference split (ttft vs stream of ttft+stream)");
  lines.push(
    `  ttft                ${pct(s.inference.ttftShare).padStart(7)}  ${ms(s.inference.ttftNs).padStart(10)}`,
  );
  lines.push(
    `  stream              ${pct(s.inference.streamShare).padStart(7)}  ${ms(s.inference.streamNs).padStart(10)}`,
  );
  lines.push("");
  lines.push("Transport signal (adapter.transport / inference)");
  lines.push(
    `  transportNs         ${ms(s.transportNs).padStart(10)}  share_of_inference=${pct(s.transportShareOfInference)}`,
  );
  lines.push(
    `  tools=${s.toolCount}  subagents=${s.subagentCount}`,
  );

  if (report.turns.length > 0) {
    lines.push("");
    lines.push("Per-turn summary");
    for (const t of report.turns) {
      const open = t.open ? " OPEN" : "";
      const byCat = Object.fromEntries(
        t.categories.map((c) => [c.category, c]),
      ) as Record<AttributionCategory, CategoryShare>;
      lines.push(
        `  turn ${t.turnId}${open}  wall=${ms(t.turnNs)}  ` +
          `inf=${pct(byCat.inference.share)} tools=${pct(byCat.tools.share)} ` +
          `perm=${pct(byCat["permission.wait"].share)} sub=${pct(byCat.subagent.share)} ` +
          `other=${pct(byCat.other.share)}  ` +
          `ttft/stream=${pct(t.inference.ttftShare)}/${pct(t.inference.streamShare)}  ` +
          `tools_n=${t.toolCount} sub_n=${t.subagentCount}`,
      );
    }
  }

  lines.push("");
  return lines.join("\n");
}

/**
 * Lookup a category share from a report's session or turn categories list.
 * Convenience for tests and scripts.
 */
export function categoryShare(
  categories: readonly CategoryShare[],
  name: AttributionCategory,
): CategoryShare {
  const found = categories.find((c) => c.category === name);
  if (found === undefined) {
    throw new Error(`missing attribution category "${name}"`);
  }
  return found;
}

