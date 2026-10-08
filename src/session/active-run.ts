// Module-level slot the top-level uncaughtException/unhandledRejection
// handler (src/index.ts) can reach even though persist is a closure local to
// the in-flight runner. Only read on the crash path and from signal handlers.
//
// Carries enough live run state (task, startedAt, model, turnsUsed) for the
// crash handler to build a full RunState record itself. It must not read
// run.json back off disk — an unbounded readFile on the crash path has the
// failure mode primeCrashReporting (src/crash/report.ts) avoids for git: a
// stalled disk or network mount would block process.exit forever.
//
// Liveness has one representation: presence of this handle in the module-level
// slot (see getActiveRun). No separate "active" flag on the handle — a second
// field would just copy the same fact, free to drift from the slot.
export interface RunStateHandle {
  sessionId: string;
  cwd: string;
  task: string;
  startedAt: number;
  turnsUsed: number;
  model?: string;
  // Latest execute-promoted tool names, synced per snapshot so the
  // crash/signal write carries them into run.json for the resume seed. Fold
  // prune syncs an empty list so that write cannot restore dropped schemas.
  activatedTools?: string[];
  // Last Anthropic-protocol cache write, and the run-record model that wrote
  // it. The crash path copies the stamp so a killed process can still fold
  // before the next infer. cacheWriteModel is process-local: the on-disk
  // model field is the live provider, which resume reads back as this value.
  lastCacheWriteAt?: number;
  cacheWriteModel?: string;
}

// Keep the crash/signal handle in step with every persisted snapshot so a
// terminal write never falls back to turnsUsed: 0 when the live run has
// already advanced past that.
export function syncRunStateHandle(
  handle: RunStateHandle,
  snapshot: {
    turnsUsed: number;
    task: string;
    startedAt: number;
    model?: string;
    activatedTools?: string[];
  },
): void {
  handle.turnsUsed = snapshot.turnsUsed;
  handle.task = snapshot.task;
  handle.startedAt = snapshot.startedAt;
  if (snapshot.model !== undefined) {
    handle.model = snapshot.model;
  }
  if (snapshot.activatedTools !== undefined) {
    handle.activatedTools = snapshot.activatedTools;
  }
}

let activeRun: RunStateHandle | null = null;

export function setActiveRun(handle: RunStateHandle): void {
  activeRun = handle;
}

export function clearActiveRun(): void {
  activeRun = null;
}

export function getActiveRun(): RunStateHandle | null {
  return activeRun;
}

// Set once by the crash handler, immediately before it writes the terminal
// "crashed" record. saveState (src/session/state.ts) reads this synchronously
// before each queued write fires, so a snapshot write still waiting in its
// per-session chain sees the flag and no-ops instead of firing after (and
// clobbering) the crash write. Cannot stop a write already dispatched to the
// kernel — that window is one atomicWrite call wide.
let crashed = false;

export function markCrashed(): void {
  crashed = true;
}

export function isCrashed(): boolean {
  return crashed;
}

// Test-only seam: lets an integration test hold a chained write open past
// markCrashed(), so it can deterministically prove a write still queued in
// the chain sees isCrashed() before it fires — rather than hoping filesystem
// timing interleaves that way. No effect on production callers, which never
// install a gate.
let testWriteGate: Promise<void> | null = null;
export function setTestWriteGate(gate: Promise<void> | null): void {
  testWriteGate = gate;
}

export function getTestWriteGate(): Promise<void> | null {
  return testWriteGate;
}
