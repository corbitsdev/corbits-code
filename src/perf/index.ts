/**
 * Always-on local performance tracing.
 *
 * Fixed-size ring buffer, monotonic high-res clocks, privacy-sanitized tags.
 * No network, no PostHog, no export side effects.
 */

import { sanitizeTags, type PerfTags, type TransportKind } from "./sanitize.js";

export {
  sanitizeTags,
  ALLOWED_TAG_KEYS,
  type AllowedTagKey,
  type PerfTags,
  type TransportKind,
} from "./sanitize.js";

/** Core + adapter phase names. Adapters extend; they do not invent new sinks. */
export const SPAN_NAMES = [
  "session",
  "turn",
  "inference",
  "inference.ttft",
  "inference.stream",
  "tool",
  "permission.wait",
  "subagent",
  "adapter.request_build",
  "adapter.first_byte",
  "adapter.transport",
] as const;

export type SpanName = (typeof SPAN_NAMES)[number];

const SPAN_NAME_SET: ReadonlySet<string> = new Set(SPAN_NAMES);

export type PerfSpan = {
  id: string;
  name: SpanName;
  parentId?: string;
  startNs: bigint;
  endNs?: bigint;
  tags?: PerfTags;
};

export type StartOptions = {
  parentId?: string;
  tags?: Record<string, unknown>;
};

/** Fixed ring capacity — constant, not a settings UI. */
export const RING_CAPACITY = 4096;

// Module state: one process-wide ring. Tests call clear() between cases.
let nextId = 0;
const openSpans = new Map<string, PerfSpan>();
const ring: (PerfSpan | undefined)[] = new Array(RING_CAPACITY);
let ringWrite = 0;
let ringCount = 0;

function nowNs(): bigint {
  return process.hrtime.bigint();
}

function allocId(): string {
  nextId += 1;
  // Base-36 counter keeps ids short and allocation cheap (budget: microseconds).
  return nextId.toString(36);
}

function isSpanName(name: string): name is SpanName {
  return SPAN_NAME_SET.has(name);
}

function pushRing(span: PerfSpan): void {
  ring[ringWrite] = span;
  ringWrite = (ringWrite + 1) % RING_CAPACITY;
  if (ringCount < RING_CAPACITY) {
    ringCount += 1;
  }
}

/**
 * Open a timed span. Returns an opaque id for `end`.
 * Unknown span names are ignored (returns empty string; end is a no-op).
 */
export function start(name: SpanName | string, opts?: StartOptions): string {
  if (!isSpanName(name)) return "";

  const id = allocId();
  const tags = sanitizeTags(opts?.tags);
  const span: PerfSpan = {
    id,
    name,
    startNs: nowNs(),
  };
  if (opts?.parentId !== undefined && opts.parentId.length > 0) {
    span.parentId = opts.parentId;
  }
  if (tags !== undefined) {
    span.tags = tags;
  }
  openSpans.set(id, span);
  return id;
}

/**
 * Close a span opened by `start`. Merges optional end tags (sanitized).
 * Unknown or already-ended ids are ignored.
 */
export function end(id: string, tags?: Record<string, unknown>): void {
  if (id.length === 0) return;
  const span = openSpans.get(id);
  if (span === undefined) return;

  openSpans.delete(id);
  span.endNs = nowNs();

  const endTags = sanitizeTags(tags);
  if (endTags !== undefined) {
    span.tags = span.tags === undefined ? endTags : { ...span.tags, ...endTags };
  }

  pushRing(span);
}

/**
 * Point-in-time event: recorded as a completed span with startNs === endNs.
 * Unknown span names are ignored.
 */
export function mark(name: SpanName | string, tags?: Record<string, unknown>): string {
  if (!isSpanName(name)) return "";

  const id = allocId();
  const ns = nowNs();
  const sanitized = sanitizeTags(tags);
  const span: PerfSpan = {
    id,
    name,
    startNs: ns,
    endNs: ns,
  };
  if (sanitized !== undefined) {
    span.tags = sanitized;
  }
  pushRing(span);
  return id;
}

/**
 * Snapshot of completed spans in chronological order (oldest first),
 * plus any still-open spans (endNs unset) appended after completed ones.
 */
export function snapshot(): PerfSpan[] {
  const completed: PerfSpan[] = [];
  if (ringCount > 0) {
    const startIdx = ringCount < RING_CAPACITY ? 0 : ringWrite;
    for (let i = 0; i < ringCount; i += 1) {
      const span = ring[(startIdx + i) % RING_CAPACITY];
      if (span !== undefined) completed.push(span);
    }
  }

  if (openSpans.size === 0) return completed;

  const open = [...openSpans.values()];
  // Stable order by start time so tests and dumps are deterministic.
  open.sort((a, b) => (a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0));
  return completed.concat(open);
}

/** Drop all spans (open + ring). For tests only. */
export function clear(): void {
  openSpans.clear();
  for (let i = 0; i < RING_CAPACITY; i += 1) {
    ring[i] = undefined;
  }
  ringWrite = 0;
  ringCount = 0;
  nextId = 0;
}
