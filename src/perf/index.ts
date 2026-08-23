/**
 * Always-on local performance tracing.
 *
 * Fixed-size ring buffer, monotonic high-res clocks, privacy-sanitized tags.
 * No network, no PostHog, no export side effects.
 *
 * Memory policy (fixed, not settings):
 * - RING_CAPACITY completed spans (oldest completed dropped on overflow)
 * - OPEN_SPAN_CAPACITY concurrent open spans (oldest open dropped on overflow)
 * - snapshot() returns shallow copies so consumers cannot poison internal state
 */

import { isOpaqueId, sanitizeTags, type PerfTags } from "./sanitize.js";
import { clearActiveTurnId } from "./active-turn.js";

export {
  sanitizeTags,
  isOpaqueId,
  OPAQUE_ID_RE,
  ALLOWED_TAG_KEYS,
  type AllowedTagKey,
  type DecisionKind,
  type PerfTags,
  type TransportKind,
} from "./sanitize.js";

export {
  DEFAULT_OTEL_SERVICE_NAME,
  OTEL_CONFIG_INVALID,
  OTEL_ENV,
  OtelConfigError,
  isOtelConfigInvalid,
  otelConfigForDump,
  parseOtelKeyValueList,
  requireOtelExportConfig,
  resolveOtelExportConfig,
  type DisabledOtelExportConfig,
  type EnabledOtelExportConfig,
  type OtelConfigResolution,
  type OtelExportConfig,
  type OtelExportConfigDumpView,
  type OtelSettings,
} from "./otel-config.js";

export {
  buildOtlpPayload,
  flushToOtel,
  monoToUnixNano,
  newOtelTraceId,
  otelSpanId,
  otlpTracesUrl,
  tagsToOtlpAttributes,
  type FlushPerfToOtelOptions,
  type FlushToOtelOptions,
  type OtlpExportPayload,
  type OtlpKeyValue,
  type OtlpSpan,
} from "./otel-sink.js";

import type { Settings } from "../config/settings.js";
import {
  flushPerfToOtel as flushPerfToOtelImpl,
  type FlushPerfToOtelOptions,
} from "./otel-sink.js";

/**
 * Snapshot the process-wide ring and POST to the operator OTLP collector when
 * export is enabled. Zero network when disabled. Never throws.
 * Cadence: call on session/process exit (wired from main).
 */
export async function flushPerfToOtel(
  settings?: Settings | null,
  env: NodeJS.ProcessEnv = process.env,
  options: FlushPerfToOtelOptions = {},
): Promise<void> {
  const { spans, getSpans, ...rest } = options;
  if (spans !== undefined) {
    await flushPerfToOtelImpl(settings, env, { ...rest, spans });
    return;
  }
  if (getSpans !== undefined) {
    await flushPerfToOtelImpl(settings, env, { ...rest, getSpans });
    return;
  }
  await flushPerfToOtelImpl(settings, env, { ...rest, getSpans: snapshot });
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

export interface StartOptions {
  parentId?: string;
  tags?: Record<string, unknown>;
}

/** Fixed ring capacity for completed spans — constant, not a settings UI. */
export const RING_CAPACITY = 4096;

/**
 * Max concurrent open (un-ended) spans. Fixed memory: when exceeded, the
 * oldest open span is dropped so a leaked start() cannot grow without bound.
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

/**
 * Privacy fence for parentId: only opaque span ids (known open/ring ids, or
 * OPAQUE_ID_RE). Free text, paths, and long strings are stripped.
 */
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
 * Open a timed span. Returns an opaque id for `end`.
 * Unknown span names are ignored (returns empty string; end is a no-op).
 * When open capacity is full, the oldest open span is dropped first.
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
 * Close a span opened by `start`. Merges optional end tags (sanitized).
 * Unknown or already-ended ids are ignored (double-end is a no-op).
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
 * Unknown span names are ignored. Accepts the same options shape as `start`
 * (optional parentId + tags).
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
 * Snapshot of completed spans in chronological order (oldest first),
 * plus any still-open spans (endNs unset) appended after completed ones.
 *
 * Returns shallow copies of each span (and of tags) so callers cannot
 * mutate the ring buffer or open-span map through the returned objects.
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
  clearActiveTurnId();
}
