// A module-level slot the top-level uncaughtException/unhandledRejection
// handler (src/index.ts) can reach even though persist is a closure local to
// the in-flight runner (TUI persistRunSnapshot or exec persist). Only ever
// consulted from the crash path and from signal handlers: a run that never
// crashes and is never signaled never has this read.
//
// Carries enough of the live run state (task, startedAt, model) that the
// crash handler can build a full RunState record itself. It must not read
// run.json back off disk to fill these in — an unbounded readFile on the
// crash path has the exact failure mode primeCrashReporting (src/crash/
// report.ts) exists to avoid for git: a stalled disk or network mount would
// block process.exit forever.
//
// Liveness has exactly one representation: presence of this handle in the
// module-level slot (see getActiveRun below). There is no separate "active"
// flag on the handle itself — a second field would just be a copy of the
// same fact, free to drift from the slot it's meant to describe.
export interface RunStateHandle {
  sessionId: string;
  cwd: string;
  task: string;
  startedAt: number;
  model?: string;
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

// Set once, by the crash handler, immediately before it writes the terminal
// "crashed" record. saveState (src/session/state.ts) reads this synchronously
// right before each queued write actually fires, so any snapshot write still
// waiting behind another one in its per-session chain sees the flag and
// no-ops instead of firing after (and clobbering) the crash write. It cannot
// stop a write whose writeFile/rename has already been dispatched to the
// kernel at the moment the flag flips — that window is one atomicWrite call
// wide, not the full remaining lifetime of the process.
let crashed = false;

export function markCrashed(): void {
  crashed = true;
}

export function isCrashed(): boolean {
  return crashed;
}

// Test-only seam: lets an integration test hold a chained write open past the
// moment markCrashed() fires, so it can deterministically prove a write still
// queued in the chain sees isCrashed() before it fires — rather than hoping
// real filesystem timing happens to interleave that way. No effect on
// production callers, which never install a gate.
let testWriteGate: Promise<void> | null = null;

export function setTestWriteGate(gate: Promise<void> | null): void {
  testWriteGate = gate;
}

export function getTestWriteGate(): Promise<void> | null {
  return testWriteGate;
}
