import { appendFile, mkdir, readFile, truncate } from "node:fs/promises";
import { join } from "node:path";

import { generateSessionId } from "./index.js";
import { withResolvedDirLock } from "./session-dir-lock.js";

export const EVENT_LOG_FILE = "event-log.jsonl";

export const SESSION_EVENT_LOG_ENV = "CORBITS_SESSION_EVENT_LOG";

export interface EventStreamRecord {
  id: string;
  parentId?: string;
  type: string;
  seq: number;
  ts: number;
  payload?: unknown;
}

export interface AppendEventInput {
  id?: string;
  parentId?: string;
  type: string;
  payload?: unknown;
}

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
  now?: () => number;
}

export interface OpenEventStreamWriterOptions extends EventStreamWriterOptions {
  settings?: { sessionEventLog?: boolean };
  flagEnv?: Record<string, string | undefined>;
}

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

function hashLine(line: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < line.length; i++) {
    hash ^= line.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

// Drop an unterminated tail so a torn append does not shift seq.
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

// Truncate the torn tail on disk so the next append cannot glue onto it.
async function dropTornTail(filePath: string, raw: string): Promise<string> {
  if (raw.length === 0 || raw.endsWith("\n")) return raw;
  const lastNl = raw.lastIndexOf("\n");
  await truncate(filePath, lastNl + 1);
  return raw.slice(0, lastNl + 1);
}

export function createEventStreamWriter(
  dir: string,
  opts: EventStreamWriterOptions = {},
): EventStreamWriter {
  const now = opts.now ?? Date.now;
  const filePath = join(dir, EVENT_LOG_FILE);

  let dirReady: Promise<void> | null = null;
  // flush() waits on this writer only; the dir lock orders concurrent writers.
  let pending: Promise<unknown> = Promise.resolve();

  const ensureDir = async (): Promise<void> => {
    if (dirReady === null) {
      dirReady = mkdir(dir, { recursive: true }).then(() => undefined);
    }
    await dirReady;
  };

  // Seq is the on-disk line count, so callers must already hold the dir lock.
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
      // Content hash, not position, so a partial re-run cannot duplicate lines.
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

export function openEventStreamWriter(
  dir: string,
  opts: OpenEventStreamWriterOptions = {},
): EventStreamWriter | null {
  if (!isSessionEventLogEnabled(opts)) return null;
  const writerOpts: EventStreamWriterOptions = {};
  if (opts.now !== undefined) writerOpts.now = opts.now;
  return createEventStreamWriter(dir, writerOpts);
}
