import fs from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

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
  dev: number;
  ino: number;
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

function isErrno(err: unknown, code: string): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    err.code === code
  );
}

interface ActiveStat {
  dev: number;
  ino: number;
  size: number;
}

function statActive(path: string): ActiveStat {
  try {
    const info = fs.statSync(path);
    return { dev: info.dev, ino: info.ino, size: info.size };
  } catch {
    return { dev: 0, ino: 0, size: 0 };
  }
}

/**
 * Another process may have rotated or replaced the active file since this
 * one remembered its size. Adopt the file on disk before deciding to rotate
 * so a stale near-cap size cannot rotate a short replacement.
 */
function adoptActive(current: FileSinkState): void {
  const onDisk = statActive(current.path);
  if (
    onDisk.dev !== current.dev ||
    onDisk.ino !== current.ino ||
    onDisk.size !== current.size
  ) {
    current.dev = onDisk.dev;
    current.ino = onDisk.ino;
    current.size = onDisk.size;
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function leftoverTarget(current: FileSinkState): string | null {
  if (!fs.existsSync(current.path)) return current.path;
  const rotated = `${current.path}.1`;
  if (!fs.existsSync(rotated)) return rotated;
  return null;
}

/**
 * A crash leaves the only copies as `*.rotating` (the active bytes) and
 * `*.rotating.aside` (the previous generation). Put both back before this
 * flush rotates, even when there is nothing queued. A finished publish that
 * died before deleting the aside can drop that aside once `.1` is present,
 * so a restarted counter cannot rename over it.
 */
function adoptLeftoverRotation(current: FileSinkState): void {
  const dir = dirname(current.path);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return;
  }
  const base = basename(current.path);
  const rotatingRe = new RegExp(
    `^${escapeRegExp(base)}\\.\\d+\\.\\d+\\.rotating$`,
  );
  const asideRe = new RegExp(
    `^${escapeRegExp(base)}\\.\\d+\\.\\d+\\.rotating\\.aside$`,
  );
  const rotatings = names.filter((name) => rotatingRe.test(name)).sort();
  for (const name of names.filter((entry) => asideRe.test(entry)).sort()) {
    const from = join(dir, name);
    const rotated = `${current.path}.1`;
    if (!fs.existsSync(rotated)) {
      try {
        fs.renameSync(from, rotated);
      } catch {
        // Leave the aside. Never delete the only copy.
      }
      continue;
    }
    const sibling = name.slice(0, -".aside".length);
    if (!rotatings.includes(sibling) && !fs.existsSync(join(dir, sibling))) {
      try {
        fs.rmSync(from);
      } catch {
        // Leave it so a later rotate cannot replace this path.
      }
    }
  }
  for (const name of rotatings) {
    const target = leftoverTarget(current);
    if (target === null) return;
    try {
      fs.renameSync(join(dir, name), target);
    } catch {
      // Leave the leftover. Never delete the only copy.
    }
  }
}

let rotateCounter = 0;

function restoreRotated(temp: string, active: string): void {
  // The temp is the only copy once the active name was renamed away. Put it
  // back when that name is free. Never truncate either path, and never delete
  // the temp if the active path is already taken.
  try {
    if (fs.existsSync(active)) return;
    fs.renameSync(temp, active);
  } catch {
    // Leave the temp in place.
  }
}

function rotateActive(current: FileSinkState): boolean {
  // Publish the active bytes under `*.rotating` first, which the next flush
  // adopts. Only then move `.1` to `*.rotating.aside` (also adopted). Never
  // rename onto an existing aside: that would replace a generation a crash
  // left behind. A thrown error puts the temp back and does not truncate.
  const temp = `${current.path}.${String(process.pid)}.${String((rotateCounter += 1))}.rotating`;
  const rotated = `${current.path}.1`;
  const aside = `${temp}.aside`;
  try {
    fs.renameSync(current.path, temp);
  } catch {
    return false;
  }
  let movedAside = false;
  try {
    if (fs.existsSync(aside)) {
      restoreRotated(temp, current.path);
      return false;
    }
    if (fs.existsSync(rotated)) {
      const info = fs.lstatSync(rotated);
      if (!info.isFile()) {
        restoreRotated(temp, current.path);
        return false;
      }
      fs.renameSync(rotated, aside);
      movedAside = true;
    }
    fs.renameSync(temp, rotated);
  } catch {
    if (movedAside && !fs.existsSync(rotated)) {
      try {
        fs.renameSync(aside, rotated);
      } catch {
        // The previous generation stays in the aside file.
      }
    }
    restoreRotated(temp, current.path);
    return false;
  }
  if (movedAside) {
    try {
      fs.rmSync(aside);
    } catch {
      // `.1` already holds the new generation. Leave the aside.
    }
  }
  current.size = 0;
  current.dev = 0;
  current.ino = 0;
  return true;
}

function shouldRotate(
  current: FileSinkState,
  lineBytes: number,
  rotatedThisFlush: boolean,
): boolean {
  if (current.size <= 0) return false;
  if (current.size + lineBytes <= current.maxBytes) return false;
  // Crossing once publishes the previous active file as `.1`. A second
  // rotation waits until that new file itself is already over the cap.
  if (rotatedThisFlush && current.size <= current.maxBytes) return false;
  return true;
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
  let rotatedThisFlush = false;
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
    if (shouldRotate(current, lineBytes, rotatedThisFlush)) {
      if (rotateActive(current)) rotatedThisFlush = true;
    }
    batch.push(line);
    batchBytes += lineBytes;
  }
  flushBatch();
  const onDisk = statActive(current.path);
  current.dev = onDisk.dev;
  current.ino = onDisk.ino;
  current.size = onDisk.size;
}

