/**
 * Privacy-strict local dump of a PerfSpan snapshot.
 *
 * Writes compact JSON beside session artifacts. Re-sanitizes tags and strips
 * any non-allowlisted shape so the file is safe to share offline.
 * No network.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ALLOWED_TAG_KEYS,
  type PerfSpan,
  type PerfTags,
  type SpanName,
  sanitizeTags,
} from "./index.js";
import {
  rollupByPhase,
  rollupByTurn,
  sessionTotals,
  type PhaseSummary,
  type SessionTotals,
  type TurnSummary,
} from "./rollup.js";

/** Dump schema version — bump when the on-disk shape changes incompatibly. */
export const DUMP_VERSION = 1 as const;

/** Allowlisted keys that may appear on a serialized span object. */
export const DUMP_SPAN_KEYS = [
  "id",
  "name",
  "parentId",
  "startNs",
  "endNs",
  "open",
  "tags",
] as const;

export interface DumpSpan {
  id: string;
  name: SpanName;
  parentId?: string;
  /** Absolute monotonic ns as decimal string (preserves bigint precision). */
  startNs: string;
  endNs?: string;
  /** Present and true when the span was still open at dump time. */
  open?: true;
  tags?: PerfTags;
}

export interface PerfDump {
  version: typeof DUMP_VERSION;
  sessionId: string;
  /** ISO-8601 wall clock when the dump was written (not span time). */
  writtenAt: string;
  spanCount: number;
  openCount: number;
  rollup: {
    byPhase: PhaseSummary[];
    byTurn: TurnSummary[];
    session: SessionTotals;
  };
  spans: DumpSpan[];
}

export interface DumpOptions {
  /** Directory that already holds (or will hold) session artifacts. */
  dir: string;
  /** Opaque session id — used only in the filename and dump header. */
  sessionId: string;
}

// Session ids in the product are opaque short strings; reject path traversal.
const SAFE_SESSION_ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;

const ALLOWED_TAG_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_TAG_KEYS);

function assertSafeSessionId(sessionId: string): void {
  if (!SAFE_SESSION_ID_RE.test(sessionId)) {
    throw new Error(
      `dumpSpans: sessionId must be a short opaque id (got ${JSON.stringify(sessionId)})`,
    );
  }
}

/**
 * Project a live PerfSpan onto the dump allowlist.
 * Bigints become decimal strings; tags are re-sanitized.
 */
export function serializeSpan(span: PerfSpan): DumpSpan {
  const out: DumpSpan = {
    id: span.id,
    name: span.name,
    startNs: span.startNs.toString(),
  };
  if (span.parentId !== undefined) {
    out.parentId = span.parentId;
  }
  if (span.endNs === undefined) {
    out.open = true;
  } else {
    out.endNs = span.endNs.toString();
  }
  // Defense in depth: re-run the privacy fence even if the in-memory span
  // somehow carried extra keys (e.g. test fixtures or future sinks).
  const tags = sanitizeTags(span.tags as Record<string, unknown> | undefined);
  if (tags !== undefined) {
    out.tags = tags;
  }
  return out;
}

/** Build the dump document without touching the filesystem. */
export function buildDump(
  spans: readonly PerfSpan[],
  sessionId: string,
  writtenAt: string,
): PerfDump {
  assertSafeSessionId(sessionId);
  const serialized = spans.map(serializeSpan);
  let openCount = 0;
  for (const s of serialized) {
    if (s.open === true) openCount += 1;
  }
  return {
    version: DUMP_VERSION,
    sessionId,
    writtenAt,
    spanCount: serialized.length,
    openCount,
    rollup: {
      byPhase: rollupByPhase(spans),
      byTurn: rollupByTurn(spans),
      session: sessionTotals(spans),
    },
    spans: serialized,
  };
}

/**
 * Write `perftrace-{sessionId}.json` under `opts.dir`.
 * Returns the absolute-or-relative path written.
 */
export async function dumpSpans(spans: readonly PerfSpan[], opts: DumpOptions): Promise<string> {
  assertSafeSessionId(opts.sessionId);
  const dump = buildDump(spans, opts.sessionId, new Date().toISOString());
  const filePath = join(opts.dir, `perftrace-${opts.sessionId}.json`);
  await mkdir(opts.dir, { recursive: true });
  // Compact single-line JSON keeps diffs and `jq` usage simple.
  await writeFile(filePath, `${JSON.stringify(dump)}\n`, "utf8");
  return filePath;
}

/**
 * Walk a parsed dump and return every tag key that is not allowlisted.
 * Used by the privacy fixture test; also handy for operator scripts.
 */
export function collectNonAllowlistedTagKeys(dump: PerfDump): string[] {
  const bad: string[] = [];
  for (const span of dump.spans) {
    if (span.tags === undefined) continue;
    for (const key of Object.keys(span.tags)) {
      if (!ALLOWED_TAG_KEY_SET.has(key)) bad.push(key);
    }
  }
  return bad;
}
