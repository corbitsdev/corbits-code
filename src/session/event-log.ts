import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";

import { generateSessionId } from "./index.js";
import { withResolvedDirLock } from "./session-dir-lock.js";

/**
 * Prototype for CL-9459: a single append-only session event stream (revives
 * CL-4351 for the Hub). One JSON object per line in `event-log.jsonl` inside
 * the session dir, coexisting with the segmented `turns.jsonl` writer without
 * touching the existing read path.
 *
 * Contract:
 * - Append-only: one event per line; the file is only grown by `appendFile`.
 *   A torn tail (an unterminated partial line from an interrupted append) is
 *   dropped on read and truncated before the next append so `seq` stays
 *   contiguous.
 * - Ordering: `seq` is a monotonic per-file index assigned in append order;
 *   file order equals append order.
 * - Serialization: every append runs inside `withResolvedDirLock`
 *   (`session-dir-lock.ts`), with `seq` derived from the on-disk complete
 *   line count, so concurrent writers on one dir can neither interleave lines
 *   nor duplicate seqs.
 * - Linkage: events may carry `parentId` pointing at the `id` of the event
 *   they continue.
 * - Ids: UUIDv7 via the existing `generateSessionId` pattern; a reopened
 *   writer continues an existing log from the on-disk line count.
 *
 * Flag-gated and inert by design: `settings.sessionEventLog` with env
 * override `CORBITS_SESSION_EVENT_LOG`; an explicit "off" env value (`0`,
 * `false`, `no`, `off`, empty) forces the feature off even when settings
 * enable it. Nothing in the current write/read path imports this module;
 * production would enter through `openEventStreamWriter`, which returns null
 * when the flag is off.
 */

/** On-disk name of the append-only event stream within a session dir. */
export const EVENT_LOG_FILE = "event-log.jsonl";

/** Env override for the flag (e.g. `CORBITS_SESSION_EVENT_LOG=1`). */
export const SESSION_EVENT_LOG_ENV = "CORBITS_SESSION_EVENT_LOG";

/** One event as persisted: a single JSON line in `EVENT_LOG_FILE`. */
export interface EventStreamRecord {
  /** UUIDv7 event id; linkage target for child events (`parentId`). */
  id: string;
  /** id of the parent event this one continues, when any. */
  parentId?: string;
  /** Event kind, e.g. `session.started`, `turn.done`, `turn.error`. */
  type: string;
  /** Monotonic per-file index assigned by the writer in append order. */
  seq: number;
  /** Unix ms timestamp assigned by the writer at append time. */
  ts: number;
  /** Free-form event payload. */
  payload?: unknown;
}

/** Caller-supplied fields for one appended event; seq/ts are assigned. */
export interface AppendEventInput {
  /** UUIDv7 id; generated (via `generateSessionId`) when omitted. */
  id?: string;
  parentId?: string;
  type: string;
  payload?: unknown;
}

/** The 7-method writer contract: append/flush/readFrom/latestCursor plus the
 * Phase A projections and the legacy backfill. */
export interface EventStreamWriter {
  append(event: AppendEventInput): Promise<EventStreamRecord>;
  flush(): Promise<void>;
  readFrom(cursor: number): Promise<EventStreamRecord[]>;
  latestCursor(): Promise<number>;
  projectTurns(): Promise<unknown[]>;
  projectPrompt(): Promise<string>;
  backfillFromLegacy(): Promise<number>;
}

export interface EventStreamWriterOptions {
  /** Clock override for `ts` (tests). */
  now?: () => number;
}

export interface OpenEventStreamWriterOptions extends EventStreamWriterOptions {
  /** `settings.sessionEventLog` value; defaults to undefined (off). */
  settings?: { sessionEventLog?: boolean };
  /** Env override for the flag check; defaults to `process.env`. */
  flagEnv?: Record<string, string | undefined>;
}

/** Resolve the event-log flag from `settings.sessionEventLog` with an env
 * override; an explicit "off" env value wins over settings. */