const LOCK_WAIT_MS = 1_000;
const LOCK_POLL_MS = 20;
let lockClaimCounter = 0;
let sinkLockDepth = 0;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function readLockClaim(
  lockPath: string,
):
  | { readonly status: "ok"; readonly claim: string }
  | { readonly status: "missing" }
  | { readonly status: "error" } {
  try {
    return { status: "ok", claim: fs.readFileSync(lockPath, "utf8") };
  } catch (err) {
    if (isErrno(err, "ENOENT")) return { status: "missing" };
    return { status: "error" };
  }
}

function isDeadPid(pid: number): boolean {
  // This process does not hold the lock unless a flush is on the stack.
  // The same pid then means a previous crash left the file behind.
  if (pid === process.pid) return sinkLockDepth === 0;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return isErrno(err, "ESRCH") || isErrno(err, "EINVAL");
  }
}

function isDeadClaim(lockPath: string, claim: string): boolean {
  const pid = Number(claim.split(":")[0]?.trim());
  if (!Number.isInteger(pid) || pid <= 0) {
    try {
      return Date.now() - fs.statSync(lockPath).mtimeMs > LOCK_WAIT_MS;
    } catch {
      return false;
    }
  }
  return isDeadPid(pid);
}

function reclaimDeadLock(lockPath: string, deadClaim: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(lockPath, "r");
    const buf = Buffer.alloc(256);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (buf.toString("utf8", 0, n) !== deadClaim) return;
    const fdStat = fs.fstatSync(fd);
    const pathStat = fs.statSync(lockPath);
    if (pathStat.dev !== fdStat.dev || pathStat.ino !== fdStat.ino) return;
    const grave = `${lockPath}.${String(process.pid)}.${String(lockClaimCounter)}.reclaim`;
    fs.renameSync(lockPath, grave);
    const graveStat = fs.statSync(grave);
    if (graveStat.dev !== fdStat.dev || graveStat.ino !== fdStat.ino) {
      try {
        if (!fs.existsSync(lockPath)) fs.renameSync(grave, lockPath);
      } catch {
        // Do not delete the winner's lock.
      }
      return;
    }
    fs.unlinkSync(grave);
  } catch {
    // Lost the race. Do not unlink the lock by name.
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Already closed.
      }
    }
  }
}

type SinkLock =
  | { readonly acquired: true; readonly fd: number; readonly claim: string }
  | { readonly acquired: false; readonly retry: boolean };

function acquireSinkLock(lockPath: string): SinkLock {
  const deadline = Date.now() + LOCK_WAIT_MS;
  const claim = `${String(process.pid)}:${String((lockClaimCounter += 1))}`;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx", 0o600);
      fs.writeSync(fd, claim);
      return { acquired: true, fd, claim };
    } catch (err) {
      if (!isErrno(err, "EEXIST")) return { acquired: false, retry: false };
      const read = readLockClaim(lockPath);
      if (
        read.status === "missing" ||
        (read.status === "ok" && isDeadClaim(lockPath, read.claim))
      ) {
        if (read.status === "ok") reclaimDeadLock(lockPath, read.claim);
        if (Date.now() >= deadline) return { acquired: false, retry: true };
        continue;
      }
      if (Date.now() >= deadline) return { acquired: false, retry: true };
      sleepSync(LOCK_POLL_MS);
    }
  }
}

function releaseSinkLock(
  lockPath: string,
  held: { fd: number; claim: string },
): void {
  try {
    const read = readLockClaim(lockPath);
    if (read.status === "ok" && read.claim === held.claim) {
      fs.unlinkSync(lockPath);
    }
  } catch {
    // Already gone.
  }
  try {
    fs.closeSync(held.fd);
  } catch {
    // Already closed.
  }
}

function withSinkLock(
  lockPath: string,
  body: () => void,
): "ok" | "busy" | "error" {
  if (sinkLockDepth > 0) {
    body();
    return "ok";
  }
  const held = acquireSinkLock(lockPath);
  if (!held.acquired) return held.retry ? "busy" : "error";
  sinkLockDepth += 1;
  try {
    body();
    return "ok";
  } finally {
    sinkLockDepth -= 1;
    releaseSinkLock(lockPath, held);
  }
}

function scheduleDrain(current: FileSinkState): void {
  if (current.drainScheduled || current.buffer.length === 0) return;
  current.drainScheduled = true;
  const scheduled = current;
  queueMicrotask(() => {
    if (state !== scheduled) return;
    flushFileLogSinkSync();
  });
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
  const lines = current.buffer;
  current.buffer = [];
  const outcome = withSinkLock(`${current.path}.lock`, () => {
    adoptLeftoverRotation(current);
    if (lines.length === 0) return;
    adoptActive(current);
    writeLines(current, lines);
  });
  if (outcome !== "ok") {
    current.buffer = [...lines, ...current.buffer];
    if (outcome === "busy") scheduleDrain(current);
  }
}

function enqueue(record: LogRecord): void {
  const current = state;
  if (current === null) return;
  current.buffer.push(formatRecord(record));
  scheduleDrain(current);
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
  // A busy lock puts them back and queues a retry on that state; replacing
  // state makes the retry return. Carry the lines onto the state that will
  // own them and schedule that retry.
  flushFileLogSinkSync();
  const carried = state === null ? [] : state.buffer;
  if (state !== null) {
    state.buffer = [];
    state.drainScheduled = false;
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  const requested = options?.maxBytes;
  const initial = statActive(path);
  const next: FileSinkState = {
    path,
    maxBytes:
      requested !== undefined && requested > 0 ? requested : LOG_MAX_BYTES,
    buffer: [...carried],
    size: initial.size,
    dev: initial.dev,
    ino: initial.ino,
    drainScheduled: false,
  };
  state = next;
  scheduleDrain(next);
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
