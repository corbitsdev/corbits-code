import { mkdir, writeFile, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";

import { type } from "arktype";
import { getLogger } from "@intx/log";

import { sessionDir } from "./index.js";
import { clearActiveRun, getTestWriteGate, isCrashed } from "./active-run.js";
import { LOG_NAMESPACE_ROOT } from "../branding.js";

const log = getLogger([LOG_NAMESPACE_ROOT, "session", "state"]);

const ConnectedMcpServerSchema = type({
  name: "string",
  toolCount: "number",
});

export type ConnectedMcpServer = typeof ConnectedMcpServerSchema.infer;

const RunStateSchema = type({
  status: "'running' | 'done' | 'failed' | 'cancelled' | 'crashed'",
  turnsUsed: "number",
  task: "string",
  startedAt: "number",
  "finishedAt?": "number",
  "error?": "string",
  // The resolved "provider:model" identity in use when this record was written.
  // Absent only for records predating this field or written outside the run
  // lifecycle (e.g. a bare rename of a session with no prior state).
  "model?": "string",
  // MCP servers connected during the session, with the tool count each
  // contributed. Empty until the first server finishes connecting.
  "mcpServers?": ConnectedMcpServerSchema.array(),
});

export type RunState = typeof RunStateSchema.infer;

function statePath(cwd: string, sessionId: string, home?: string): string {
  return join(sessionDir(cwd, sessionId, home), "run.json");
}

let tmpWriteCounter = 0;

// Write atomically: serialize to a unique temp file, then rename into place so a
// crash mid-write never leaves torn JSON. The temp name combines the pid with a
// monotonic counter so concurrent or rapid successive saves within one process
// never collide on the same temp path (pid alone is not unique per call).
export async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${(tmpWriteCounter += 1)}.tmp`;
  await writeFile(tmp, content);
  await rename(tmp, path);
}

// Concurrent saveState calls for the same session (a straggler progress
// snapshot racing a terminal finalize write) have no ordering guarantee
// between their underlying rename()s — the later call could still finish
// first and resurrect a closed run.json as "running". Chaining each session's
// writes onto the previous one forces them to apply in call order, so a
// write issued after another always lands after it regardless of how long
// either write's fs calls take. Keyed by sessionId, not path, since callers
// only ever address one file per session.
const writeChains = new Map<string, Promise<void>>();

// Checked right before a chained write actually fires (not at saveState()
// call time) so a snapshot write still queued behind another one, at the
// moment the crash handler flips this flag, sees it and no-ops instead of
// landing after (and clobbering) the crash write issued via saveCrashState.
// This cannot recall a write whose writeFile/rename has already been
// dispatched to the kernel — that residual window is one atomicWrite call
// wide (a small local JSON write), not the remaining lifetime of the process.
async function atomicWriteUnlessCrashed(path: string, content: string): Promise<void> {
  // No-op in production; lets a test hold this write open past the moment
  // isCrashed() flips, so the check below is proven rather than assumed.
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
  // Swallow the error in the chain tail (not in `write`, which still rejects
  // for this caller) so one failed save doesn't permanently wedge later
  // saves for the same session.
  const tail = write.catch(() => {});
  writeChains.set(sessionId, tail);
  // Once this is the last write for the session, drop the entry so a
  // long-lived process doesn't retain a chain per session forever.
  void tail.then(() => {
    if (writeChains.get(sessionId) === tail) writeChains.delete(sessionId);
  });
  return write;
}

// Single write path for a terminal RunState: pairs the on-disk status with
// clearing the in-memory active-run handle (active-run.ts) so the two facts
// are set together instead of at two independent call sites that could drift.
// Callers writing a non-terminal ("running") snapshot should call saveState
// directly — clearing the active-run handle on a running snapshot would be
// wrong, not merely redundant.
//
// The clear happens before the saveState await, not after: this run is
// closing out regardless of whether the write below succeeds, and a signal
// or uncaught exception landing during that await must see the handle
// already gone, or it races a second "crashed" write (src/index.ts's process
// handlers, via saveCrashState) against the terminal write in flight here.
// Clearing after the await leaves that exact window open on every terminal
// write, not only the crash path's own.
export async function finalizeRunState(
  cwd: string,
  sessionId: string,
  state: RunState,
  home?: string,
): Promise<void> {
  clearActiveRun();
  await saveState(cwd, sessionId, state, home);
}

// Crash-time terminal write. Deliberately bypasses writeChains: a hung or
// still-pending write for this session (possibly the very write mid-flight
// when the process crashed) must never be awaited here, or a queued write
// that never settles would block the crash handler's process.exit forever.
// Callers must call markCrashed() (src/session/active-run.ts) before this, so
// any snapshot write still queued behind another one in the chain steps
// aside instead of racing this write's rename().
//
// This is a second terminal write path alongside finalizeRunState, and stays
// separate on purpose: its only callers are index.ts's process-level
// uncaughtException/unhandledRejection and signal handlers, reached when a
// crash escapes runTUI's own try/catch entirely. finalizeRunState routes
// through saveState's per-session write chain so writes apply in call order;
// that chain is exactly what a crash exit cannot afford to wait on, since
// process.exit must happen deterministically and a stuck earlier write
// (possibly the one that caused the crash) would otherwise hang it.
export async function saveCrashState(
  cwd: string,
  sessionId: string,
  state: RunState,
  home?: string,
): Promise<void> {
  const path = statePath(cwd, sessionId, home);
  await atomicWrite(path, JSON.stringify(state, null, 2));
}

type ParseRunStateResult = { ok: true; state: RunState } | { ok: false; reason: string };

// Tagged so a valid RunState.error string cannot be mistaken for a parse failure.
function parseRunState(data: unknown): ParseRunStateResult {
  const result = RunStateSchema(data);
  return result instanceof type.errors
    ? { ok: false, reason: result.summary }
    : { ok: true, state: result };
}

export type LoadStateResult =
  { kind: "ok"; state: RunState } | { kind: "missing" } | { kind: "unreadable" };

export async function loadState(
  cwd: string,
  sessionId: string,
  home?: string,
): Promise<LoadStateResult> {
  const path = statePath(cwd, sessionId, home);

  try {
    const raw = await readFile(path, "utf8");
    const parsed = parseRunState(JSON.parse(raw));
    if (!parsed.ok) {
      log.warn("unreadable session state at {path}: {reason}", {
        path,
        reason: `invalid shape: ${parsed.reason}`,
      });
      return { kind: "unreadable" };
    }
    return { kind: "ok", state: parsed.state };
  } catch (err) {
    if (err instanceof SyntaxError) {
      log.warn("unreadable session state at {path}: {reason}", { path, reason: "corrupt JSON" });
      return { kind: "unreadable" };
    }
    if (
      typeof err === "object" &&
      err !== null &&
      "code" in err &&
      (err as { code?: unknown }).code === "ENOENT"
    ) {
      return { kind: "missing" };
    }
    throw err;
  }
}
