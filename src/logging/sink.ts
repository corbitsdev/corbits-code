import fs from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { configureSync } from "@intx/log";

import { SETTINGS_DIR_NAME } from "../branding.js";

// Matches LogTape's Sink shape structurally (see @logtape/logtape's
// sink.d.ts); not imported directly since only @intx/log is a declared
// dependency here. The real type is strictly wider, so if LogTape renames or
// narrows a field nothing here catches the drift — keep this in sync by hand
// if @intx/log's pinned version moves.
interface LogRecord {
  readonly category: readonly string[];
  readonly level: string;
  readonly message: readonly unknown[];
  readonly timestamp: number;
  readonly properties: Record<string, unknown>;
}

/** One generation is kept beside the active file (`corbits.log.1`). */
const LOG_MAX_BYTES = 10 * 1024 * 1024;

export function corbitsLogFilePath(home: string = homedir()): string {
  return join(home, SETTINGS_DIR_NAME, "logs", "corbits.log");
}

interface FileSinkState {
  readonly path: string;
  readonly maxBytes: number;
  buffer: string[];
  size: number;
  drainScheduled: boolean;
}

let state: FileSinkState | null = null;
let exitHookInstalled = false;

function formatRecord(record: LogRecord): string {
  return (
    JSON.stringify({
      timestamp: new Date(record.timestamp).toISOString(),
      level: record.level,
      category: record.category.join("."),
      message: record.message.join(""),
      properties: record.properties,
    }) + "\n"
  );
}

function fileSize(path: string): number {
  try {
    return fs.statSync(path).size;
  } catch {
    return 0;
  }
}

function rotateActive(current: FileSinkState): void {
  const rotated = `${current.path}.1`;
  try {
    fs.rmSync(rotated, { force: true });
    fs.renameSync(current.path, rotated);
    current.size = 0;
  } catch {
    try {
      // rename can fail (missing file, cross-device); truncating still caps growth.
      fs.truncateSync(current.path, 0);
      current.size = 0;
    } catch {
      // Keep `size` so a later flush retries instead of appending forever.
    }
  }
}

function writeBatch(
  current: FileSinkState,
  batch: string[],
  bytes: number,
): void {
  if (bytes === 0) return;
  try {
    fs.appendFileSync(current.path, batch.join(""));
    current.size += bytes;
  } catch {
    // A full disk must not paint the terminal or abort a crash exit.
  }
}

function writeLines(current: FileSinkState, lines: readonly string[]): void {
  let batch: string[] = [];
  let batchBytes = 0;
  const flushBatch = (): void => {
    writeBatch(current, batch, batchBytes);
    batch = [];
    batchBytes = 0;
  };
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line);
    if (
      batchBytes > 0 &&
      current.size + batchBytes + lineBytes > current.maxBytes
    ) {
      flushBatch();
    }
    // Rotate only once the active file already holds bytes. A single record
    // larger than the cap still lands, then the next record starts a new file.
    if (current.size > 0 && current.size + lineBytes > current.maxBytes) {
      rotateActive(current);
    }
    batch.push(line);
    batchBytes += lineBytes;
  }
  flushBatch();
}

/**
 * Writes the buffered tail. Crash and exit paths must call this: the hot
 * path only queues, and `process.exit` does not run the microtask drain.
 * Also registered on `exit` so a path that skips the explicit call still
 * keeps the tail. Buffering can still drop records if the process is killed
 * before either flush runs.
 */
export function flushFileLogSinkSync(): void {
  const current = state;
  if (current === null) return;
  current.drainScheduled = false;
  if (current.buffer.length === 0) return;
  const lines = current.buffer;
  current.buffer = [];
  writeLines(current, lines);
}

function enqueue(record: LogRecord): void {
  const current = state;
  if (current === null) return;
  current.buffer.push(formatRecord(record));
  if (current.drainScheduled) return;
  current.drainScheduled = true;
  const scheduled = current;
  queueMicrotask(() => {
    if (state !== scheduled) return;
    flushFileLogSinkSync();
  });
}

interface FileLogSinkOptions {
  /** Rotate the active file once it reaches this many bytes. */
  readonly maxBytes?: number;
}

/**
 * Routes every logger — including ones inside vendored dependencies, which
 * Corbits cannot edit — to a file instead of the console.
 *
 * `@intx/log` installs a console sink as a side effect of its first import
 * (see its `default-sink` module), so a bare `getLogger` import is enough
 * for a log call to reach stdout/stderr first. This must be the first
 * statement in `mainWithRunners`: the TUI holds the alternate screen for
 * the rest of the process, and anything landing on the real terminal
 * mid-frame corrupts it.
 *
 * Records are queued and appended in batches so a burst does not open the
 * file once per line. The active log rotates once it reaches 10 MiB.
 */
export function installFileLogSink(
  path: string = corbitsLogFilePath(),
  options?: FileLogSinkOptions,
): void {
  // A later install must not drop lines still queued for the previous path.
  flushFileLogSinkSync();
  fs.mkdirSync(dirname(path), { recursive: true });
  const requested = options?.maxBytes;
  state = {
    path,
    maxBytes:
      requested !== undefined && requested > 0 ? requested : LOG_MAX_BYTES,
    buffer: [],
    size: fileSize(path),
    drainScheduled: false,
  };
  if (!exitHookInstalled) {
    exitHookInstalled = true;
    process.on("exit", flushFileLogSinkSync);
  }
  configureSync({
    reset: true,
    sinks: {
      file: (record: LogRecord) => {
        enqueue(record);
      },
    },
    // "debug" (not "warning"): a file has no screen to corrupt, and the
    // teardown-race diagnostics (e.g. src/tui/runner.ts, src/exec/runner.ts)
    // are logger.debug calls that exist specifically to be readable here.
    // Filtering them at the sink would silently disable the diagnostics the
    // file exists to capture.
    loggers: [
      {
        category: ["logtape", "meta"],
        lowestLevel: "warning",
        sinks: ["file"],
      },
      { category: [], lowestLevel: "debug", sinks: ["file"] },
    ],
  });
}