export function isSessionEventLogEnabled(
  sources: OpenEventStreamWriterOptions = {},
): boolean {
  const raw = (sources.flagEnv ?? process.env)[SESSION_EVENT_LOG_ENV];
  if (raw !== undefined) {
    const normalized = raw.trim().toLowerCase();
    return (
      normalized !== "" &&
      normalized !== "0" &&
      normalized !== "false" &&
      normalized !== "no" &&
      normalized !== "off"
    );
  }
  return sources.settings?.sessionEventLog === true;
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/** FNV-1a 32-bit hash of a legacy line; the idempotency key for backfill. */
function hashLine(line: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    hash ^= line.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Complete, non-empty lines of `raw`; an unterminated final line (a torn
 * tail) is dropped so reads never throw on it and `seq` stays contiguous. */
function completeLines(raw: string): string[] {
  if (raw.length === 0) return [];
  const split = raw.split("\n");
  if (!raw.endsWith("\n")) split.pop();
  return split.filter((line) => line.length > 0);
}

function parseRecordLine(line: string): EventStreamRecord {
  return JSON.parse(line) as EventStreamRecord;
}

async function readRawOrEmpty(filePath: string): Promise<string> {
  try {
    return await readFile(filePath, "utf8");
  } catch (err) {
    if (isENOENT(err)) return "";
    throw err;
  }
}

/** Drop a torn tail from disk so the next append starts on a fresh line;
 * no-op when the file ends with a newline (or is empty). */
async function dropTornTail(filePath: string, raw: string): Promise<string> {
  if (raw.length === 0 || raw.endsWith("\n")) return raw;
  const lastNl = raw.lastIndexOf("\n");
  await truncate(filePath, lastNl + 1);
  return raw.slice(0, lastNl + 1);
}

/** Raw append-only event stream writer (not itself flag-gated; tests and
 * `openEventStreamWriter` use this). Appends run inside
 * `withResolvedDirLock` and derive `seq` from the on-disk complete line
 * count, so every writer on a dir — including concurrent ones — serializes
 * and assigns unique contiguous seqs. */
export function createEventStreamWriter(
  dir: string,
  opts: EventStreamWriterOptions = {},
): EventStreamWriter {
  const now = opts.now ?? Date.now;
  const filePath = join(dir, EVENT_LOG_FILE);

  let dirReady: Promise<void> | null = null;
  // Appends issued by this writer; awaited by flush(). Cross-writer ordering
  // is the dir lock's job; this only tracks this writer's own in-flight work.
  let pending: Promise<unknown> = Promise.resolve();

  const ensureDir = async (): Promise<void> => {
    if (dirReady === null) {
      dirReady = mkdir(dir, { recursive: true }).then(() => undefined);
    }
    await dirReady;
  };

  // Caller must already hold the dir lock (append/backfillFromLegacy wrap it).
  const appendLocked = async (
    event: AppendEventInput,
  ): Promise<EventStreamRecord> => {
    await ensureDir();
    const raw = await readRawOrEmpty(filePath);
    const cleaned = await dropTornTail(filePath, raw);
    const seq = completeLines(cleaned).length;
    const record: EventStreamRecord = {
      id: event.id ?? generateSessionId(),
      type: event.type,
      seq,
      ts: now(),
    };
    if (event.parentId !== undefined) record.parentId = event.parentId;
    if (event.payload !== undefined) record.payload = event.payload;
    await appendFile(filePath, `${JSON.stringify(record)}\n`, "utf8");
    return record;
  };

  const append = (event: AppendEventInput): Promise<EventStreamRecord> => {
    const run = withResolvedDirLock(dir, () => appendLocked(event));
    pending = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };

  const flush = async (): Promise<void> => {
    await pending;
  };

  const readAll = async (): Promise<EventStreamRecord[]> => {
    const raw = await readRawOrEmpty(filePath);
    return completeLines(raw).map((line) => parseRecordLine(line));
  };

  const readFrom = async (cursor: number): Promise<EventStreamRecord[]> => {
    const records = await readAll();
    return records.filter((record) => record.seq > cursor);
  };

  const latestCursor = async (): Promise<number> => {
    const records = await readAll();
    const last = records[records.length - 1];
    return last === undefined ? -1 : last.seq;
  };

  const projectTurns = async (): Promise<unknown[]> => {
    const records = await readAll();
    return records
      .filter((record) => record.type.startsWith("turn."))
      .map((record) => ({ ...record, ...(record.payload as object) }));
  };

  const projectPrompt = async (): Promise<string> => {
    const records = await readAll();
    const texts: string[] = [];
    for (const record of records) {
      const payload = record.payload as { text?: unknown } | undefined;
      if (typeof payload?.text === "string" && payload.text.length > 0) {
        texts.push(payload.text);
      }
    }
    return texts.join("\n");
  };

  const backfillFromLegacy = (): Promise<number> =>
    withResolvedDirLock(dir, async () => {
      let raw: string;
      try {
        raw = await readFile(join(dir, "turns.jsonl"), "utf8");
      } catch (err) {
        if (isENOENT(err)) return 0;
        throw err;
      }
      // Idempotency: lines already backfilled (content hash present in the
      // stream) are skipped, so re-running after a partial backfill cannot
      // duplicate legacy events.
      const records = await readAll();
      const existingKeys = new Set<string>();
      for (const record of records) {
        const payload = record.payload as { legacyKey?: unknown } | undefined;
        if (typeof payload?.legacyKey === "string") {
          existingKeys.add(payload.legacyKey);
        }
      }
      let lastId = records[records.length - 1]?.id;
      let count = 0;
      for (const line of raw.split("\n")) {
        if (line.length === 0) continue;
        const key = hashLine(line);
        if (existingKeys.has(key)) continue;
        let record: unknown;
        try {
          record = JSON.parse(line);
        } catch {
          // A torn legacy line is not backfilled; the append-only log keeps
          // whatever it has already persisted.
          continue;
        }
        const event: AppendEventInput = {
          type: "turn.legacy",
          payload: { record, legacyKey: key },
        };
        if (lastId !== undefined) event.parentId = lastId;
        const appended = await appendLocked(event);
        existingKeys.add(key);
        lastId = appended.id;
        count += 1;
      }
      return count;
    });

  return {
    append,
    flush,
    readFrom,
    latestCursor,
    projectTurns,
    projectPrompt,
    backfillFromLegacy,
  };
}

/** Flag-gated entry point: returns a live writer only when the
 * `settings.sessionEventLog` / `CORBITS_SESSION_EVENT_LOG` flag is enabled,
 * otherwise null (inert — nothing is written). This is the seam the
 * segmented-writer path would call when the feature lands; today nothing
 * calls it, so the prototype cannot affect the existing read path. */
export function openEventStreamWriter(
  dir: string,
  opts: OpenEventStreamWriterOptions = {},
): EventStreamWriter | null {
  if (!isSessionEventLogEnabled(opts)) return null;
  const writerOpts: EventStreamWriterOptions = {};
  if (opts.now !== undefined) writerOpts.now = opts.now;
  return createEventStreamWriter(dir, writerOpts);
}
