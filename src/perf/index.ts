/**
 * Always-on local performance tracing: fixed-size ring, monotonic clocks,
 * privacy-sanitized tags, no network or export side effects. Memory is fixed:
 * completed spans cap at RING_CAPACITY (oldest dropped), open at
 * OPEN_SPAN_CAPACITY; snapshot() returns shallow copies so consumers cannot
 * poison internal state.
 */

import { isOpaqueId, sanitizeTags, type PerfTags } from "./sanitize.js";
import { clearActiveTurnId } from "./active-turn.js";

export {
  sanitizeTags,
  isOpaqueId,
  ALLOWED_TAG_KEYS,
  type PerfTags,
} from "./sanitize.js";

export { type FlushPerfToOtelOptions } from "./otel-sink.js";

import type { Settings } from "../config/settings.js";
import {
  flushPerfToOtel as flushPerfToOtelImpl,
  type FlushPerfToOtelOptions,
} from "./otel-sink.js";

/**
 * Snapshot the process-wide ring and POST to the operator OTLP collector when
 * export is enabled; zero network when disabled, never throws. Call on
 * session/process exit (wired from main).
 *
 * Span source: `options.spans`, then `options.getSpans`, then the ring
 * snapshot.
 */
export async function flushPerfToOtel(
  settings?: Settings | null,
  env: NodeJS.ProcessEnv = process.env,
  options: FlushPerfToOtelOptions = {},
): Promise<void> {
  const { spans, getSpans, ...rest } = options;
  await flushPerfToOtelImpl(settings, env, {
    ...rest,
    getSpans: spans !== undefined ? () => spans : (getSpans ?? snapshot),
  });
}

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

export interface PerfSpan {
  id: string;
  name: SpanName;
  parentId?: string;
  startNs: bigint;
  endNs?: bigint;
  tags?: PerfTags;
}

/** Ascending start-time order for span snapshots (stable, total on ties). */
export function compareSpanStart(a: PerfSpan, b: PerfSpan): number {
  return a.startNs < b.startNs ? -1 : a.startNs > b.startNs ? 1 : 0;
}

export interface StartOptions {
  parentId?: string;
  tags?: Record<string, unknown>;
}

/** Ring capacity for completed spans (constant, not a settings UI). */
export const RING_CAPACITY = 4096;

/**
 * Max concurrent open spans. When exceeded, the oldest is dropped so a
 * leaked start() cannot grow memory without bound.
 */
export const OPEN_SPAN_CAPACITY = 1024;

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

function ringHasId(id: string): boolean {
  if (ringCount === 0) return false;
  const startIdx = ringCount < RING_CAPACITY ? 0 : ringWrite;
  for (let i = 0; i < ringCount; i += 1) {
    const span = ring[(startIdx + i) % RING_CAPACITY];
    if (span !== undefined && span.id === id) return true;
  }
  return false;
}

/** Privacy fence for parentId: known open/ring ids or OPAQUE_ID_RE only. */
function sanitizeParentId(parentId: string | undefined): string | undefined {
  if (parentId === undefined || parentId.length === 0) return undefined;
  if (openSpans.has(parentId) || ringHasId(parentId)) return parentId;
  if (isOpaqueId(parentId)) return parentId;
  return undefined;
}

/** Shallow copy so snapshot consumers cannot mutate the ring / open map. */
function cloneSpan(span: PerfSpan): PerfSpan {
  const copy: PerfSpan = {
    id: span.id,
    name: span.name,
    startNs: span.startNs,
  };
  if (span.parentId !== undefined) copy.parentId = span.parentId;
  if (span.endNs !== undefined) copy.endNs = span.endNs;
  if (span.tags !== undefined) copy.tags = { ...span.tags };
  return copy;
}

/** Drop the oldest open span when at capacity (Map iteration is insertion order). */
function evictOldestOpenIfFull(): void {
  if (openSpans.size < OPEN_SPAN_CAPACITY) return;
  const oldest = openSpans.keys().next().value;
  if (oldest !== undefined) openSpans.delete(oldest);
}

/**
 * Open a timed span; returns an opaque id for `end`. Unknown names are
 * ignored (returns ""; end no-ops). Drops the oldest open span first when
 * at capacity.
 */
export function start(name: SpanName | string, opts?: StartOptions): string {
  if (!isSpanName(name)) return "";

  const id = allocId();
  const tags = sanitizeTags(opts?.tags);
  const parentId = sanitizeParentId(opts?.parentId);
  const span: PerfSpan = {
    id,
    name,
    startNs: nowNs(),
  };
  if (parentId !== undefined) {
    span.parentId = parentId;
  }
  if (tags !== undefined) {
    span.tags = tags;
  }
  evictOldestOpenIfFull();
  openSpans.set(id, span);
  return id;
}

/**
 * Close a span opened by `start`; merges optional end tags (sanitized).
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
    span.tags =
      span.tags === undefined ? endTags : { ...span.tags, ...endTags };
  }

  pushRing(span);
}

/**
 * Point-in-time event: a completed span with startNs === endNs. Unknown
 * names are ignored; same options shape as `start`.
 */
export function mark(name: SpanName | string, opts?: StartOptions): string {
  if (!isSpanName(name)) return "";

  const id = allocId();
  const ns = nowNs();
  const sanitized = sanitizeTags(opts?.tags);
  const parentId = sanitizeParentId(opts?.parentId);
  const span: PerfSpan = {
    id,
    name,
    startNs: ns,
    endNs: ns,
  };
  if (parentId !== undefined) {
    span.parentId = parentId;
  }
  if (sanitized !== undefined) {
    span.tags = sanitized;
  }
  pushRing(span);
  return id;
}

/**
 * Completed spans oldest-first, then still-open spans (endNs unset).
 * Shallow copies of spans and tags so callers cannot mutate internal state.
 */
export function snapshot(): PerfSpan[] {
  const completed: PerfSpan[] = [];
  if (ringCount > 0) {
    const startIdx = ringCount < RING_CAPACITY ? 0 : ringWrite;
    for (let i = 0; i < ringCount; i += 1) {
      const span = ring[(startIdx + i) % RING_CAPACITY];
      if (span !== undefined) completed.push(cloneSpan(span));
    }
  }

  if (openSpans.size === 0) return completed;

  const open = [...openSpans.values()].map(cloneSpan);
  // Stable order by start time so tests and dumps are deterministic.
  open.sort(compareSpanStart);
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
  clearActiveTurnId();
}
