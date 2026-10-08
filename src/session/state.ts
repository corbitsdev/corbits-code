import {
  mkdir,
  writeFile,
  readFile,
  rename,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import { type } from "arktype";
import { getLogger } from "@intx/log";

import { sessionDir } from "./index.js";
import { clearActiveRun, getTestWriteGate, isCrashed } from "./active-run.js";
import {
  ageStaleRunningState,
  isStaleRunningMtime,
  RUN_STALE_THRESHOLD_MS,
  RUN_TMP_SWEEP_AGE_MS,
} from "./run-liveness.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";

const log = getLogger([LOG_NAMESPACE_ROOT, "session", "state"]);

const ConnectedMcpServerSchema = type({
  name: "string",
  toolCount: "number",
});

export type ConnectedMcpServer = typeof ConnectedMcpServerSchema.infer;

const RunStateSchema = type({
  status:
    "'running' | 'done' | 'failed' | 'cancelled' | 'crashed' | 'interrupted'",
  turnsUsed: "number",
  task: "string",
  startedAt: "number",
  "finishedAt?": "number",
  "error?": "string",
  // "provider:model" in use when the record was written; absent for old
  // records or renames without prior state.
  "model?": "string",
  // MCP servers connected this session, with their tool counts; empty until
  // the first server finishes connecting.
  "mcpServers?": ConnectedMcpServerSchema.array(),
  // Tools promoted on execute; a resume re-activates them before the first
  // post-resume infer. Omitted by fold prune so a crash cannot restore
  // dropped schemas.
  "activatedTools?": "string[]",
  // Last Anthropic-protocol infer time; a later process folds when this is
  // TTL-old. Absent for other providers or records written before this field.
  "lastCacheWriteAt?": "number",
});

export type RunState = typeof RunStateSchema.infer;

function statePath(cwd: string, sessionId: string, home?: string): string {
  return join(sessionDir(cwd, sessionId, home), "run.json");
}

function isENOENT(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

let tmpWriteCounter = 0;

// Serialize to a unique temp file, then rename into place, so a crash
// mid-write never leaves torn JSON. The pid + counter temp name stops
// concurrent saves within a process from colliding.
export async function atomicWrite(
  path: string,
  content: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${(tmpWriteCounter += 1)}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

// Concurrent saveState calls for the same session have no rename() ordering
// guarantee — a straggler snapshot could land after a terminal write and
// resurrect run.json as "running". Chain each session's writes so they apply
// in call order (keyed by sessionId; callers use one file per session).
const writeChains = new Map<string, Promise<void>>();

// Checked when the chained write fires, not at saveState() time, so a queued
// snapshot sees the crash flag and no-ops instead of clobbering the
// saveCrashState write. The exposed window is one atomicWrite call, not the
// process's remaining lifetime.
async function atomicWriteUnlessCrashed(
  path: string,
  content: string,
): Promise<void> {
  // Test hook: holds this write open past the isCrashed() flip so the check
  // below is proven, not assumed.
  const gate = getTestWriteGate();
  if (gate !== null) await gate;
  if (isCrashed()) return;
  await atomicWrite(path, content);
}

export async function saveState(
  cwd: string,
  sessionId: string,
  state: RunState,
  home?: string,
): Promise<void> {
  const path = statePath(cwd, sessionId, home);
  const content = JSON.stringify(state, null, 2);
  const previous = writeChains.get(sessionId) ?? Promise.resolve();
  const write = previous.then(
    () => atomicWriteUnlessCrashed(path, content),
    () => atomicWriteUnlessCrashed(path, content),
  );
  // Swallow the error in the chain tail (write still rejects for this caller)
  // so one failed save does not wedge later saves.
  const tail = write.catch(() => undefined);
  writeChains.set(sessionId, tail);
  // Drop the entry once it is the last write, so a long-lived process does
  // not keep a chain per session.
  void tail.then(() => {
    if (writeChains.get(sessionId) === tail) writeChains.delete(sessionId);
  });
  return write;
}

// Terminal-write path: clears the in-memory active-run handle (active-run.ts)
// alongside the on-disk status so the two cannot drift. Non-terminal
// ("running") snapshots use saveState directly.
//
// Clear before the await: a crash during the write must see the handle
// already gone, or it races saveCrashState's "crashed" write (from
// src/index.ts's process handlers) against this terminal write.
export async function finalizeRunState(
  cwd: string,
  sessionId: string,
  state: RunState,
  home?: string,
): Promise<void> {
  clearActiveRun();
  await saveState(cwd, sessionId, state, home);
}

// Crash-time terminal write that bypasses writeChains: awaiting a hung queued
// write would block the crash handler's process.exit. Callers must call
// markCrashed() (src/session/active-run.ts) first so queued snapshot writes
// step aside instead of racing this rename().
//
// Second terminal path, separate on purpose: only index.ts's process-level
// uncaughtException/unhandledRejection and signal handlers reach it (a crash
// that escapes runTUI's try/catch). finalizeRunState uses the per-session
// chain; a crash exit cannot afford to wait on that chain.
export async function saveCrashState(
  cwd: string,
  sessionId: string,
  state: RunState,
  home?: string,
): Promise<void> {
  const path = statePath(cwd, sessionId, home);
  await atomicWrite(path, JSON.stringify(state, null, 2));
}

type ParseRunStateResult =
  | { ok: true; state: RunState }
  | { ok: false; reason: string };

// Tagged so a valid RunState.error string cannot look like a parse failure.
function parseRunState(data: unknown): ParseRunStateResult {
  const result = RunStateSchema(data);
  return result instanceof type.errors
    ? { ok: false, reason: result.summary }
    : { ok: true, state: result };
}

export type LoadStateResult =
  | { kind: "ok"; state: RunState }
  | { kind: "missing" }
  | { kind: "unreadable" };

export type LoadStateOptions = {
  nowMs?: number;
  staleThresholdMs?: number;
  tmpSweepAgeMs?: number;
  /** Persist an aged-out interrupted record. Default true. */
  persistAgeOut?: boolean;
};

type CandidateFile = {
  path: string;
  mtimeMs: number;
  state: RunState;
};

type InspectedRunFile =
  | { kind: "ok"; state: RunState; mtimeMs: number }
  | { kind: "unreadable"; reason: string; mtimeMs: number }
  | { kind: "missing" };

async function inspectRunStateFile(path: string): Promise<InspectedRunFile> {
  let raw: string;
  let fileStat: { mtimeMs: number };
  try {
    [raw, fileStat] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  } catch (err) {
    if (isENOENT(err)) return { kind: "missing" };
    throw err;
  }
  try {
    const parsed = parseRunState(JSON.parse(raw));
    if (!parsed.ok) {
      return {
        kind: "unreadable",
        reason: `invalid shape: ${parsed.reason}`,
        mtimeMs: fileStat.mtimeMs,
      };
    }
    return { kind: "ok", state: parsed.state, mtimeMs: fileStat.mtimeMs };
  } catch (err) {
    if (err instanceof SyntaxError) {
      return {
        kind: "unreadable",
        reason: "corrupt JSON",
        mtimeMs: fileStat.mtimeMs,
      };
    }
    throw err;
  }
}

function isRunJsonTmpName(name: string, runBase: string): boolean {
  return name.startsWith(`${runBase}.`) && name.endsWith(".tmp");
}

async function recoverPreferredRunState(
  path: string,
  sessionId: string,
  opts: {
    nowMs: number;
    tmpSweepAgeMs: number;
    staleThresholdMs: number;
  },
): Promise<
  | { kind: "ok"; state: RunState; mtimeMs: number }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string }
> {
  const dir = dirname(path);
  const runBase = basename(path);
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if (isENOENT(err)) return { kind: "missing" };
    throw err;
  }

  const primary = await inspectRunStateFile(path);

  const tmpCandidates: CandidateFile[] = [];
  for (const name of entries) {
    if (!isRunJsonTmpName(name, runBase)) continue;
    const tmpPath = join(dir, name);
    const parsed = await inspectRunStateFile(tmpPath);
    if (parsed.kind !== "ok") continue;
    tmpCandidates.push({
      path: tmpPath,
      mtimeMs: parsed.mtimeMs,
      state: parsed.state,
    });
  }

  // A newer parseable tmp wins only over a missing/unreadable/stale run.json:
  // the canonical file is the in-flight save's destination and must not be
  // overridden by tmp.
  const primaryMtime =
    primary.kind === "missing" ? Number.NEGATIVE_INFINITY : primary.mtimeMs;
  const primaryAllowsTmp =
    !writeChains.has(sessionId) &&
    (primary.kind !== "ok" ||
      isStaleRunningMtime(primaryMtime, opts.nowMs, opts.staleThresholdMs));
  let bestTmp: CandidateFile | null = null;
  if (primaryAllowsTmp) {
    for (const candidate of tmpCandidates) {
      if (candidate.mtimeMs <= primaryMtime) continue;
      if (bestTmp === null || candidate.mtimeMs > bestTmp.mtimeMs) {
        bestTmp = candidate;
      }
    }
  }

  if (bestTmp !== null) {
    try {
      await rename(bestTmp.path, path);
    } catch {
      // Another reader may have won the rename; fall through to re-read.
    }
  }

  // Sweep aged temps so in-flight atomicWrite files under the age gate survive.
  for (const name of entries) {
    if (!isRunJsonTmpName(name, runBase)) continue;
    const tmpPath = join(dir, name);
    if (bestTmp !== null && tmpPath === bestTmp.path) continue;
    try {
      const tmpStat = await stat(tmpPath);
      if (opts.nowMs - tmpStat.mtimeMs > opts.tmpSweepAgeMs) {
        await unlink(tmpPath).catch(() => undefined);
      }
    } catch {
      // Gone already.
    }
  }

  const recovered = await inspectRunStateFile(path);
  if (recovered.kind === "ok") {
    return recovered;
  }
  if (recovered.kind === "unreadable") {
    return { kind: "unreadable", reason: recovered.reason };
  }
  if (primary.kind === "unreadable") {
    return { kind: "unreadable", reason: primary.reason };
  }
  return { kind: "missing" };
}

export async function loadState(
  cwd: string,
  sessionId: string,
  home?: string,
  options: LoadStateOptions = {},
): Promise<LoadStateResult> {
  const path = statePath(cwd, sessionId, home);
  const nowMs = options.nowMs ?? Date.now();
  const tmpSweepAgeMs = options.tmpSweepAgeMs ?? RUN_TMP_SWEEP_AGE_MS;
  const staleThresholdMs = options.staleThresholdMs ?? RUN_STALE_THRESHOLD_MS;
  const persistAgeOut = options.persistAgeOut !== false;

  const recovered = await recoverPreferredRunState(path, sessionId, {
    nowMs,
    tmpSweepAgeMs,
    staleThresholdMs,
  });
  if (recovered.kind !== "ok") {
    if (recovered.kind === "unreadable") {
      log.warn("unreadable session state at {path}: {reason}", {
        path,
        reason: recovered.reason,
      });
      return { kind: "unreadable" };
    }
    return recovered;
  }

  const aged = ageStaleRunningState(recovered.state, recovered.mtimeMs, {
    nowMs,
    staleThresholdMs,
    sessionId,
  });
  if (aged.status !== recovered.state.status && persistAgeOut) {
    try {
      await saveState(cwd, sessionId, aged, home);
    } catch (err: unknown) {
      log.warn("failed to persist aged-out run state at {path}: {error}", {
        path,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return { kind: "ok", state: aged };
}
