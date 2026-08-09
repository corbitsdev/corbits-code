// Spawned as a subprocess by tests/integration/crash-finalize.test.ts. Mimics
// what runTUI does at startup (register the active run, write the initial
// "running" run.json) and what index.ts does at process entry (install the
// crash handlers), then throws asynchronously so it surfaces as a genuine
// uncaughtException rather than a synchronous throw the caller could catch.
import { installCrashHandlers } from "../../../src/index.js";
import { setActiveRun, setTestWriteGate } from "../../../src/session/active-run.js";
import { sessionDir } from "../../../src/session/index.js";
import { finalizeRunState, saveState } from "../../../src/session/state.js";
import { clearsActiveRun } from "../../../src/tui/runner.js";

const cwd = process.cwd();
const sessionId = process.env["CRASH_TEST_SESSION_ID"];
if (sessionId === undefined) {
  throw new Error("CRASH_TEST_SESSION_ID must be set");
}

const startedAt = Date.now();
const task = "simulated crash task";
const model = "test-provider:test-model";

await saveState(cwd, sessionId, {
  status: "running",
  turnsUsed: 3,
  task,
  startedAt,
  model,
});

// A single handle object, mutated in place on rotation below rather than
// replaced — matching runner.ts's activeRunHandle, so a rotation that (on
// buggy code) clears the module-level slot behind this object is not
// papered over by re-registering a fresh handle afterward.
const activeRunHandle = { sessionId, cwd, task, startedAt, model };
setActiveRun(activeRunHandle);
installCrashHandlers();

// Optional: mimic a session rotation (/clear, /new) before the crash. Routes
// the outgoing session's terminal "done" write through the same
// clearsActiveRun("session-rotation") dispatch writeRunSnapshot uses in
// runner.ts, so this fixture exercises the real production decision of
// whether a rotation write clears the active-run handle, rather than
// asserting the desired behavior directly. Then repoints the handle at the
// new session id, matching runner.ts reassigning activeRunHandle.sessionId
// in place rather than replacing the handle.
const rotatedSessionId = process.env["CRASH_TEST_ROTATED_SESSION_ID"];
let activeSessionId = sessionId;
if (rotatedSessionId !== undefined) {
  const rotationState = {
    status: "done" as const,
    turnsUsed: 3,
    task,
    startedAt,
    finishedAt: Date.now(),
    model,
  };
  if (clearsActiveRun("session-rotation")) {
    await finalizeRunState(cwd, sessionId, rotationState);
  } else {
    await saveState(cwd, sessionId, rotationState);
  }
  activeRunHandle.sessionId = rotatedSessionId;
  activeSessionId = rotatedSessionId;
}

process.stdout.write(`${sessionDir(cwd, activeSessionId)}\n`);

// Hold every write issued from here on at the gate, before it reaches
// isCrashed(). This makes the race deterministic instead of hoping real
// filesystem timing interleaves the right way: the two straggler writes
// below are guaranteed to still be queued, not dispatched to the kernel,
// when the crash handler flips isCrashed() — the exact scenario the guard
// exists for.
let releaseGate: () => void;
const gate = new Promise<void>((resolve) => {
  releaseGate = resolve;
});
setTestWriteGate(gate);

// Two unawaited straggler snapshot writes, chained behind each other in
// state.ts's per-session queue — what persistRunSnapshot fires on every
// turn/model-switch/MCP-connect event. Both are parked at the gate.
void saveState(cwd, activeSessionId, { status: "running", turnsUsed: 1, task, startedAt, model });
void saveState(cwd, activeSessionId, { status: "running", turnsUsed: 2, task, startedAt, model });

// Throws inside setImmediate so it surfaces as a real uncaughtException.
// Node/Bun run the exception's own uncaughtException dispatch — including
// handleFatal's synchronous markCrashed() call, which precedes its first
// await — to completion before the event loop reaches the next queued
// setImmediate callback. The second setImmediate below is therefore
// guaranteed to run after isCrashed() has flipped to true, so releasing the
// gate there always lets the two parked writes observe the flag rather than
// racing it.
setImmediate(() => {
  throw new Error("simulated crash");
});
setImmediate(() => {
  releaseGate();
});
